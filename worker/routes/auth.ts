import { Hono } from "hono";
import { attachRequestAuth, getRequestAuth, requireAuth } from "../auth.ts";
import {
  issuePersonalMcpApiKey,
  listPersonalMcpApiKeys,
  normalizePersonalMcpApiKeyName,
  revokePersonalMcpApiKey,
  type PersonalMcpApiKeyListItem,
} from "../mcp-api-keys.ts";
import {
  HOSTED_MCP_ACCESS_TOKEN_TTL_SECONDS,
  HOSTED_MCP_AUTHORIZE_PATH,
  HOSTED_MCP_REFRESH_TOKEN_TTL_SECONDS,
  HOSTED_MCP_REGISTER_PATH,
  HOSTED_MCP_SCOPE,
  HOSTED_MCP_TOKEN_PATH,
} from "../mcp-oauth.ts";
import { ensureOwnershipSchema, ensureSavedLinksSchema } from "../ownership.ts";
import {
  buildDemoGrantCookie,
  WRITE_RATE_LIMITS,
  checkAndConsumeRateLimit,
  failureToErrorPayload,
  getClientIp,
  issueDemoGrant,
  logAbuseAttempt,
  parseContentLength,
  resolveRateLimitActorKey,
  sha256,
  validateContentLength,
} from "../security.ts";
import type { DocRecord, Env } from "../types";

const app = new Hono<{ Bindings: Env }>();

type MyLinksSort =
  | "created_desc"
  | "created_asc"
  | "title_asc"
  | "title_desc"
  | "views_desc"
  | "views_asc";

interface MyLinkRow {
  id: string;
  title: string | null;
  created_at: string;
  bytes: number;
  view_count: number;
  doc_version: number;
  saved_at?: string | null;
}

interface OAuthGrantListItem {
  id: string;
  clientId: string;
  userId: string;
  scope: string[];
  metadata: Record<string, unknown> | null;
  createdAt: number;
  expiresAt?: number;
}

type CreateMcpApiKeyBody = {
  name?: unknown;
};

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const HOSTED_MCP_GRANT_SOURCE = "mcp_remote_login";
const DEFAULT_GRANT_LIMIT = 20;
const MAX_GRANT_LIMIT = 100;

function buildSortSql(alias: string, sort: MyLinksSort): string {
  const a = alias ? `${alias}.` : "";

  const map: Record<MyLinksSort, string> = {
    created_desc: `${a}created_at DESC, ${a}id DESC`,
    created_asc: `${a}created_at ASC, ${a}id ASC`,
    title_asc: `COALESCE(${a}title, '') COLLATE NOCASE ASC, ${a}created_at DESC, ${a}id DESC`,
    title_desc: `COALESCE(${a}title, '') COLLATE NOCASE DESC, ${a}created_at DESC, ${a}id DESC`,
    views_desc: `${a}view_count DESC, ${a}created_at DESC, ${a}id DESC`,
    views_asc: `${a}view_count ASC, ${a}created_at DESC, ${a}id DESC`,
  };

  return map[sort];
}

function toPositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeSort(value: string | undefined): MyLinksSort {
  if (!value) return "created_desc";
  const normalized = value.toLowerCase() as MyLinksSort;
  const allowed: Record<MyLinksSort, true> = {
    created_desc: true,
    created_asc: true,
    title_asc: true,
    title_desc: true,
    views_desc: true,
    views_asc: true,
  };
  return normalized in allowed ? normalized : "created_desc";
}

function normalizeSearch(value: string | undefined): string {
  return (value ?? "").trim().slice(0, 120);
}

function normalizeCursor(value: string | undefined): string | undefined {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed : undefined;
}

function normalizeGrantId(value: string | undefined): string | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed || !/^[A-Za-z0-9:_-]{6,160}$/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function normalizeMcpApiKeyId(value: string | undefined): string | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed || !/^mk_[A-Za-z0-9_-]{6,40}$/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function getGrantMetadataObject(metadata: unknown): Record<string, unknown> | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }

  return metadata as Record<string, unknown>;
}

function getGrantMetadataString(metadata: unknown, key: string): string | null {
  const record = getGrantMetadataObject(metadata);
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getGrantSource(metadata: unknown): string | null {
  return getGrantMetadataString(metadata, "source");
}

function toIsoTimestamp(unixSeconds: number | undefined): string | null {
  if (!Number.isFinite(unixSeconds)) {
    return null;
  }

  return new Date((unixSeconds as number) * 1000).toISOString();
}

function slugifyTitle(title: string | null, id: string): string {
  const base = (title ?? "")
    .toLowerCase()
    .replace(/&[a-z0-9#]+;/gi, " ")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return base || id.toLowerCase();
}

type ClaimLinkBody = {
  id?: unknown;
  adminToken?: unknown;
  admin_token?: unknown;
  token?: unknown;
};

type SaveLinkBody = {
  id?: unknown;
};

function normalizeDocId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function normalizeAdminToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^sk_[A-Za-z0-9_-]{8,160}$/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function buildSearchSql({
  alias,
  search,
}: {
  alias: string;
  search: string;
}): { clause: string; params: unknown[] } {
  if (!search) {
    return { clause: "", params: [] };
  }

  const a = alias ? `${alias}.` : "";
  const like = `%${search.toLowerCase()}%`;

  return {
    clause:
      ` AND (` +
      `LOWER(COALESCE(${a}title, '')) LIKE ? OR ` +
      `LOWER(${a}id) LIKE ? OR ` +
      `LOWER(REPLACE(REPLACE(REPLACE(COALESCE(${a}title, ''), ' ', '-'), '_', '-'), '--', '-')) LIKE ?` +
      `)`,
    params: [like, like, like],
  };
}

function buildPagination(page: number, pageSize: number, total: number) {
  const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);

  return {
    page,
    pageSize,
    total,
    totalPages,
    hasNextPage: page < totalPages,
    hasPrevPage: page > 1,
  };
}

function mapLinkItem(origin: string, row: MyLinkRow, relationship: "created" | "saved") {
  return {
    id: row.id,
    title: row.title,
    slug: slugifyTitle(row.title, row.id),
    createdAt: row.created_at,
    savedAt: row.saved_at ?? null,
    bytes: row.bytes,
    viewCount: row.view_count,
    docVersion: row.doc_version,
    relationship,
    url: `${origin}/v/${row.id}`,
    rawUrl: `${origin}/v/${row.id}/raw`,
  };
}

function getOauthHelpersOrResponse(c: Parameters<typeof requireAuth>[0]): Env["OAUTH_PROVIDER"] | Response {
  if (!c.env.OAUTH_PROVIDER) {
    return c.json(
      {
        error: "Hosted remote MCP OAuth is not configured in this environment.",
        code: "oauth_not_configured",
        requiredBinding: "OAUTH_KV",
      },
      503
    );
  }

  return c.env.OAUTH_PROVIDER;
}

function mapHostedMcpGrant(origin: string, grant: OAuthGrantListItem) {
  const clientName =
    getGrantMetadataString(grant.metadata, "clientName") ||
    getGrantMetadataString(grant.metadata, "clientId") ||
    grant.clientId;

  return {
    id: grant.id,
    clientId: grant.clientId,
    clientName,
    scope: Array.isArray(grant.scope) && grant.scope.length ? grant.scope : [HOSTED_MCP_SCOPE],
    source: getGrantSource(grant.metadata) || HOSTED_MCP_GRANT_SOURCE,
    grantedAt: getGrantMetadataString(grant.metadata, "approvedAt"),
    createdAt: toIsoTimestamp(grant.createdAt),
    createdAtUnix: grant.createdAt,
    expiresAt: toIsoTimestamp(grant.expiresAt),
    expiresAtUnix: Number.isFinite(grant.expiresAt) ? grant.expiresAt ?? null : null,
    revokeUrl: `${origin}/api/auth/mcp-grants/${grant.id}`,
  };
}

function mapPersonalMcpApiKey(origin: string, item: PersonalMcpApiKeyListItem) {
  return {
    id: item.id,
    name: item.name,
    tokenPrefix: item.tokenPrefix,
    createdAt: item.createdAt,
    lastUsedAt: item.lastUsedAt,
    lastUsedSource: item.lastUsedSource,
    revokedAt: item.revokedAt,
    revokeUrl: `${origin}/api/auth/mcp-api-keys/${item.id}`,
  };
}

async function findHostedMcpGrant(
  oauth: NonNullable<Env["OAUTH_PROVIDER"]>,
  userId: string,
  grantId: string
): Promise<OAuthGrantListItem | null> {
  let cursor: string | undefined;

  do {
    const page = await oauth.listUserGrants(userId, {
      limit: MAX_GRANT_LIMIT,
      cursor,
    });

    const match = (page.items as OAuthGrantListItem[]).find(
      (grant) => grant.id === grantId && getGrantSource(grant.metadata) === HOSTED_MCP_GRANT_SOURCE
    );

    if (match) {
      return match;
    }

    cursor = page.cursor;
  } while (cursor);

  return null;
}

app.use("*", attachRequestAuth);

app.get("/config", (c) => {
  const publishableKey = c.env.CLERK_PUBLISHABLE_KEY?.trim() ?? "";
  const issuer = c.env.CLERK_JWT_ISSUER?.trim() ?? "";

  return c.json({
    enabled: Boolean(publishableKey && issuer),
    publishableKey: publishableKey || null,
    frontendApiUrl: issuer || null,
    signInUrl: c.env.CLERK_SIGN_IN_URL?.trim() || "/sign-in",
    signUpUrl: c.env.CLERK_SIGN_UP_URL?.trim() || "/sign-up",
    providers: ["github", "google", "email"],
  });
});

app.get("/session", async (c) => {
  const auth = await getRequestAuth(c);

  if (!auth.isAuthenticated) {
    return c.json({
      authenticated: false,
      reason: auth.reason ?? "missing_token",
    });
  }

  return c.json({
    authenticated: true,
    userId: auth.userId,
    sessionId: auth.sessionId,
    email: auth.email,
    tokenSource: auth.tokenSource,
  });
});

app.get("/demo-grant", async (c) => {
  const endpoint = "/api/auth/demo-grant";
  const clientIp = getClientIp(c.req);
  const ipHash = await sha256(clientIp);
  const requestAuth = await getRequestAuth(c);

  if (requestAuth.isAuthenticated) {
    return c.json({
      ok: true,
      authenticated: true,
      requiresGrant: false,
    });
  }

  const rateLimit = await checkAndConsumeRateLimit(c.env, ipHash, WRITE_RATE_LIMITS.demoGrant);
  if (!rateLimit.allowed) {
    await logAbuseAttempt(c.env, {
      endpoint,
      ipHash,
      reason: "rate_limit_exceeded",
      contentLength: null,
    });

    return c.json(
      {
        error: `Too many browser verification attempts. Maximum ${rateLimit.maxRequests} per hour.`,
        code: "rate_limit_exceeded",
        limit: rateLimit.maxRequests,
        actual: rateLimit.count,
        retry_after_seconds: rateLimit.retryAfterSeconds ?? 3600,
      },
      429
    );
  }

  const grant = await issueDemoGrant(c.env, {
    ipHash,
    userAgent: c.req.header("user-agent"),
  });

  const response = c.json({
    ok: true,
    authenticated: false,
    requiresGrant: true,
    expiresAt: grant.expiresAt,
    ttlSeconds: grant.ttlSeconds,
  });
  response.headers.append("Set-Cookie", buildDemoGrantCookie(grant.token, c.req.url));
  return response;
});

app.get("/me", async (c) => {
  const authOrResponse = await requireAuth(c);
  if (authOrResponse instanceof Response) {
    return authOrResponse;
  }

  return c.json({
    userId: authOrResponse.userId,
    sessionId: authOrResponse.sessionId,
    email: authOrResponse.email,
    tokenSource: authOrResponse.tokenSource,
  });
});

app.get("/mcp-grants", async (c) => {
  const authOrResponse = await requireAuth(c);
  if (authOrResponse instanceof Response) {
    return authOrResponse;
  }

  const oauth = getOauthHelpersOrResponse(c);
  if (oauth instanceof Response) {
    return oauth;
  }

  const limit = clamp(
    toPositiveInt(c.req.query("limit") ?? c.req.query("page_size"), DEFAULT_GRANT_LIMIT),
    1,
    MAX_GRANT_LIMIT
  );
  const cursor = normalizeCursor(c.req.query("cursor"));
  const origin = new URL(c.req.url).origin;

  const page = await oauth.listUserGrants(authOrResponse.userId, {
    limit,
    cursor,
  });

  const items = (page.items as OAuthGrantListItem[])
    .filter((grant) => getGrantSource(grant.metadata) === HOSTED_MCP_GRANT_SOURCE)
    .map((grant) => mapHostedMcpGrant(origin, grant));

  return c.json({
    items,
    cursor: page.cursor ?? null,
    lifecycle: {
      accessTokenTtlSeconds: HOSTED_MCP_ACCESS_TOKEN_TTL_SECONDS,
      refreshTokenTtlSeconds: HOSTED_MCP_REFRESH_TOKEN_TTL_SECONDS,
      reconnectBehavior: "Reconnecting the same client replaces the older hosted MCP grant.",
      logoutBehavior:
        "Signing out of the website does not revoke existing editor grants. It ends the browser session only, and the grant stays active until revoked or refreshed tokens expire.",
    },
    endpoints: {
      authorize: HOSTED_MCP_AUTHORIZE_PATH,
      token: HOSTED_MCP_TOKEN_PATH,
      register: HOSTED_MCP_REGISTER_PATH,
    },
  });
});

app.delete("/mcp-grants/:grantId", async (c) => {
  const authOrResponse = await requireAuth(c);
  if (authOrResponse instanceof Response) {
    return authOrResponse;
  }

  const oauth = getOauthHelpersOrResponse(c);
  if (oauth instanceof Response) {
    return oauth;
  }

  const grantId = normalizeGrantId(c.req.param("grantId"));
  if (!grantId) {
    return c.json(
      {
        error: "Invalid grant id.",
        code: "invalid_grant_id",
      },
      400
    );
  }

  const grant = await findHostedMcpGrant(oauth, authOrResponse.userId, grantId);
  if (!grant) {
    return c.json(
      {
        error: "Hosted MCP grant not found.",
        code: "grant_not_found",
      },
      404
    );
  }

  await oauth.revokeGrant(grantId, authOrResponse.userId);

  return c.json({
    ok: true,
    revoked: true,
    grantId,
    clientId: grant.clientId,
    clientName:
      getGrantMetadataString(grant.metadata, "clientName") ||
      getGrantMetadataString(grant.metadata, "clientId") ||
      grant.clientId,
  });
});

app.get("/mcp-api-keys", async (c) => {
  const authOrResponse = await requireAuth(c);
  if (authOrResponse instanceof Response) {
    return authOrResponse;
  }

  const origin = new URL(c.req.url).origin;
  const items = await listPersonalMcpApiKeys(c.env, authOrResponse.userId);

  return c.json({
    items: items.map((item) => mapPersonalMcpApiKey(origin, item)),
    guidance: {
      recommended: "Use a personal plsreadme API key only when browser login is unavailable in your client.",
      localEnvVar: "PLSREADME_API_KEY",
      localAnonymousOptInEnv: "PLSREADME_ALLOW_ANONYMOUS=1",
      setupUrl: `${origin}/mcp-setup`,
    },
  });
});

app.post("/mcp-api-keys", async (c) => {
  const endpoint = "/api/auth/mcp-api-keys";
  const clientIp = getClientIp(c.req);
  const ipHash = await sha256(clientIp);
  const contentLength = parseContentLength(c.req.header("content-length"));

  const authOrResponse = await requireAuth(c);
  if (authOrResponse instanceof Response) {
    return authOrResponse;
  }

  const contentLengthFailure = validateContentLength(contentLength);
  if (contentLengthFailure) {
    await logAbuseAttempt(c.env, {
      endpoint,
      ipHash,
      reason: contentLengthFailure.reason,
      contentLength,
    });
    return c.json(failureToErrorPayload(contentLengthFailure), contentLengthFailure.status);
  }

  const rateLimitActorKey = await resolveRateLimitActorKey({
    ipHash,
    userId: authOrResponse.userId,
  });

  const rateLimit = await checkAndConsumeRateLimit(c.env, rateLimitActorKey, WRITE_RATE_LIMITS.mcpApiKey);
  if (!rateLimit.allowed) {
    await logAbuseAttempt(c.env, {
      endpoint,
      ipHash,
      reason: "rate_limit_exceeded",
      contentLength,
    });

    return c.json(
      {
        error: `Rate limit exceeded. Maximum ${rateLimit.maxRequests} API key actions per hour.`,
        code: "rate_limit_exceeded",
        limit: rateLimit.maxRequests,
        actual: rateLimit.count,
        retry_after_seconds: rateLimit.retryAfterSeconds ?? 3600,
      },
      429
    );
  }

  const body = await c.req.json<CreateMcpApiKeyBody>().catch(() => null);
  const name = normalizePersonalMcpApiKeyName(body?.name);

  if (!name) {
    return c.json(
      {
        error: "Provide a key name between 1 and 64 characters.",
        code: "invalid_api_key_name",
      },
      400
    );
  }

  const result = await issuePersonalMcpApiKey(c.env, {
    userId: authOrResponse.userId,
    name,
  });

  return c.json(
    {
      ok: true,
      token: result.token,
      key: mapPersonalMcpApiKey(new URL(c.req.url).origin, result.key),
      guidance: {
        localEnvVar: "PLSREADME_API_KEY",
        remoteHeader: "Authorization: Bearer <personal_api_key>",
        showOnce:
          "This token is shown only once. Copy it into your MCP client config now, then revoke it from this page if it ever leaks.",
      },
    },
    201
  );
});

app.delete("/mcp-api-keys/:keyId", async (c) => {
  const authOrResponse = await requireAuth(c);
  if (authOrResponse instanceof Response) {
    return authOrResponse;
  }

  const keyId = normalizeMcpApiKeyId(c.req.param("keyId"));
  if (!keyId) {
    return c.json(
      {
        error: "Invalid API key id.",
        code: "invalid_api_key_id",
      },
      400
    );
  }

  const revoked = await revokePersonalMcpApiKey(c.env, {
    userId: authOrResponse.userId,
    keyId,
  });

  if (!revoked) {
    return c.json(
      {
        error: "API key not found.",
        code: "api_key_not_found",
      },
      404
    );
  }

  return c.json({
    ok: true,
    revoked: true,
    key: mapPersonalMcpApiKey(new URL(c.req.url).origin, revoked),
  });
});

app.get("/my-links", async (c) => {
  const authOrResponse = await requireAuth(c);
  if (authOrResponse instanceof Response) {
    return authOrResponse;
  }

  await ensureOwnershipSchema(c.env);
  await ensureSavedLinksSchema(c.env);

  const rawSearch = c.req.query("search") ?? c.req.query("q");
  const search = normalizeSearch(rawSearch);
  const sort = normalizeSort(c.req.query("sort"));
  const page = toPositiveInt(c.req.query("page"), DEFAULT_PAGE);
  const rawPageSize = c.req.query("page_size") ?? c.req.query("pageSize") ?? c.req.query("limit");
  const pageSize = clamp(toPositiveInt(rawPageSize, DEFAULT_PAGE_SIZE), 1, MAX_PAGE_SIZE);
  const offset = (page - 1) * pageSize;

  const origin = new URL(c.req.url).origin;
  const userId = authOrResponse.userId;

  const createdBaseParams: unknown[] = [userId];
  let createdWhereClause = "d.owner_user_id = ?";

  const createdSearchSql = buildSearchSql({ alias: "d", search });
  createdWhereClause += createdSearchSql.clause;
  createdBaseParams.push(...createdSearchSql.params);

  const createdCountSql = `SELECT COUNT(*) as count FROM docs d WHERE ${createdWhereClause}`;
  const createdTotalResult = await c.env.DB.prepare(createdCountSql)
    .bind(...createdBaseParams)
    .first<{ count: number | string | null }>();
  const createdTotal = Number(createdTotalResult?.count ?? 0) || 0;

  const createdRows = await c.env.DB.prepare(
    `SELECT d.id, d.title, d.created_at, d.bytes, d.view_count, d.doc_version
     FROM docs d
     WHERE ${createdWhereClause}
     ORDER BY ${buildSortSql("d", sort)}
     LIMIT ? OFFSET ?`
  )
    .bind(...createdBaseParams, pageSize, offset)
    .all<MyLinkRow>();

  const createdItems = (createdRows.results ?? []).map((row) =>
    mapLinkItem(origin, row, "created")
  );

  const savedBaseParams: unknown[] = [userId, userId];
  let savedWhereClause = "sl.user_id = ? AND (d.owner_user_id IS NULL OR d.owner_user_id <> ?)";

  const savedSearchSql = buildSearchSql({ alias: "d", search });
  savedWhereClause += savedSearchSql.clause;
  savedBaseParams.push(...savedSearchSql.params);

  const savedCountSql = `
    SELECT COUNT(*) as count
    FROM saved_links sl
    INNER JOIN docs d ON d.id = sl.doc_id
    WHERE ${savedWhereClause}
  `;
  const savedTotalResult = await c.env.DB.prepare(savedCountSql)
    .bind(...savedBaseParams)
    .first<{ count: number | string | null }>();
  const savedTotal = Number(savedTotalResult?.count ?? 0) || 0;

  const savedRows = await c.env.DB.prepare(
    `SELECT d.id, d.title, d.created_at, d.bytes, d.view_count, d.doc_version, sl.created_at as saved_at
     FROM saved_links sl
     INNER JOIN docs d ON d.id = sl.doc_id
     WHERE ${savedWhereClause}
     ORDER BY ${buildSortSql("d", sort)}
     LIMIT ? OFFSET ?`
  )
    .bind(...savedBaseParams, pageSize, offset)
    .all<MyLinkRow>();

  const savedItems = (savedRows.results ?? []).map((row) => mapLinkItem(origin, row, "saved"));

  const createdPagination = buildPagination(page, pageSize, createdTotal);
  const savedPagination = buildPagination(page, pageSize, savedTotal);

  return c.json({
    // Backward-compatible fields (created links)
    items: createdItems,
    pagination: createdPagination,

    created: {
      items: createdItems,
      pagination: createdPagination,
    },
    saved: {
      items: savedItems,
      pagination: savedPagination,
    },
    totals: {
      created: createdTotal,
      saved: savedTotal,
      all: createdTotal + savedTotal,
    },
    sort,
    search,
  });
});

app.get("/save-link/:id", async (c) => {
  const authOrResponse = await requireAuth(c);
  if (authOrResponse instanceof Response) {
    return authOrResponse;
  }

  await ensureOwnershipSchema(c.env);
  await ensureSavedLinksSchema(c.env);

  const docId = normalizeDocId(c.req.param("id"));
  if (!docId) {
    return c.json(
      {
        error: "Invalid document id.",
        code: "invalid_doc_id",
      },
      400
    );
  }

  const doc = await c.env.DB.prepare("SELECT id, title, owner_user_id FROM docs WHERE id = ?")
    .bind(docId)
    .first<Pick<DocRecord, "id" | "title" | "owner_user_id">>();

  if (!doc) {
    return c.json(
      {
        error: "Document not found.",
        code: "doc_not_found",
      },
      404
    );
  }

  if (doc.owner_user_id && doc.owner_user_id === authOrResponse.userId) {
    return c.json({
      id: doc.id,
      title: doc.title,
      saved: false,
      createdByUser: true,
      code: "already_created",
    });
  }

  const existing = await c.env.DB.prepare(
    "SELECT created_at FROM saved_links WHERE user_id = ? AND doc_id = ?"
  )
    .bind(authOrResponse.userId, doc.id)
    .first<{ created_at: string | null }>();

  return c.json({
    id: doc.id,
    title: doc.title,
    saved: Boolean(existing),
    savedAt: existing?.created_at ?? null,
    createdByUser: false,
    code: existing ? "already_saved" : "not_saved",
  });
});

app.post("/save-link", async (c) => {
  const endpoint = "/api/auth/save-link";
  const clientIp = getClientIp(c.req);
  const ipHash = await sha256(clientIp);
  const contentLength = parseContentLength(c.req.header("content-length"));

  const authOrResponse = await requireAuth(c);
  if (authOrResponse instanceof Response) {
    return authOrResponse;
  }

  const contentLengthFailure = validateContentLength(contentLength);
  if (contentLengthFailure) {
    await logAbuseAttempt(c.env, {
      endpoint,
      ipHash,
      reason: contentLengthFailure.reason,
      contentLength,
    });
    return c.json(failureToErrorPayload(contentLengthFailure), contentLengthFailure.status);
  }

  const rateLimitActorKey = await resolveRateLimitActorKey({
    ipHash,
    userId: authOrResponse.userId,
  });

  const rateLimit = await checkAndConsumeRateLimit(c.env, rateLimitActorKey, WRITE_RATE_LIMITS.saveLink);
  if (!rateLimit.allowed) {
    await logAbuseAttempt(c.env, {
      endpoint,
      ipHash,
      reason: "rate_limit_exceeded",
      contentLength,
    });

    return c.json(
      {
        error: `Rate limit exceeded. Maximum ${rateLimit.maxRequests} save attempts per hour.`,
        code: "rate_limit_exceeded",
        limit: rateLimit.maxRequests,
        actual: rateLimit.count,
        retry_after_seconds: rateLimit.retryAfterSeconds ?? 3600,
      },
      429
    );
  }

  await ensureOwnershipSchema(c.env);
  await ensureSavedLinksSchema(c.env);

  const body = await c.req.json<SaveLinkBody>().catch(() => null);
  const docId = normalizeDocId(body?.id);

  if (!docId) {
    await logAbuseAttempt(c.env, {
      endpoint,
      ipHash,
      reason: "invalid_save_payload",
      contentLength,
    });

    return c.json(
      {
        error: "Invalid save payload. Provide a valid document ID.",
        code: "invalid_save_payload",
      },
      400
    );
  }

  const doc = await c.env.DB.prepare("SELECT id, title, owner_user_id FROM docs WHERE id = ?")
    .bind(docId)
    .first<Pick<DocRecord, "id" | "title" | "owner_user_id">>();

  if (!doc) {
    return c.json(
      {
        error: "Document not found.",
        code: "doc_not_found",
      },
      404
    );
  }

  if (doc.owner_user_id && doc.owner_user_id === authOrResponse.userId) {
    return c.json({
      id: doc.id,
      title: doc.title,
      saved: false,
      createdByUser: true,
      code: "already_created",
      message: "This link is already in your Created links section.",
    });
  }

  const existing = await c.env.DB.prepare(
    "SELECT created_at FROM saved_links WHERE user_id = ? AND doc_id = ?"
  )
    .bind(authOrResponse.userId, doc.id)
    .first<{ created_at: string | null }>();

  if (existing) {
    return c.json({
      id: doc.id,
      title: doc.title,
      saved: true,
      savedAt: existing.created_at,
      createdByUser: false,
      code: "already_saved",
      message: "This link is already in your Saved links section.",
    });
  }

  const now = new Date().toISOString();

  await c.env.DB.prepare("INSERT INTO saved_links (user_id, doc_id, created_at) VALUES (?, ?, ?)")
    .bind(authOrResponse.userId, doc.id, now)
    .run();

  try {
    await c.env.ANALYTICS.writeDataPoint({
      blobs: ["link_saved", authOrResponse.userId, doc.id],
      doubles: [Date.now()],
      indexes: [authOrResponse.userId.slice(0, 32)],
    });
  } catch (analyticsError) {
    console.error("link_saved analytics error:", analyticsError);
  }

  return c.json({
    id: doc.id,
    title: doc.title,
    saved: true,
    savedAt: now,
    createdByUser: false,
    code: "saved",
    message: "Link saved to My Links.",
  });
});

app.post("/claim-link", async (c) => {
  const endpoint = "/api/auth/claim-link";
  const clientIp = getClientIp(c.req);
  const ipHash = await sha256(clientIp);
  const contentLength = parseContentLength(c.req.header("content-length"));

  const authOrResponse = await requireAuth(c);
  if (authOrResponse instanceof Response) {
    return authOrResponse;
  }

  const userId = authOrResponse.userId;
  if (!userId) {
    return c.json(
      {
        error: "Authentication required",
        code: "auth_required",
      },
      401
    );
  }

  const contentLengthFailure = validateContentLength(contentLength);
  if (contentLengthFailure) {
    await logAbuseAttempt(c.env, {
      endpoint,
      ipHash,
      reason: contentLengthFailure.reason,
      contentLength,
    });
    return c.json(failureToErrorPayload(contentLengthFailure), contentLengthFailure.status);
  }

  const rateLimitActorKey = await resolveRateLimitActorKey({
    ipHash,
    userId,
  });
  const rateLimit = await checkAndConsumeRateLimit(c.env, rateLimitActorKey, WRITE_RATE_LIMITS.claimLink);
  if (!rateLimit.allowed) {
    await logAbuseAttempt(c.env, {
      endpoint,
      ipHash,
      reason: "rate_limit_exceeded",
      contentLength,
    });

    return c.json(
      {
        error: `Rate limit exceeded. Maximum ${rateLimit.maxRequests} claim attempts per hour.`,
        code: "rate_limit_exceeded",
        limit: rateLimit.maxRequests,
        actual: rateLimit.count,
        retry_after_seconds: rateLimit.retryAfterSeconds ?? 3600,
      },
      429
    );
  }

  await ensureOwnershipSchema(c.env);

  const body = await c.req.json<ClaimLinkBody>().catch(() => null);
  const docId = normalizeDocId(body?.id);
  const adminToken = normalizeAdminToken(body?.adminToken ?? body?.admin_token ?? body?.token);

  if (!docId || !adminToken) {
    await logAbuseAttempt(c.env, {
      endpoint,
      ipHash,
      reason: "invalid_claim_payload",
      contentLength,
    });

    return c.json(
      {
        error: "Invalid claim payload. Provide a valid document ID and admin token.",
        code: "invalid_claim_payload",
      },
      400
    );
  }

  const doc = await c.env.DB.prepare(
    "SELECT id, title, owner_user_id, admin_token FROM docs WHERE id = ?"
  )
    .bind(docId)
    .first<Pick<DocRecord, "id" | "title" | "owner_user_id" | "admin_token">>();

  if (!doc) {
    return c.json(
      {
        error: "Document not found.",
        code: "doc_not_found",
      },
      404
    );
  }

  if (doc.owner_user_id && doc.owner_user_id !== userId) {
    await logAbuseAttempt(c.env, {
      endpoint,
      ipHash,
      reason: "claim_owner_mismatch",
      contentLength,
    });

    return c.json(
      {
        error: "This link is already owned by another account.",
        code: "owner_mismatch",
      },
      403
    );
  }

  if (!doc.admin_token || doc.admin_token !== adminToken) {
    await logAbuseAttempt(c.env, {
      endpoint,
      ipHash,
      reason: "invalid_claim_proof",
      contentLength,
    });

    return c.json(
      {
        error: "Invalid claim proof. Use the original edit/admin token for this link.",
        code: "invalid_claim_proof",
      },
      403
    );
  }

  const origin = new URL(c.req.url).origin;

  if (doc.owner_user_id === userId) {
    return c.json({
      id: doc.id,
      title: doc.title,
      claimed: false,
      code: "already_owned",
      message: "This link is already in your account.",
      url: `${origin}/v/${doc.id}`,
      rawUrl: `${origin}/v/${doc.id}/raw`,
    });
  }

  await c.env.DB.prepare("UPDATE docs SET owner_user_id = ? WHERE id = ? AND owner_user_id IS NULL")
    .bind(userId, doc.id)
    .run();

  const ownershipResult = await c.env.DB.prepare("SELECT owner_user_id FROM docs WHERE id = ?")
    .bind(doc.id)
    .first<{ owner_user_id: string | null }>();

  if (ownershipResult?.owner_user_id !== userId) {
    return c.json(
      {
        error: "This link was claimed by another account.",
        code: "owner_mismatch",
      },
      403
    );
  }

  try {
    await c.env.ANALYTICS.writeDataPoint({
      blobs: ["legacy_link_claimed", userId, doc.id],
      doubles: [Date.now()],
      indexes: [userId.slice(0, 32)],
    });
  } catch (analyticsError) {
    console.error("legacy_link_claimed analytics error:", analyticsError);
  }

  return c.json({
    id: doc.id,
    title: doc.title,
    claimed: true,
    code: "claimed",
    message: "Link claimed successfully.",
    url: `${origin}/v/${doc.id}`,
    rawUrl: `${origin}/v/${doc.id}/raw`,
  });
});

export { app as authRoutes };
