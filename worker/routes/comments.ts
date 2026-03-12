import { Hono } from "hono";
import { nanoid } from "nanoid";
import type { Env, CommentRecord, DocRecord } from "../types";
import { getRequestAuth } from "../auth.ts";
import { ensureCommentIdentitySchema } from "../comment-identity.ts";
import { getClientIp, resolveRateLimitActorKey, sha256 } from "../security.ts";

const app = new Hono<{ Bindings: Env }>();

const RATE_LIMIT_PER_HOUR = 10;
const MAX_DISPLAY_NAME_LENGTH = 80;

type CommentListView = "all" | "current";

function normalizeCommentListView(value: string | undefined): CommentListView {
  return value === "current" ? "current" : "all";
}

function normalizeOptionalString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

function resolveAuthenticatedDisplayName({
  requestedDisplayName,
  requestedAuthorName,
  email,
  userId,
}: {
  requestedDisplayName: string | null;
  requestedAuthorName: string | null;
  email: string | null;
  userId: string | null;
}): string {
  return (
    requestedDisplayName ||
    requestedAuthorName ||
    email ||
    (userId ? `user:${userId.slice(0, 10)}` : null) ||
    "Signed-in user"
  );
}

async function stashCommentCreatedMetadata(
  env: Env,
  payload: {
    commentId: string;
    docId: string;
    docOwnerUserId: string | null;
    commenterUserId: string | null;
    commenterEmail: string | null;
    commenterDisplayName: string | null;
    commenterAuthorName: string;
    createdAt: string;
  }
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO comment_notifications (
      id,
      comment_id,
      doc_id,
      doc_owner_user_id,
      commenter_user_id,
      commenter_email,
      commenter_display_name,
      commenter_author_name,
      created_at,
      status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      nanoid(16),
      payload.commentId,
      payload.docId,
      payload.docOwnerUserId,
      payload.commenterUserId,
      payload.commenterEmail,
      payload.commenterDisplayName,
      payload.commenterAuthorName,
      payload.createdAt,
      "pending"
    )
    .run();

  try {
    await env.ANALYTICS.writeDataPoint({
      blobs: [
        "comment_created",
        payload.docId,
        payload.docOwnerUserId || "owner:none",
        payload.commenterUserId ? "auth" : "anonymous",
      ],
      doubles: [Date.now()],
      indexes: [payload.docId.slice(0, 32)],
    });
  } catch (error) {
    console.error("comment_created analytics error:", error);
  }
}

// GET /:docId — list non-flagged comments
app.get("/:docId", async (c) => {
  try {
    await ensureCommentIdentitySchema(c.env);

    const docId = c.req.param("docId");
    const view = normalizeCommentListView(c.req.query("view"));

    const doc = await c.env.DB.prepare("SELECT id, COALESCE(doc_version, 1) as doc_version FROM docs WHERE id = ?")
      .bind(docId)
      .first<DocRecord>();

    if (!doc) {
      return c.json({ error: "Document not found" }, 404);
    }

    const currentDocVersion = Number(doc.doc_version) > 0 ? Number(doc.doc_version) : 1;

    const commentsQuery =
      view === "current"
        ? c.env.DB.prepare(
            "SELECT id, doc_id, author_name, author_user_id, author_email, author_display_name, body, anchor_id, created_at, flagged, COALESCE(doc_version, 1) as doc_version FROM comments WHERE doc_id = ? AND flagged = 0 AND COALESCE(doc_version, 1) = ? ORDER BY created_at ASC"
          ).bind(docId, currentDocVersion)
        : c.env.DB.prepare(
            "SELECT id, doc_id, author_name, author_user_id, author_email, author_display_name, body, anchor_id, created_at, flagged, COALESCE(doc_version, 1) as doc_version FROM comments WHERE doc_id = ? AND flagged = 0 ORDER BY created_at ASC"
          ).bind(docId);

    const { results } = await commentsQuery.all();

    return c.json({
      comments: results || [],
      meta: {
        view,
        current_doc_version: currentDocVersion,
      },
    });
  } catch (error) {
    console.error("Error fetching comments:", error);
    return c.json({ error: "Failed to fetch comments" }, 500);
  }
});

// POST /:docId — create comment
app.post("/:docId", async (c) => {
  try {
    await ensureCommentIdentitySchema(c.env);

    const docId = c.req.param("docId");

    const doc = await c.env.DB.prepare(
      "SELECT id, COALESCE(doc_version, 1) as doc_version, owner_user_id FROM docs WHERE id = ?"
    )
      .bind(docId)
      .first<DocRecord>();

    if (!doc) {
      return c.json({ error: "Document not found" }, 404);
    }

    const body = await c.req.json<{
      author_name?: string;
      author_display_name?: string;
      body?: string;
      anchor_id?: string;
    }>();

    const requestAuth = await getRequestAuth(c);
    const isAuthenticated = requestAuth.isAuthenticated && Boolean(requestAuth.userId);

    const requestedAuthorName = normalizeOptionalString(body.author_name, 50);
    const requestedDisplayName = normalizeOptionalString(body.author_display_name, MAX_DISPLAY_NAME_LENGTH);

    let authorName = requestedAuthorName || "";
    let authorDisplayName: string | null = null;
    let authorUserId: string | null = null;
    let authorEmail: string | null = null;

    if (isAuthenticated) {
      authorUserId = requestAuth.userId;
      authorEmail = requestAuth.email;
      authorDisplayName = resolveAuthenticatedDisplayName({
        requestedDisplayName,
        requestedAuthorName,
        email: requestAuth.email,
        userId: requestAuth.userId,
      }).slice(0, MAX_DISPLAY_NAME_LENGTH);
      authorName = authorDisplayName;
    }

    const commentBody = (body.body || "").trim();
    const anchorIdRaw = typeof body.anchor_id === "string" ? body.anchor_id.trim() : "";
    const anchorId = anchorIdRaw || "doc-root";

    if (!isAuthenticated && (!authorName || authorName.length < 1 || authorName.length > 50)) {
      return c.json({ error: "author_name must be 1-50 characters" }, 400);
    }

    if (!commentBody || commentBody.length < 1 || commentBody.length > 2000) {
      return c.json({ error: "body must be 1-2000 characters" }, 400);
    }

    if (!anchorId || anchorId.length < 1 || anchorId.length > 120) {
      return c.json({ error: "anchor_id must be 1-120 characters" }, 400);
    }

    // Rate limiting (auth-aware actor key to avoid penalizing signed-in users sharing an IP)
    const clientIp = getClientIp(c.req);
    const ipHash = await sha256(clientIp);
    const rateLimitActorKey = await resolveRateLimitActorKey({
      ipHash,
      userId: isAuthenticated ? requestAuth.userId : null,
    });
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    const rateCheck = await c.env.DB.prepare(
      "SELECT COUNT(*) as count FROM comments WHERE ip_hash = ? AND created_at > ?"
    )
      .bind(rateLimitActorKey, hourAgo)
      .first<{ count: number }>();

    if ((rateCheck?.count || 0) >= RATE_LIMIT_PER_HOUR) {
      return c.json({ error: "Rate limit exceeded. Maximum 10 comments per hour." }, 429);
    }

    const id = nanoid(12);
    const now = new Date().toISOString();

    const docVersion = doc.doc_version ?? 1;

    await c.env.DB.prepare(
      "INSERT INTO comments (id, doc_id, author_name, author_user_id, author_email, author_display_name, body, anchor_id, created_at, ip_hash, flagged, doc_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)"
    )
      .bind(
        id,
        docId,
        authorName,
        authorUserId,
        authorEmail,
        authorDisplayName,
        commentBody,
        anchorId,
        now,
        rateLimitActorKey,
        docVersion
      )
      .run();

    try {
      await stashCommentCreatedMetadata(c.env, {
        commentId: id,
        docId,
        docOwnerUserId: doc.owner_user_id,
        commenterUserId: authorUserId,
        commenterEmail: authorEmail,
        commenterDisplayName: authorDisplayName,
        commenterAuthorName: authorName,
        createdAt: now,
      });
    } catch (error) {
      console.error("Failed to stash comment notification metadata:", error);
    }

    const comment: CommentRecord = {
      id,
      doc_id: docId,
      author_name: authorName,
      author_user_id: authorUserId,
      author_email: authorEmail,
      author_display_name: authorDisplayName,
      body: commentBody,
      anchor_id: anchorId,
      created_at: now,
      ip_hash: null, // don't expose
      flagged: 0,
      doc_version: docVersion,
    };

    return c.json({ comment }, 201);
  } catch (error) {
    console.error("Error creating comment:", error);
    return c.json({ error: "Failed to create comment" }, 500);
  }
});

export { app as commentsRoutes };
