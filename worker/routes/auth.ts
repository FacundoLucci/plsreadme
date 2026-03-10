import { Hono } from "hono";
import { attachRequestAuth, getRequestAuth, requireAuth } from "../auth.ts";
import { ensureOwnershipSchema } from "../ownership.ts";
import {
  WRITE_RATE_LIMITS,
  checkAndConsumeRateLimit,
  failureToErrorPayload,
  getClientIp,
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
}

const SORT_TO_SQL: Record<MyLinksSort, string> = {
  created_desc: "created_at DESC, id DESC",
  created_asc: "created_at ASC, id ASC",
  title_asc: "COALESCE(title, '') COLLATE NOCASE ASC, created_at DESC, id DESC",
  title_desc: "COALESCE(title, '') COLLATE NOCASE DESC, created_at DESC, id DESC",
  views_desc: "view_count DESC, created_at DESC, id DESC",
  views_asc: "view_count ASC, created_at DESC, id DESC",
};

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

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
  return normalized in SORT_TO_SQL ? normalized : "created_desc";
}

function normalizeSearch(value: string | undefined): string {
  return (value ?? "").trim().slice(0, 120);
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

app.use("*", attachRequestAuth);

app.get("/config", (c) => {
  const publishableKey = c.env.CLERK_PUBLISHABLE_KEY?.trim() ?? "";
  const issuer = c.env.CLERK_JWT_ISSUER?.trim() ?? "";

  return c.json({
    enabled: Boolean(publishableKey && issuer),
    publishableKey: publishableKey || null,
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

app.get("/my-links", async (c) => {
  const authOrResponse = await requireAuth(c);
  if (authOrResponse instanceof Response) {
    return authOrResponse;
  }

  await ensureOwnershipSchema(c.env);

  const rawSearch = c.req.query("search") ?? c.req.query("q");
  const search = normalizeSearch(rawSearch);

  const sort = normalizeSort(c.req.query("sort"));
  const page = toPositiveInt(c.req.query("page"), DEFAULT_PAGE);
  const rawPageSize = c.req.query("page_size") ?? c.req.query("pageSize") ?? c.req.query("limit");
  const pageSize = clamp(toPositiveInt(rawPageSize, DEFAULT_PAGE_SIZE), 1, MAX_PAGE_SIZE);
  const offset = (page - 1) * pageSize;

  const baseParams: unknown[] = [authOrResponse.userId];
  let whereClause = "owner_user_id = ?";

  if (search) {
    const like = `%${search.toLowerCase()}%`;
    whereClause +=
      " AND (LOWER(COALESCE(title, '')) LIKE ? OR LOWER(id) LIKE ? OR LOWER(REPLACE(REPLACE(REPLACE(COALESCE(title, ''), ' ', '-'), '_', '-'), '--', '-')) LIKE ?)";
    baseParams.push(like, like, like);
  }

  const countSql = `SELECT COUNT(*) as count FROM docs WHERE ${whereClause}`;
  const totalResult = await c.env.DB.prepare(countSql)
    .bind(...baseParams)
    .first<{ count: number | string | null }>();

  const total = Number(totalResult?.count ?? 0) || 0;
  const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);

  const listSql = `
    SELECT id, title, created_at, bytes, view_count, doc_version
    FROM docs
    WHERE ${whereClause}
    ORDER BY ${SORT_TO_SQL[sort]}
    LIMIT ? OFFSET ?
  `;

  const rows = await c.env.DB.prepare(listSql)
    .bind(...baseParams, pageSize, offset)
    .all<MyLinkRow>();

  const origin = new URL(c.req.url).origin;
  const items = (rows.results ?? []).map((row) => ({
    id: row.id,
    title: row.title,
    slug: slugifyTitle(row.title, row.id),
    createdAt: row.created_at,
    bytes: row.bytes,
    viewCount: row.view_count,
    docVersion: row.doc_version,
    url: `${origin}/v/${row.id}`,
    rawUrl: `${origin}/v/${row.id}/raw`,
  }));

  return c.json({
    items,
    pagination: {
      page,
      pageSize,
      total,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    },
    sort,
    search,
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

  await c.env.DB.prepare(
    "UPDATE docs SET owner_user_id = ? WHERE id = ? AND owner_user_id IS NULL"
  )
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
