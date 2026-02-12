import { Hono } from "hono";
import { nanoid } from "nanoid";
import type { Env, CommentRecord, DocRecord } from "../types";

const app = new Hono<{ Bindings: Env }>();

const RATE_LIMIT_PER_HOUR = 10;

async function sha256(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// GET /:docId — list non-flagged comments
app.get("/:docId", async (c) => {
  try {
    const docId = c.req.param("docId");

    const doc = await c.env.DB.prepare("SELECT id FROM docs WHERE id = ?")
      .bind(docId)
      .first<DocRecord>();

    if (!doc) {
      return c.json({ error: "Document not found" }, 404);
    }

    const { results } = await c.env.DB.prepare(
      "SELECT id, doc_id, author_name, body, anchor_id, created_at, flagged, COALESCE(doc_version, 1) as doc_version FROM comments WHERE doc_id = ? AND flagged = 0 ORDER BY created_at ASC"
    )
      .bind(docId)
      .all();

    return c.json({ comments: results || [] });
  } catch (error) {
    console.error("Error fetching comments:", error);
    return c.json({ error: "Failed to fetch comments" }, 500);
  }
});

// POST /:docId — create comment
app.post("/:docId", async (c) => {
  try {
    const docId = c.req.param("docId");

    const doc = await c.env.DB.prepare("SELECT id, COALESCE(doc_version, 1) as doc_version FROM docs WHERE id = ?")
      .bind(docId)
      .first<DocRecord>();

    if (!doc) {
      return c.json({ error: "Document not found" }, 404);
    }

    const body = await c.req.json<{ author_name?: string; body?: string; anchor_id?: string }>();

    const authorName = (body.author_name || "").trim();
    const commentBody = (body.body || "").trim();
    const anchorIdRaw = typeof body.anchor_id === "string" ? body.anchor_id.trim() : "";
    const anchorId = anchorIdRaw || "doc-root";

    if (!authorName || authorName.length < 1 || authorName.length > 50) {
      return c.json({ error: "author_name must be 1-50 characters" }, 400);
    }

    if (!commentBody || commentBody.length < 1 || commentBody.length > 2000) {
      return c.json({ error: "body must be 1-2000 characters" }, 400);
    }

    if (!anchorId || anchorId.length < 1 || anchorId.length > 120) {
      return c.json({ error: "anchor_id must be 1-120 characters" }, 400);
    }

    // Rate limiting
    const clientIp = c.req.header("cf-connecting-ip") || "unknown";
    const ipHash = await sha256(clientIp);
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    const rateCheck = await c.env.DB.prepare(
      "SELECT COUNT(*) as count FROM comments WHERE ip_hash = ? AND created_at > ?"
    )
      .bind(ipHash, hourAgo)
      .first<{ count: number }>();

    if ((rateCheck?.count || 0) >= RATE_LIMIT_PER_HOUR) {
      return c.json({ error: "Rate limit exceeded. Maximum 10 comments per hour." }, 429);
    }

    const id = nanoid(12);
    const now = new Date().toISOString();

    const docVersion = doc.doc_version ?? 1;

    await c.env.DB.prepare(
      "INSERT INTO comments (id, doc_id, author_name, body, anchor_id, created_at, ip_hash, flagged, doc_version) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)"
    )
      .bind(id, docId, authorName, commentBody, anchorId, now, ipHash, docVersion)
      .run();

    const comment: CommentRecord = {
      id,
      doc_id: docId,
      author_name: authorName,
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
