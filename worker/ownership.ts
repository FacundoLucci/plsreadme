import type { Env } from "./types";

const OWNERSHIP_SCHEMA_PROMISE = Symbol.for("plsreadme.ownershipSchemaPromise");

type EnvWithOwnershipCache = Env & {
  [OWNERSHIP_SCHEMA_PROMISE]?: Promise<void>;
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
