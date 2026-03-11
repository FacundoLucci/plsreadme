import type { Env } from "./types";

const OWNERSHIP_SCHEMA_PROMISE = Symbol.for("plsreadme.ownershipSchemaPromise");
const SAVED_LINKS_SCHEMA_PROMISE = Symbol.for("plsreadme.savedLinksSchemaPromise");

type EnvWithOwnershipCache = Env & {
  [OWNERSHIP_SCHEMA_PROMISE]?: Promise<void>;
  [SAVED_LINKS_SCHEMA_PROMISE]?: Promise<void>;
};

function isDuplicateColumnError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /duplicate\s+column\s+name/i.test(error.message);
}

async function ensureOwnershipSchemaUncached(env: Env): Promise<void> {
  try {
    await env.DB.prepare("ALTER TABLE docs ADD COLUMN owner_user_id TEXT").run();
  } catch (error) {
    if (!isDuplicateColumnError(error)) {
      throw error;
    }
  }

  await env.DB.prepare(
    "CREATE INDEX IF NOT EXISTS idx_docs_owner_user_id ON docs(owner_user_id)"
  ).run();

  await env.DB.prepare(
    "CREATE INDEX IF NOT EXISTS idx_docs_owner_created_at ON docs(owner_user_id, created_at DESC)"
  ).run();
}

async function ensureSavedLinksSchemaUncached(env: Env): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS saved_links (
      user_id TEXT NOT NULL,
      doc_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, doc_id)
    )`
  ).run();

  await env.DB.prepare(
    "CREATE INDEX IF NOT EXISTS idx_saved_links_user_created_at ON saved_links(user_id, created_at DESC)"
  ).run();

  await env.DB.prepare(
    "CREATE INDEX IF NOT EXISTS idx_saved_links_doc_user ON saved_links(doc_id, user_id)"
  ).run();
}

export async function ensureOwnershipSchema(env: Env): Promise<void> {
  const envWithCache = env as EnvWithOwnershipCache;

  if (!envWithCache[OWNERSHIP_SCHEMA_PROMISE]) {
    envWithCache[OWNERSHIP_SCHEMA_PROMISE] = ensureOwnershipSchemaUncached(env);
  }

  try {
    await envWithCache[OWNERSHIP_SCHEMA_PROMISE];
  } catch (error) {
    delete envWithCache[OWNERSHIP_SCHEMA_PROMISE];
    throw error;
  }
}

export async function ensureSavedLinksSchema(env: Env): Promise<void> {
  const envWithCache = env as EnvWithOwnershipCache;

  if (!envWithCache[SAVED_LINKS_SCHEMA_PROMISE]) {
    envWithCache[SAVED_LINKS_SCHEMA_PROMISE] = ensureSavedLinksSchemaUncached(env);
  }

  try {
    await envWithCache[SAVED_LINKS_SCHEMA_PROMISE];
  } catch (error) {
    delete envWithCache[SAVED_LINKS_SCHEMA_PROMISE];
    throw error;
  }
}
