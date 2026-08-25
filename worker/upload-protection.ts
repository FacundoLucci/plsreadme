import { ensureDocTelemetrySchema } from "./doc-telemetry.ts";
import { sha256 } from "./security.ts";
import type { Env } from "./types.ts";

export type UploadMode = "normal" | "accounts-only" | "off";

const MODE_KV_KEY = "runtime:upload_mode";
const MODE_CACHE_MS = 5_000;
const NEW_ACCOUNT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const NEW_ACCOUNT_MIN_UPLOADS = 3;
const ABUSE_SUSPENSION_MS = 24 * 60 * 60 * 1000;
const ABUSE_OVERAGE_THRESHOLD = 10;

const modeCache = new WeakMap<object, { value: UploadMode; expiresAt: number }>();
const readyDatabases = new WeakSet<object>();

type UploadLimit = {
  scope: string;
  max: number;
  windowMs: number;
};

export const UPLOAD_LIMITS = {
  anonymousHour: { scope: "upload-anonymous-hour", max: 3, windowMs: 60 * 60 * 1000 },
  anonymousGlobalHour: { scope: "upload-anonymous-global-hour", max: 100, windowMs: 60 * 60 * 1000 },
  newAccountHour: { scope: "upload-new-account-hour", max: 10, windowMs: 60 * 60 * 1000 },
  newAccountDay: { scope: "upload-new-account-day", max: 25, windowMs: 24 * 60 * 60 * 1000 },
  establishedAccountHour: { scope: "upload-account-hour", max: 60, windowMs: 60 * 60 * 1000 },
  establishedAccountDay: { scope: "upload-account-day", max: 250, windowMs: 24 * 60 * 60 * 1000 },
  apiKeyMinute: { scope: "upload-api-key-minute", max: 5, windowMs: 60 * 1000 },
  siteHour: { scope: "upload-site-hour", max: 300, windowMs: 60 * 60 * 1000 },
} as const;

export class UploadProtectionError extends Error {
  code: "uploads_disabled" | "accounts_only" | "upload_rate_limited" | "site_upload_limit";
  status: 429 | 503;
  retryAfterSeconds?: number;
  count?: number;
  max?: number;

  constructor(input: {
    message: string;
    code: UploadProtectionError["code"];
    status: UploadProtectionError["status"];
    retryAfterSeconds?: number;
    count?: number;
    max?: number;
  }) {
    super(input.message);
    this.name = "UploadProtectionError";
    this.code = input.code;
    this.status = input.status;
    this.retryAfterSeconds = input.retryAfterSeconds;
    this.count = input.count;
    this.max = input.max;
  }
}

function normalizeMode(value: string | null | undefined): UploadMode | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "normal" || normalized === "accounts-only" || normalized === "off") {
    return normalized;
  }
  return null;
}

export async function resolveUploadMode(env: Env): Promise<UploadMode> {
  if (env.UPLOADS_DISABLED === "true") return "off";

  const now = Date.now();
  const cachedMode = modeCache.get(env as object);
  if (cachedMode && cachedMode.expiresAt > now) return cachedMode.value;

  let mode = normalizeMode(env.UPLOAD_MODE) ?? "normal";
  if (env.OAUTH_KV) {
    try {
      mode = normalizeMode(await env.OAUTH_KV.get(MODE_KV_KEY)) ?? mode;
    } catch (error) {
      console.error("Upload mode KV read failed", error);
    }
  }

  modeCache.set(env as object, { value: mode, expiresAt: now + MODE_CACHE_MS });
  return mode;
}

async function ensureSchema(env: Env): Promise<void> {
  if (readyDatabases.has(env.DB as object)) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS upload_rate_buckets (
      scope TEXT NOT NULL,
      actor_key TEXT NOT NULL,
      window_start TEXT NOT NULL,
      count INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (scope, actor_key, window_start)
    )`
  ).run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS upload_account_controls (
      user_id TEXT PRIMARY KEY,
      suspended_until TEXT,
      reason TEXT,
      updated_at TEXT NOT NULL
    )`
  ).run();
  readyDatabases.add(env.DB as object);
}

function windowStartIso(now: number, windowMs: number): string {
  return new Date(Math.floor(now / windowMs) * windowMs).toISOString();
}

async function consumeLimit(env: Env, actorKey: string, limit: UploadLimit): Promise<void> {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const bucket = windowStartIso(now, limit.windowMs);
  const result = await env.DB.prepare(
    `INSERT INTO upload_rate_buckets (scope, actor_key, window_start, count, updated_at)
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(scope, actor_key, window_start)
     DO UPDATE SET count = count + 1, updated_at = excluded.updated_at
     RETURNING count`
  )
    .bind(limit.scope, actorKey, bucket, nowIso)
    .first<{ count: number }>();

  const count = Number(result?.count ?? 1);
  if (count > limit.max) {
    throw new UploadProtectionError({
      message: `Upload limit reached. Maximum ${limit.max} in this time window.`,
      code: limit.scope.includes("site") || limit.scope.includes("global")
        ? "site_upload_limit"
        : "upload_rate_limited",
      status: limit.scope.includes("site") || limit.scope.includes("global") ? 503 : 429,
      retryAfterSeconds: Math.ceil(limit.windowMs / 1000),
      count,
      max: limit.max,
    });
  }
}

async function isEstablishedAccount(env: Env, userId: string): Promise<boolean> {
  await ensureDocTelemetrySchema(env);
  const stats = await env.DB.prepare(
    "SELECT MIN(created_at) AS first_seen, COUNT(*) AS uploads FROM doc_create_events WHERE actor_user_id = ?"
  )
    .bind(userId)
    .first<{ first_seen: string | null; uploads: number | string }>();

  const uploads = Number(stats?.uploads ?? 0);
  const firstSeen = stats?.first_seen ? Date.parse(stats.first_seen) : NaN;
  return uploads >= NEW_ACCOUNT_MIN_UPLOADS && Number.isFinite(firstSeen) &&
    Date.now() - firstSeen >= NEW_ACCOUNT_AGE_MS;
}

async function enforceAccountSuspension(env: Env, userId: string): Promise<void> {
  const control = await env.DB.prepare(
    "SELECT suspended_until FROM upload_account_controls WHERE user_id = ?"
  ).bind(userId).first<{ suspended_until: string | null }>();
  const suspendedUntil = control?.suspended_until ? Date.parse(control.suspended_until) : NaN;
  if (Number.isFinite(suspendedUntil) && suspendedUntil > Date.now()) {
    throw new UploadProtectionError({
      message: "Uploads for this account are temporarily suspended after repeated rate-limit abuse.",
      code: "upload_rate_limited",
      status: 429,
      retryAfterSeconds: Math.ceil((suspendedUntil - Date.now()) / 1000),
    });
  }
}

async function suspendAccountAfterRepeatedAbuse(
  env: Env,
  userId: string,
  error: UploadProtectionError
): Promise<void> {
  if (!error.count || !error.max || error.count < error.max + ABUSE_OVERAGE_THRESHOLD) return;

  const now = new Date();
  const suspendedUntil = new Date(now.getTime() + ABUSE_SUSPENSION_MS).toISOString();
  await env.DB.prepare(
    `INSERT INTO upload_account_controls (user_id, suspended_until, reason, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       suspended_until = excluded.suspended_until,
       reason = excluded.reason,
       updated_at = excluded.updated_at`
  ).bind(userId, suspendedUntil, "repeated_upload_rate_limit_abuse", now.toISOString()).run();

  try {
    await env.DB.prepare(
      "UPDATE mcp_api_keys SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL"
    ).bind(now.toISOString(), userId).run();
  } catch (revokeError) {
    console.error("Could not revoke API keys for suspended upload account", revokeError);
  }
}

export async function enforceUploadProtection(
  env: Env,
  input: { userId?: string | null; apiKeyId?: string | null; anonymousActorKey?: string | null }
): Promise<void> {
  const mode = await resolveUploadMode(env);
  const userId = input.userId?.trim() || null;

  if (mode === "off") {
    throw new UploadProtectionError({
      message: "New uploads are temporarily paused.",
      code: "uploads_disabled",
      status: 503,
    });
  }
  if (mode === "accounts-only" && !userId) {
    throw new UploadProtectionError({
      message: "Anonymous uploads are temporarily paused. Sign in to continue.",
      code: "accounts_only",
      status: 503,
    });
  }

  if (env.UPLOAD_PROTECTION_ENABLED !== "true") return;
  await ensureSchema(env);

  if (userId) {
    await enforceAccountSuspension(env, userId);
    const accountKey = `account:${await sha256(userId)}`;
    const established = await isEstablishedAccount(env, userId);
    try {
      await consumeLimit(env, accountKey, established ? UPLOAD_LIMITS.establishedAccountHour : UPLOAD_LIMITS.newAccountHour);
      await consumeLimit(env, accountKey, established ? UPLOAD_LIMITS.establishedAccountDay : UPLOAD_LIMITS.newAccountDay);

      if (input.apiKeyId) {
        await consumeLimit(env, `api-key:${input.apiKeyId}`, UPLOAD_LIMITS.apiKeyMinute);
      }
    } catch (error) {
      if (error instanceof UploadProtectionError) {
        await suspendAccountAfterRepeatedAbuse(env, userId, error);
      }
      throw error;
    }
  } else {
    const actorKey = input.anonymousActorKey || "anonymous:unknown";
    await consumeLimit(env, actorKey, UPLOAD_LIMITS.anonymousHour);
    await consumeLimit(env, "anonymous:global", UPLOAD_LIMITS.anonymousGlobalHour);
  }

  await consumeLimit(env, "site:global", UPLOAD_LIMITS.siteHour);
}

export function uploadProtectionErrorPayload(error: UploadProtectionError) {
  return {
    error: error.message,
    code: error.code,
    retry_after_seconds: error.retryAfterSeconds,
  };
}
