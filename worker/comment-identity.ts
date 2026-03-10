import type { Env } from "./types";

const COMMENT_IDENTITY_SCHEMA_PROMISE = Symbol.for("plsreadme.commentIdentitySchemaPromise");

type EnvWithCommentIdentityCache = Env & {
  [COMMENT_IDENTITY_SCHEMA_PROMISE]?: Promise<void>;
};

function isDuplicateColumnError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /duplicate\s+column\s+name/i.test(error.message);
}

async function addCommentColumnIfMissing(env: Env, column: string, definition: string): Promise<void> {
  try {
    await env.DB.prepare(`ALTER TABLE comments ADD COLUMN ${column} ${definition}`).run();
  } catch (error) {
    if (!isDuplicateColumnError(error)) {
      throw error;
    }
  }
}

async function ensureCommentIdentitySchemaUncached(env: Env): Promise<void> {
  await addCommentColumnIfMissing(env, "author_user_id", "TEXT");
  await addCommentColumnIfMissing(env, "author_email", "TEXT");
  await addCommentColumnIfMissing(env, "author_display_name", "TEXT");

  await env.DB.prepare(
    "CREATE INDEX IF NOT EXISTS idx_comments_author_user_id ON comments(author_user_id, created_at DESC)"
  ).run();

  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS comment_notifications (
      id TEXT PRIMARY KEY,
      comment_id TEXT NOT NULL,
      doc_id TEXT NOT NULL,
      doc_owner_user_id TEXT,
      commenter_user_id TEXT,
      commenter_email TEXT,
      commenter_display_name TEXT,
      commenter_author_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
    )`
  ).run();

  await env.DB.prepare(
    "CREATE INDEX IF NOT EXISTS idx_comment_notifications_doc_created ON comment_notifications(doc_id, created_at DESC)"
  ).run();

  await env.DB.prepare(
    "CREATE INDEX IF NOT EXISTS idx_comment_notifications_owner_created ON comment_notifications(doc_owner_user_id, created_at DESC)"
  ).run();
}

export async function ensureCommentIdentitySchema(env: Env): Promise<void> {
  const envWithCache = env as EnvWithCommentIdentityCache;

  if (!envWithCache[COMMENT_IDENTITY_SCHEMA_PROMISE]) {
    envWithCache[COMMENT_IDENTITY_SCHEMA_PROMISE] = ensureCommentIdentitySchemaUncached(env);
  }

  try {
    await envWithCache[COMMENT_IDENTITY_SCHEMA_PROMISE];
  } catch (error) {
    delete envWithCache[COMMENT_IDENTITY_SCHEMA_PROMISE];
    throw error;
  }
}
