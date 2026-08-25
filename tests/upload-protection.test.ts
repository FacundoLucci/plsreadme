import assert from "node:assert/strict";
import test from "node:test";
import {
  enforceUploadProtection,
  resolveUploadMode,
  UploadProtectionError,
} from "../worker/upload-protection.ts";

class ProtectionDB {
  buckets = new Map<string, number>();

  prepare(sql: string) {
    const db = this;
    return {
      params: [] as unknown[],
      bind(...params: unknown[]) {
        this.params = params;
        return this;
      },
      async run() {
        return { success: true };
      },
      async first<T>() {
        if (sql.includes("MIN(created_at) AS first_seen")) {
          return { first_seen: null, uploads: 0 } as T;
        }
        if (sql.includes("INSERT INTO upload_rate_buckets")) {
          const [scope, actor, windowStart] = this.params as string[];
          const key = `${scope}:${actor}:${windowStart}`;
          const count = (db.buckets.get(key) ?? 0) + 1;
          db.buckets.set(key, count);
          return { count } as T;
        }
        return null;
      },
    };
  }
}

function env(overrides: Record<string, unknown> = {}) {
  return {
    DB: new ProtectionDB(),
    UPLOAD_MODE: "normal",
    UPLOAD_PROTECTION_ENABLED: "true",
    ...overrides,
  } as any;
}

test("upload mode supports normal, accounts-only, off, and KV override", async () => {
  assert.equal(await resolveUploadMode(env({ UPLOAD_MODE: "normal" })), "normal");
  assert.equal(await resolveUploadMode(env({ UPLOAD_MODE: "accounts-only" })), "accounts-only");
  assert.equal(await resolveUploadMode(env({ UPLOAD_MODE: "off" })), "off");
  assert.equal(
    await resolveUploadMode(env({
      UPLOAD_MODE: "normal",
      OAUTH_KV: { get: async () => "accounts-only" },
    })),
    "accounts-only"
  );
});

test("accounts-only keeps account uploads on and blocks anonymous uploads", async () => {
  const testEnv = env({ UPLOAD_MODE: "accounts-only" });
  await assert.rejects(
    enforceUploadProtection(testEnv, { anonymousActorKey: "ip:a" }),
    (error: unknown) => error instanceof UploadProtectionError && error.code === "accounts_only"
  );
  await enforceUploadProtection(testEnv, { userId: "user_1" });
});

test("off mode blocks every new upload", async () => {
  const testEnv = env({ UPLOAD_MODE: "off" });
  await assert.rejects(
    enforceUploadProtection(testEnv, { userId: "user_1" }),
    (error: unknown) => error instanceof UploadProtectionError && error.code === "uploads_disabled"
  );
});

test("anonymous uploads stop after three per IP per hour", async () => {
  const testEnv = env();
  for (let i = 0; i < 3; i += 1) {
    await enforceUploadProtection(testEnv, { anonymousActorKey: "ip:a" });
  }
  await assert.rejects(
    enforceUploadProtection(testEnv, { anonymousActorKey: "ip:a" }),
    (error: unknown) => error instanceof UploadProtectionError && error.code === "upload_rate_limited"
  );
});

test("API keys stop after a five-request minute burst", async () => {
  const testEnv = env();
  for (let i = 0; i < 5; i += 1) {
    await enforceUploadProtection(testEnv, { userId: "user_1", apiKeyId: "key_1" });
  }
  await assert.rejects(
    enforceUploadProtection(testEnv, { userId: "user_1", apiKeyId: "key_1" }),
    (error: unknown) => error instanceof UploadProtectionError && error.code === "upload_rate_limited"
  );
});

test("distributed anonymous uploads trigger the site-wide anonymous ceiling", async () => {
  const testEnv = env();
  for (let i = 0; i < 100; i += 1) {
    await enforceUploadProtection(testEnv, { anonymousActorKey: `ip:${i}` });
  }
  await assert.rejects(
    enforceUploadProtection(testEnv, { anonymousActorKey: "ip:101" }),
    (error: unknown) => error instanceof UploadProtectionError && error.code === "site_upload_limit"
  );
});
