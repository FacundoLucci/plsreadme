import type { Env } from "./types";

export const MAX_PAYLOAD_BYTES = 256 * 1024;
export const MAX_TOTAL_CHARS = 220_000;
export const MAX_SINGLE_LINE_CHARS = 16_384;
export const DEMO_GRANT_COOKIE_NAME = "plsreadme_demo_grant";
export const DEMO_GRANT_TTL_MS = 10 * 60 * 1000;

const DEFAULT_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

export const WRITE_RATE_LIMITS = {
  convert: {
    endpointKey: "convert",
    maxRequests: 10,
    windowMs: DEFAULT_RATE_LIMIT_WINDOW_MS,
  },
  createLink: {
    endpointKey: "create-link",
    maxRequests: 30,
    windowMs: DEFAULT_RATE_LIMIT_WINDOW_MS,
  },
  renderCreate: {
    endpointKey: "render-create",
    maxRequests: 30,
    windowMs: DEFAULT_RATE_LIMIT_WINDOW_MS,
  },
  createLinkAnonymous: {
    endpointKey: "create-link-anonymous",
    maxRequests: 12,
    windowMs: DEFAULT_RATE_LIMIT_WINDOW_MS,
  },
  createLinkAuthenticated: {
    endpointKey: "create-link-authenticated",
    maxRequests: 60,
    windowMs: DEFAULT_RATE_LIMIT_WINDOW_MS,
  },
  demoGrant: {
    endpointKey: "demo-grant",
    maxRequests: 40,
    windowMs: DEFAULT_RATE_LIMIT_WINDOW_MS,
  },
  renderUpdate: {
    endpointKey: "render-update",
    maxRequests: 60,
    windowMs: DEFAULT_RATE_LIMIT_WINDOW_MS,
  },
  renderRestore: {
    endpointKey: "render-restore",
    maxRequests: 60,
    windowMs: DEFAULT_RATE_LIMIT_WINDOW_MS,
  },
  claimLink: {
    endpointKey: "claim-link",
    maxRequests: 40,
    windowMs: DEFAULT_RATE_LIMIT_WINDOW_MS,
  },
  saveLink: {
    endpointKey: "save-link",
    maxRequests: 120,
    windowMs: DEFAULT_RATE_LIMIT_WINDOW_MS,
  },
  mcpApiKey: {
    endpointKey: "mcp-api-key",
    maxRequests: 24,
    windowMs: DEFAULT_RATE_LIMIT_WINDOW_MS,
  },
  mcpCreate: {
    endpointKey: "mcp-create",
    maxRequests: 60,
    windowMs: DEFAULT_RATE_LIMIT_WINDOW_MS,
  },
} as const;

export interface MarkdownMetrics {
  payloadBytes: number;
  totalChars: number;
  maxLineChars: number;
}

export interface ValidationFailure {
  status: 400 | 413;
  reason:
    | "empty_markdown"
    | "invalid_content_length"
    | "max_payload_bytes"
    | "max_total_chars"
    | "max_single_line_chars";
  message: string;
  actual?: number;
  limit?: number;
}

export interface RateLimitPolicy {
  endpointKey: string;
  maxRequests: number;
  windowMs: number;
}

export interface RateLimitCheckResult {
  allowed: boolean;
  count: number;
  maxRequests: number;
  retryAfterSeconds?: number;
}

export interface AbuseLogEntry {
  endpoint: string;
  ipHash: string;
  reason: string;
  contentLength?: number | null;
  payloadBytes?: number | null;
  totalChars?: number | null;
  maxLineChars?: number | null;
}

export type DemoGrantFailureReason =
  | "missing"
  | "not_found"
  | "already_used"
  | "expired"
  | "binding_mismatch";

let securityTablesReady = false;

async function ensureSecurityTables(env: Env): Promise<void> {
  if (securityTablesReady) return;

  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS request_rate_limits (id INTEGER PRIMARY KEY AUTOINCREMENT, endpoint TEXT NOT NULL, ip_hash TEXT NOT NULL, created_at TEXT NOT NULL)"
  ).run();

  await env.DB.prepare(
    "CREATE INDEX IF NOT EXISTS idx_request_rate_limits_endpoint_ip_time ON request_rate_limits(endpoint, ip_hash, created_at)"
  ).run();

  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS abuse_audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, endpoint TEXT NOT NULL, ip_hash TEXT NOT NULL, reason TEXT NOT NULL, content_length INTEGER, payload_bytes INTEGER, total_chars INTEGER, max_line_chars INTEGER, created_at TEXT NOT NULL)"
  ).run();

  await env.DB.prepare(
    "CREATE INDEX IF NOT EXISTS idx_abuse_audit_log_created ON abuse_audit_log(created_at)"
  ).run();

  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS demo_grants (token_hash TEXT PRIMARY KEY, ip_hash TEXT NOT NULL, user_agent_hash TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT)"
  ).run();

  await env.DB.prepare(
    "CREATE INDEX IF NOT EXISTS idx_demo_grants_expires_at ON demo_grants(expires_at)"
  ).run();

  securityTablesReady = true;
}

export function getClientIp(req: { header(name: string): string | undefined }): string {
  const cfIp = req.header("cf-connecting-ip")?.trim();
  if (cfIp) return cfIp;

  const forwarded = req.header("x-forwarded-for");
  if (forwarded) {
    const first = forwarded
      .split(",")
      .map((value) => value.trim())
      .find(Boolean);

    if (first) return first;
  }

  return "unknown";
}

function normalizeUserAgent(userAgent: string | undefined): string {
  return (userAgent || "unknown").trim().slice(0, 512) || "unknown";
}

function cookieSecureSuffix(requestUrl: string): string {
  try {
    return new URL(requestUrl).protocol === "https:" ? "; Secure" : "";
  } catch {
    return "";
  }
}

export function readCookieValue(cookieHeader: string | undefined, cookieName: string): string | null {
  if (!cookieHeader) return null;

  const pairs = cookieHeader.split(";");
  for (const pair of pairs) {
    const [rawName, ...rest] = pair.trim().split("=");
    if (rawName !== cookieName) continue;
    const value = rest.join("=").trim();
    if (!value) return null;

    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  return null;
}

export function buildDemoGrantCookie(token: string, requestUrl: string): string {
  return [
    `${DEMO_GRANT_COOKIE_NAME}=${encodeURIComponent(token)}`,
    `Max-Age=${Math.floor(DEMO_GRANT_TTL_MS / 1000)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ].join("; ") + cookieSecureSuffix(requestUrl);
}

export function clearDemoGrantCookie(requestUrl: string): string {
  return [
    `${DEMO_GRANT_COOKIE_NAME}=`,
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ].join("; ") + cookieSecureSuffix(requestUrl);
}

async function cleanupExpiredDemoGrants(env: Env, nowIso: string): Promise<void> {
  await ensureSecurityTables(env);
  await env.DB.prepare("DELETE FROM demo_grants WHERE expires_at <= ? OR used_at IS NOT NULL")
    .bind(nowIso)
    .run();
}

export async function issueDemoGrant(
  env: Env,
  {
    ipHash,
    userAgent,
  }: {
    ipHash: string;
    userAgent: string | undefined;
  }
): Promise<{ token: string; expiresAt: string; ttlSeconds: number }> {
  await ensureSecurityTables(env);

  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + DEMO_GRANT_TTL_MS).toISOString();
  const token = `dg_${crypto.randomUUID().replace(/-/g, "")}`;
  const tokenHash = await sha256(token);
  const userAgentHash = await sha256(normalizeUserAgent(userAgent));

  await cleanupExpiredDemoGrants(env, nowIso);
  await env.DB.prepare(
    "INSERT INTO demo_grants (token_hash, ip_hash, user_agent_hash, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?, NULL)"
  )
    .bind(tokenHash, ipHash, userAgentHash, nowIso, expiresAt)
    .run();

  return {
    token,
    expiresAt,
    ttlSeconds: Math.floor(DEMO_GRANT_TTL_MS / 1000),
  };
}

export async function consumeDemoGrant(
  env: Env,
  {
    token,
    ipHash,
    userAgent,
  }: {
    token: string | null;
    ipHash: string;
    userAgent: string | undefined;
  }
): Promise<{ valid: true } | { valid: false; reason: DemoGrantFailureReason }> {
  if (!token) {
    return { valid: false, reason: "missing" };
  }

  await ensureSecurityTables(env);

  const nowIso = new Date().toISOString();
  const tokenHash = await sha256(token);
  const expectedUserAgentHash = await sha256(normalizeUserAgent(userAgent));
  const grant = await env.DB.prepare(
    "SELECT ip_hash, user_agent_hash, expires_at, used_at FROM demo_grants WHERE token_hash = ?"
  )
    .bind(tokenHash)
    .first<{
      ip_hash: string;
      user_agent_hash: string;
      expires_at: string;
      used_at: string | null;
    }>();

  if (!grant) {
    return { valid: false, reason: "not_found" };
  }

  if (grant.used_at) {
    return { valid: false, reason: "already_used" };
  }

  if (grant.expires_at <= nowIso) {
    await cleanupExpiredDemoGrants(env, nowIso);
    return { valid: false, reason: "expired" };
  }

  if (grant.ip_hash !== ipHash || grant.user_agent_hash !== expectedUserAgentHash) {
    return { valid: false, reason: "binding_mismatch" };
  }

  await env.DB.prepare("UPDATE demo_grants SET used_at = ? WHERE token_hash = ? AND used_at IS NULL")
    .bind(nowIso, tokenHash)
    .run();

  return { valid: true };
}

export function buildDemoGrantErrorPayload(
  reason: DemoGrantFailureReason,
  signInUrl: string
): Record<string, unknown> {
  const isMissing = reason === "missing";
  const error = isMissing
    ? "Browser verification required before creating an anonymous demo link."
    : "Your browser verification expired or no longer matches this session.";

  return {
    error,
    code: isMissing ? "demo_grant_required" : "demo_grant_invalid",
    reason,
    recommendation:
      "Refresh browser verification and try again, or sign in to keep sharing from your account.",
    signInUrl,
  };
}

export function parseContentLength(value: string | undefined): number | null {
  if (!value || value.trim() === "") return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return Number.NaN;
  return parsed;
}

export function validateContentLength(contentLength: number | null): ValidationFailure | null {
  if (contentLength === null) return null;
  if (Number.isNaN(contentLength)) {
    return {
      status: 400,
      reason: "invalid_content_length",
      message: "Invalid Content-Length header",
    };
  }
  if (contentLength > MAX_PAYLOAD_BYTES) {
    return {
      status: 413,
      reason: "max_payload_bytes",
      message: `Payload exceeds max_payload_bytes (${MAX_PAYLOAD_BYTES} bytes)`,
      actual: contentLength,
      limit: MAX_PAYLOAD_BYTES,
    };
  }
  return null;
}

export function analyzeMarkdown(markdown: string): MarkdownMetrics {
  const payloadBytes = new TextEncoder().encode(markdown).length;
  const lines = markdown.split(/\r?\n/);
  let maxLineChars = 0;

  for (const line of lines) {
    if (line.length > maxLineChars) {
      maxLineChars = line.length;
    }
  }

  return {
    payloadBytes,
    totalChars: markdown.length,
    maxLineChars,
  };
}

export function validateMarkdown(markdown: string): {
  metrics: MarkdownMetrics;
  failure: ValidationFailure | null;
} {
  const metrics = analyzeMarkdown(markdown);

  if (!markdown || markdown.trim().length === 0) {
    return {
      metrics,
      failure: {
        status: 400,
        reason: "empty_markdown",
        message: "No markdown content provided",
      },
    };
  }

  if (metrics.payloadBytes > MAX_PAYLOAD_BYTES) {
    return {
      metrics,
      failure: {
        status: 413,
        reason: "max_payload_bytes",
        message: `Payload exceeds max_payload_bytes (${MAX_PAYLOAD_BYTES} bytes)`,
        actual: metrics.payloadBytes,
        limit: MAX_PAYLOAD_BYTES,
      },
    };
  }

  if (metrics.totalChars > MAX_TOTAL_CHARS) {
    return {
      metrics,
      failure: {
        status: 413,
        reason: "max_total_chars",
        message: `Payload exceeds max_total_chars (${MAX_TOTAL_CHARS} characters)`,
        actual: metrics.totalChars,
        limit: MAX_TOTAL_CHARS,
      },
    };
  }

  if (metrics.maxLineChars > MAX_SINGLE_LINE_CHARS) {
    return {
      metrics,
      failure: {
        status: 400,
        reason: "max_single_line_chars",
        message: `Line exceeds max_single_line_chars (${MAX_SINGLE_LINE_CHARS} characters)`,
        actual: metrics.maxLineChars,
        limit: MAX_SINGLE_LINE_CHARS,
      },
    };
  }

  return { metrics, failure: null };
}

export async function sha256(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function resolveRateLimitActorKey({
  ipHash,
  userId,
}: {
  ipHash: string;
  userId?: string | null;
}): Promise<string> {
  if (userId && userId.trim()) {
    const userHash = await sha256(`uid:${userId}`);
    return `auth:${userHash}`;
  }

  // Keep anonymous behavior stable by preserving the existing pure IP hash key.
  return ipHash;
}

export async function checkAndConsumeRateLimit(
  env: Env,
  actorKey: string,
  policy: RateLimitPolicy
): Promise<RateLimitCheckResult> {
  await ensureSecurityTables(env);

  const now = new Date();
  const nowIso = now.toISOString();
  const windowStart = new Date(now.getTime() - policy.windowMs);
  const windowStartIso = windowStart.toISOString();

  const result = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM request_rate_limits WHERE endpoint = ? AND ip_hash = ? AND created_at > ?"
  )
    .bind(policy.endpointKey, actorKey, windowStartIso)
    .first<{ count: number }>();

  const count = Number(result?.count ?? 0);

  if (count >= policy.maxRequests) {
    return {
      allowed: false,
      count,
      maxRequests: policy.maxRequests,
      retryAfterSeconds: Math.ceil(policy.windowMs / 1000),
    };
  }

  await env.DB.prepare(
    "INSERT INTO request_rate_limits (endpoint, ip_hash, created_at) VALUES (?, ?, ?)"
  )
    .bind(policy.endpointKey, actorKey, nowIso)
    .run();

  return {
    allowed: true,
    count: count + 1,
    maxRequests: policy.maxRequests,
  };
}

export async function logAbuseAttempt(env: Env, entry: AbuseLogEntry): Promise<void> {
  const now = new Date().toISOString();

  try {
    await ensureSecurityTables(env);

    await env.DB.prepare(
      "INSERT INTO abuse_audit_log (endpoint, ip_hash, reason, content_length, payload_bytes, total_chars, max_line_chars, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(
        entry.endpoint,
        entry.ipHash,
        entry.reason,
        entry.contentLength ?? null,
        entry.payloadBytes ?? null,
        entry.totalChars ?? null,
        entry.maxLineChars ?? null,
        now
      )
      .run();
  } catch (error) {
    console.error("Failed to write abuse_audit_log entry", {
      endpoint: entry.endpoint,
      reason: entry.reason,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  console.warn("Rejected abuse attempt", {
    endpoint: entry.endpoint,
    ip_hash: entry.ipHash,
    reason: entry.reason,
    content_length: entry.contentLength ?? null,
    payload_bytes: entry.payloadBytes ?? null,
    total_chars: entry.totalChars ?? null,
    max_line_chars: entry.maxLineChars ?? null,
  });
}

export function failureToErrorPayload(failure: ValidationFailure): Record<string, unknown> {
  return {
    error: failure.message,
    reason: failure.reason,
    limit: failure.limit ?? null,
    actual: failure.actual ?? null,
  };
}
