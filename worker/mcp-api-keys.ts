import { nanoid } from "nanoid";
import { getBearerTokenFromRequest } from "./auth.ts";
import { sha256 } from "./security.ts";
import type { HostedMcpGrantProps } from "./mcp-oauth.ts";
import type { Env } from "./types.ts";

const MCP_API_KEY_SCHEMA_PROMISE = Symbol.for("plsreadme.mcpApiKeysSchemaPromise");

export const PERSONAL_MCP_API_KEY_PREFIX = "plsr_pk_";
export const MCP_LOCAL_API_KEY_SOURCE = "mcp_local_api_key";
export const MCP_REMOTE_API_KEY_SOURCE = "mcp_remote_api_key";

type EnvWithMcpApiKeyCache = Env & {
  [MCP_API_KEY_SCHEMA_PROMISE]?: Promise<void>;
};

interface McpApiKeyRow {
  id: string;
  user_id: string;
  name: string;
  token_prefix: string;
  created_at: string;
  last_used_at: string | null;
  last_used_source: string | null;
  revoked_at: string | null;
}

export interface PersonalMcpApiKeyListItem {
  id: string;
  name: string;
  tokenPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  lastUsedSource: string | null;
  revokedAt: string | null;
}

export interface PersonalMcpApiKeyIssueResult {
  token: string;
  key: PersonalMcpApiKeyListItem;
}

export interface PersonalMcpApiKeyAuth {
  keyId: string;
  userId: string;
  keyName: string;
  tokenPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  usageSource: typeof MCP_LOCAL_API_KEY_SOURCE | typeof MCP_REMOTE_API_KEY_SOURCE;
}

function mapApiKeyRow(row: McpApiKeyRow): PersonalMcpApiKeyListItem {
  return {
    id: row.id,
    name: row.name,
    tokenPrefix: row.token_prefix,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    lastUsedSource: row.last_used_source,
    revokedAt: row.revoked_at,
  };
}

function buildPersonalMcpApiKeyToken(): { id: string; token: string; tokenPrefix: string } {
  const id = `mk_${nanoid(10)}`;
  const token = `${PERSONAL_MCP_API_KEY_PREFIX}${nanoid(42)}`;
  return {
    id,
    token,
    tokenPrefix: `${token.slice(0, 18)}…`,
  };
}

export function normalizePersonalMcpApiKeyName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed || trimmed.length > 64) {
    return null;
  }

  return trimmed;
}

export function isPersonalMcpApiKeyToken(value: string | null | undefined): value is string {
  return typeof value === "string" &&
    new RegExp(`^${PERSONAL_MCP_API_KEY_PREFIX}[A-Za-z0-9_-]{20,80}$`).test(value.trim());
}

async function ensureMcpApiKeySchemaUncached(env: Env): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS mcp_api_keys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      token_prefix TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      last_used_source TEXT,
      revoked_at TEXT
    )`
  ).run();

  await env.DB.prepare(
    "CREATE INDEX IF NOT EXISTS idx_mcp_api_keys_user_created_at ON mcp_api_keys(user_id, created_at DESC)"
  ).run();

  await env.DB.prepare(
    "CREATE INDEX IF NOT EXISTS idx_mcp_api_keys_active_user ON mcp_api_keys(user_id, revoked_at, created_at DESC)"
  ).run();
}

export async function ensureMcpApiKeySchema(env: Env): Promise<void> {
  const envWithCache = env as EnvWithMcpApiKeyCache;

  if (!envWithCache[MCP_API_KEY_SCHEMA_PROMISE]) {
    envWithCache[MCP_API_KEY_SCHEMA_PROMISE] = ensureMcpApiKeySchemaUncached(env);
  }

  try {
    await envWithCache[MCP_API_KEY_SCHEMA_PROMISE];
  } catch (error) {
    delete envWithCache[MCP_API_KEY_SCHEMA_PROMISE];
    throw error;
  }
}

export async function issuePersonalMcpApiKey(
  env: Env,
  input: { userId: string; name: string }
): Promise<PersonalMcpApiKeyIssueResult> {
  await ensureMcpApiKeySchema(env);

  const { id, token, tokenPrefix } = buildPersonalMcpApiKeyToken();
  const tokenHash = await sha256(token);
  const createdAt = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO mcp_api_keys (
      id,
      user_id,
      name,
      token_hash,
      token_prefix,
      created_at,
      last_used_at,
      last_used_source,
      revoked_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`
  )
    .bind(id, input.userId, input.name, tokenHash, tokenPrefix, createdAt)
    .run();

  return {
    token,
    key: {
      id,
      name: input.name,
      tokenPrefix,
      createdAt,
      lastUsedAt: null,
      lastUsedSource: null,
      revokedAt: null,
    },
  };
}

export async function listPersonalMcpApiKeys(
  env: Env,
  userId: string
): Promise<PersonalMcpApiKeyListItem[]> {
  await ensureMcpApiKeySchema(env);

  const rows = await env.DB.prepare(
    `SELECT id, user_id, name, token_prefix, created_at, last_used_at, last_used_source, revoked_at
     FROM mcp_api_keys
     WHERE user_id = ?
     ORDER BY revoked_at IS NOT NULL ASC, created_at DESC`
  )
    .bind(userId)
    .all<McpApiKeyRow>();

  return (rows.results ?? []).map(mapApiKeyRow);
}

export async function revokePersonalMcpApiKey(
  env: Env,
  input: { userId: string; keyId: string }
): Promise<PersonalMcpApiKeyListItem | null> {
  await ensureMcpApiKeySchema(env);

  const existing = await env.DB.prepare(
    `SELECT id, user_id, name, token_prefix, created_at, last_used_at, last_used_source, revoked_at
     FROM mcp_api_keys
     WHERE id = ? AND user_id = ?`
  )
    .bind(input.keyId, input.userId)
    .first<McpApiKeyRow>();

  if (!existing) {
    return null;
  }

  if (!existing.revoked_at) {
    await env.DB.prepare("UPDATE mcp_api_keys SET revoked_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), input.keyId)
      .run();
  }

  return mapApiKeyRow({
    ...existing,
    revoked_at: existing.revoked_at ?? new Date().toISOString(),
  });
}

export async function resolvePersonalMcpApiKey(
  env: Env,
  token: string,
  usageSource: typeof MCP_LOCAL_API_KEY_SOURCE | typeof MCP_REMOTE_API_KEY_SOURCE
): Promise<PersonalMcpApiKeyAuth | null> {
  if (!isPersonalMcpApiKeyToken(token)) {
    return null;
  }

  await ensureMcpApiKeySchema(env);

  const tokenHash = await sha256(token);
  const row = await env.DB.prepare(
    `SELECT id, user_id, name, token_prefix, created_at, last_used_at, last_used_source, revoked_at
     FROM mcp_api_keys
     WHERE token_hash = ?`
  )
    .bind(tokenHash)
    .first<McpApiKeyRow>();

  if (!row || row.revoked_at) {
    return null;
  }

  const now = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE mcp_api_keys SET last_used_at = ?, last_used_source = ? WHERE id = ?"
  )
    .bind(now, usageSource, row.id)
    .run();

  return {
    keyId: row.id,
    userId: row.user_id,
    keyName: row.name,
    tokenPrefix: row.token_prefix,
    createdAt: row.created_at,
    lastUsedAt: now,
    usageSource,
  };
}

export async function resolvePersonalMcpApiKeyFromRequest(
  request: Request,
  env: Env,
  usageSource: typeof MCP_LOCAL_API_KEY_SOURCE | typeof MCP_REMOTE_API_KEY_SOURCE
): Promise<PersonalMcpApiKeyAuth | null> {
  const token = getBearerTokenFromRequest(request);
  if (!token) {
    return null;
  }

  return resolvePersonalMcpApiKey(env, token, usageSource);
}

export function buildHostedMcpApiKeyProps(auth: PersonalMcpApiKeyAuth): HostedMcpGrantProps {
  return {
    userId: auth.userId,
    sessionId: null,
    email: null,
    authMode: "remote_api_key",
    source: "mcp_remote_api_key",
    clientId: auth.keyId,
    clientName: auth.keyName,
    grantedAt: auth.createdAt,
    apiKeyId: auth.keyId,
    apiKeyName: auth.keyName,
  };
}
