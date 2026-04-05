import type { Env } from "./types";

const DOC_TELEMETRY_SCHEMA_PROMISE = Symbol.for("plsreadme.docTelemetrySchemaPromise");

type EnvWithDocTelemetryCache = Env & {
  [DOC_TELEMETRY_SCHEMA_PROMISE]?: Promise<void>;
};

export interface DocCreateEventInput {
  docId: string;
  createdAt: string;
  source: string;
  authMode: string;
  clientId?: string | null;
  clientName?: string | null;
  actorUserId?: string | null;
  actorEmail?: string | null;
  actorSessionId?: string | null;
  apiKeyId?: string | null;
  apiKeyName?: string | null;
}

function isDuplicateColumnError(error: unknown): boolean {
  return error instanceof Error && /duplicate\s+column\s+name/i.test(error.message);
}

async function ensureDocTelemetrySchemaUncached(env: Env): Promise<void> {
  try {
    await env.DB.prepare("ALTER TABLE docs ADD COLUMN raw_view_count INTEGER NOT NULL DEFAULT 0").run();
  } catch (error) {
    if (!isDuplicateColumnError(error)) {
      throw error;
    }
  }

  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS doc_create_events (
      doc_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      source TEXT NOT NULL,
      auth_mode TEXT NOT NULL,
      client_id TEXT,
      client_name TEXT,
      actor_user_id TEXT,
      actor_email TEXT,
      actor_session_id TEXT,
      api_key_id TEXT,
      api_key_name TEXT
    )`
  ).run();

  await env.DB.prepare(
    "CREATE INDEX IF NOT EXISTS idx_doc_create_events_source_created ON doc_create_events(source, created_at DESC)"
  ).run();

  await env.DB.prepare(
    "CREATE INDEX IF NOT EXISTS idx_doc_create_events_auth_mode_created ON doc_create_events(auth_mode, created_at DESC)"
  ).run();

  await env.DB.prepare(
    "CREATE INDEX IF NOT EXISTS idx_doc_create_events_actor_created ON doc_create_events(actor_user_id, created_at DESC)"
  ).run();
}

export async function ensureDocTelemetrySchema(env: Env): Promise<void> {
  const envWithCache = env as EnvWithDocTelemetryCache;

  if (!envWithCache[DOC_TELEMETRY_SCHEMA_PROMISE]) {
    envWithCache[DOC_TELEMETRY_SCHEMA_PROMISE] = ensureDocTelemetrySchemaUncached(env);
  }

  try {
    await envWithCache[DOC_TELEMETRY_SCHEMA_PROMISE];
  } catch (error) {
    delete envWithCache[DOC_TELEMETRY_SCHEMA_PROMISE];
    throw error;
  }
}

export async function recordDocCreateEvent(env: Env, input: DocCreateEventInput): Promise<void> {
  await ensureDocTelemetrySchema(env);

  await env.DB.prepare(
    `INSERT OR REPLACE INTO doc_create_events (
      doc_id,
      created_at,
      source,
      auth_mode,
      client_id,
      client_name,
      actor_user_id,
      actor_email,
      actor_session_id,
      api_key_id,
      api_key_name
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      input.docId,
      input.createdAt,
      input.source,
      input.authMode,
      input.clientId ?? null,
      input.clientName ?? null,
      input.actorUserId ?? null,
      input.actorEmail ?? null,
      input.actorSessionId ?? null,
      input.apiKeyId ?? null,
      input.apiKeyName ?? null
    )
    .run();
}

export function buildDocCustomMetadata(input: {
  createdAt: string;
  sha256: string;
  source: string;
  authMode: string;
  ownerUserId?: string | null;
  clientId?: string | null;
  clientName?: string | null;
  actorEmail?: string | null;
  actorSessionId?: string | null;
  apiKeyId?: string | null;
  apiKeyName?: string | null;
}): Record<string, string> {
  return {
    created_at: input.createdAt,
    sha256: input.sha256,
    owner_user_id: input.ownerUserId ?? "",
    created_source: input.source,
    auth_mode: input.authMode,
    client_id: input.clientId ?? "",
    client_name: input.clientName ?? "",
    actor_email: input.actorEmail ?? "",
    actor_session_id: input.actorSessionId ?? "",
    api_key_id: input.apiKeyId ?? "",
    api_key_name: input.apiKeyName ?? "",
  };
}

const BOT_USER_AGENT_PATTERN =
  /(bot|crawler|spider|preview|slackbot|discordbot|telegrambot|twitterbot|linkedinbot|facebookexternalhit|curl|wget|python-requests|go-http-client|node-fetch|axios)/i;

export function isLikelyHumanDocumentView(request: Request): boolean {
  const userAgent = request.headers.get("user-agent") || "";
  if (!userAgent || BOT_USER_AGENT_PATTERN.test(userAgent)) {
    return false;
  }

  const purpose =
    request.headers.get("purpose") ||
    request.headers.get("x-purpose") ||
    request.headers.get("sec-purpose") ||
    "";
  if (/prefetch|preview/i.test(purpose)) {
    return false;
  }

  const secFetchDest = request.headers.get("sec-fetch-dest");
  if (secFetchDest && secFetchDest !== "document") {
    return false;
  }

  const accept = request.headers.get("accept") || "";
  return accept.includes("text/html");
}

export async function recordDocumentView(
  env: Env,
  docId: string,
  {
    likelyHuman,
  }: {
    likelyHuman: boolean;
  }
): Promise<void> {
  await ensureDocTelemetrySchema(env);

  const sql = likelyHuman
    ? "UPDATE docs SET raw_view_count = COALESCE(raw_view_count, 0) + 1, view_count = view_count + 1 WHERE id = ?"
    : "UPDATE docs SET raw_view_count = COALESCE(raw_view_count, 0) + 1 WHERE id = ?";

  await env.DB.prepare(sql).bind(docId).run();
}
