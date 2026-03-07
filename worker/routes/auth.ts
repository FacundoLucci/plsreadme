import { Hono } from "hono";
import { attachRequestAuth, getRequestAuth, requireAuth } from "../auth.ts";
import { ensureOwnershipSchema } from "../ownership.ts";
import type { Env } from "../types";

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
  created_desc: "created_at DESC",
  created_asc: "created_at ASC",
  title_asc: "COALESCE(title, '') COLLATE NOCASE ASC, created_at DESC",
  title_desc: "COALESCE(title, '') COLLATE NOCASE DESC, created_at DESC",
  views_desc: "view_count DESC, created_at DESC",
  views_asc: "view_count ASC, created_at DESC",
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

export { app as authRoutes };
