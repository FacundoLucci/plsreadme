import type { Env } from "./types";

export const MAX_PAYLOAD_BYTES = 256 * 1024;
export const MAX_TOTAL_CHARS = 220_000;
export const MAX_SINGLE_LINE_CHARS = 16_384;

const DEFAULT_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

export const WRITE_RATE_LIMITS = {
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
  renderUpdate: {
    endpointKey: "render-update",
    maxRequests: 60,
    windowMs: DEFAULT_RATE_LIMIT_WINDOW_MS,
  },
  claimLink: {
    endpointKey: "claim-link",
    maxRequests: 40,
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
