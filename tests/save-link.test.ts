import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { authRoutes } from "../worker/routes/auth.ts";
import type { Env } from "../worker/types.ts";

type QueryRecord = { sql: string; params: unknown[] };

type DocSeed = {
  id: string;
  title: string | null;
  owner_user_id: string | null;
  created_at: string;
  bytes?: number;
  view_count?: number;
  doc_version?: number;
};

class MockDB {
  public runs: QueryRecord[] = [];
  public firsts: QueryRecord[] = [];
  public alls: QueryRecord[] = [];

  private readonly docs = new Map<string, DocSeed>();
  private readonly saved = new Map<string, string>();
  private readonly requestRateLimitCounts = new Map<string, number>();

  constructor(seedDocs: DocSeed[]) {
    for (const doc of seedDocs) {
      this.docs.set(doc.id, {
        ...doc,
        bytes: doc.bytes ?? 100,
        view_count: doc.view_count ?? 0,
        doc_version: doc.doc_version ?? 1,
      });
    }
  }

  private keyForSaved(userId: string, docId: string) {
    return `${userId}:${docId}`;
  }

  prepare(sql: string) {
    const db = this;

    return {
      params: [] as unknown[],
      bind(...params: unknown[]) {
        this.params = params;
        return this;
      },
      async run() {
        db.runs.push({ sql, params: this.params });

        if (/INSERT INTO request_rate_limits/i.test(sql)) {
          const [endpoint, actor] = this.params as [string, string];
          const key = `${endpoint}:${actor}`;
          db.requestRateLimitCounts.set(key, (db.requestRateLimitCounts.get(key) || 0) + 1);
        }

        if (/INSERT INTO saved_links/i.test(sql)) {
          const [userId, docId, createdAt] = this.params as [string, string, string];
          db.saved.set(db.keyForSaved(userId, docId), createdAt);
        }

        return { success: true };
      },
      async first<T>() {
        db.firsts.push({ sql, params: this.params });

        if (/SELECT COUNT\(\*\) as count FROM request_rate_limits/i.test(sql)) {
          const [endpoint, actor] = this.params as [string, string];
          const key = `${endpoint}:${actor}`;
          return { count: db.requestRateLimitCounts.get(key) || 0 } as T;
        }

        if (/SELECT id, title, owner_user_id FROM docs WHERE id = \?/i.test(sql)) {
          const [docId] = this.params as [string];
          return (db.docs.get(docId) || null) as T;
        }

        if (/SELECT created_at FROM saved_links WHERE user_id = \? AND doc_id = \?/i.test(sql)) {
          const [userId, docId] = this.params as [string, string];
          const createdAt = db.saved.get(db.keyForSaved(userId, docId));
          if (!createdAt) return null;
          return { created_at: createdAt } as T;
        }

        if (/COUNT\(\*\) as count FROM docs d WHERE d\.owner_user_id = \?/i.test(sql)) {
          const [userId] = this.params as [string];
          const count = Array.from(db.docs.values()).filter((doc) => doc.owner_user_id === userId).length;
          return { count } as T;
        }

        if (/COUNT\(\*\) as count\s+FROM saved_links sl/i.test(sql)) {
          const [userId] = this.params as [string];
          let count = 0;
          for (const key of db.saved.keys()) {
            const [savedUser, docId] = key.split(":");
            const doc = db.docs.get(docId);
            if (!doc) continue;
            if (savedUser !== userId) continue;
            if (doc.owner_user_id && doc.owner_user_id === userId) continue;
            count += 1;
          }
          return { count } as T;
        }

        return null;
      },
      async all<T>() {
        db.alls.push({ sql, params: this.params });

        if (/FROM docs d/i.test(sql) && /WHERE d\.owner_user_id = \?/i.test(sql)) {
          const [userId] = this.params as [string];
          const rows = Array.from(db.docs.values())
            .filter((doc) => doc.owner_user_id === userId)
            .map((doc) => ({
              id: doc.id,
              title: doc.title,
              created_at: doc.created_at,
              bytes: doc.bytes,
              view_count: doc.view_count,
              doc_version: doc.doc_version,
            }));
          return { results: rows as T };
        }

        if (/FROM saved_links sl/i.test(sql)) {
          const [userId] = this.params as [string];
          const rows = [] as Array<Record<string, unknown>>;

          for (const [key, savedAt] of db.saved.entries()) {
            const [savedUser, docId] = key.split(":");
            if (savedUser !== userId) continue;
            const doc = db.docs.get(docId);
            if (!doc) continue;
            if (doc.owner_user_id && doc.owner_user_id === userId) continue;

            rows.push({
              id: doc.id,
              title: doc.title,
              created_at: doc.created_at,
              bytes: doc.bytes,
              view_count: doc.view_count,
              doc_version: doc.doc_version,
              saved_at: savedAt,
            });
          }

          return { results: rows as T };
        }

        return { results: [] as T };
      },
    };
  }
}

function createEnv(db: MockDB, issuer: string): Env {
  return {
    DB: db as unknown as D1Database,
    DOCS_BUCKET: {} as R2Bucket,
    ANALYTICS: {
      async writeDataPoint() {
        return;
      },
    } as unknown as AnalyticsEngineDataset,
    MCP_OBJECT: {} as DurableObjectNamespace,
    ASSETS: { fetch: async () => new Response("ok") } as Fetcher,
    CLERK_JWT_ISSUER: issuer,
  } as Env;
}

function createSignedJwt({
  issuer,
  subject,
  expiresInSeconds,
}: {
  issuer: string;
  subject: string;
  expiresInSeconds: number;
}) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicJwk = publicKey.export({ format: "jwk" }) as JsonWebKey;

  const header = {
    alg: "RS256",
    typ: "JWT",
    kid: "save-link-test-key",
  };

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: issuer,
    sub: subject,
    sid: "sess_save_link",
    email: "saver@example.com",
    iat: now,
    exp: now + expiresInSeconds,
  };

  const encodedHeader = Buffer.from(JSON.stringify(header)).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const unsigned = `${encodedHeader}.${encodedPayload}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKey).toString("base64url");

  return {
    token: `${unsigned}.${signature}`,
    jwk: {
      kty: "RSA",
      kid: "save-link-test-key",
      alg: "RS256",
      use: "sig",
      n: publicJwk.n,
      e: publicJwk.e,
    },
  };
}

async function withMockedJwks<T>(issuer: string, jwk: Record<string, unknown>, fn: () => Promise<T>) {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url === `${issuer}/.well-known/jwks.json`) {
      return new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return originalFetch(input as any, init);
  };

  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("/api/auth/save-link requires authentication", async () => {
  const issuer = "https://clerk.example.dev/save-link-auth";
  const db = new MockDB([]);
  const env = createEnv(db, issuer);

  const response = await authRoutes.request(
    "http://local/save-link",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "doc_alpha" }),
    },
    env
  );

  assert.equal(response.status, 401);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.code, "auth_required");
});

test("saving a preview link stores saved state and appears in saved section", async () => {
  const issuer = "https://clerk.example.dev/save-link-success";
  const { token, jwk } = createSignedJwt({ issuer, subject: "user_saver", expiresInSeconds: 600 });

  const db = new MockDB([
    {
      id: "doc_created",
      title: "My Own Doc",
      owner_user_id: "user_saver",
      created_at: "2025-01-01T00:00:00.000Z",
      view_count: 3,
    },
    {
      id: "doc_saved",
      title: "Shared Spec",
      owner_user_id: null,
      created_at: "2025-01-02T00:00:00.000Z",
      view_count: 9,
    },
  ]);
  const env = createEnv(db, issuer);

  await withMockedJwks(issuer, jwk, async () => {
    const saveResponse = await authRoutes.request(
      "http://local/save-link",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${token}`,
          "cf-connecting-ip": "203.0.113.20",
        },
        body: JSON.stringify({ id: "doc_saved" }),
      },
      env
    );

    assert.equal(saveResponse.status, 200);
    const saveBody = (await saveResponse.json()) as Record<string, unknown>;
    assert.equal(saveBody.code, "saved");
    assert.equal(saveBody.saved, true);

    const saveStateResponse = await authRoutes.request(
      "http://local/save-link/doc_saved",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
      env
    );

    assert.equal(saveStateResponse.status, 200);
    const stateBody = (await saveStateResponse.json()) as Record<string, unknown>;
    assert.equal(stateBody.saved, true);
    assert.equal(stateBody.createdByUser, false);

    const myLinksResponse = await authRoutes.request(
      "http://local/my-links",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
      env
    );

    assert.equal(myLinksResponse.status, 200);
    const myLinksBody = (await myLinksResponse.json()) as Record<string, any>;
    assert.equal(myLinksBody.created.items.length, 1);
    assert.equal(myLinksBody.created.items[0].id, "doc_created");
    assert.equal(myLinksBody.saved.items.length, 1);
    assert.equal(myLinksBody.saved.items[0].id, "doc_saved");
  });
});

test("saving an owned document returns already_created and does not duplicate", async () => {
  const issuer = "https://clerk.example.dev/save-link-owned";
  const { token, jwk } = createSignedJwt({ issuer, subject: "user_owner", expiresInSeconds: 600 });

  const db = new MockDB([
    {
      id: "doc_owned",
      title: "Owned Doc",
      owner_user_id: "user_owner",
      created_at: "2025-01-01T00:00:00.000Z",
    },
  ]);
  const env = createEnv(db, issuer);

  await withMockedJwks(issuer, jwk, async () => {
    const response = await authRoutes.request(
      "http://local/save-link",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${token}`,
          "cf-connecting-ip": "203.0.113.21",
        },
        body: JSON.stringify({ id: "doc_owned" }),
      },
      env
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.code, "already_created");
    assert.equal(body.createdByUser, true);

    const saveInsertCalls = db.runs.filter((entry) => /INSERT INTO saved_links/i.test(entry.sql));
    assert.equal(saveInsertCalls.length, 0);
  });
});
