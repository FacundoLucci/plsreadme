import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { authRoutes } from "../worker/routes/auth.ts";
import type { Env } from "../worker/types.ts";

type QueryRecord = { sql: string; params: unknown[] };

type MockDoc = {
  id: string;
  title: string | null;
  owner_user_id: string | null;
  admin_token: string | null;
};

class MockDB {
  public runs: QueryRecord[] = [];
  public firsts: QueryRecord[] = [];
  private docs = new Map<string, MockDoc>();
  private claimRateLimitCount = 0;

  constructor(docs: MockDoc[]) {
    for (const doc of docs) {
      this.docs.set(doc.id, { ...doc });
    }
  }

  getDoc(id: string): MockDoc | null {
    return this.docs.get(id) ?? null;
  }

  prepare(sql: string) {
    const db = this;
    const statement = {
      params: [] as unknown[],
      bind(...params: unknown[]) {
        this.params = params;
        return this;
      },
      async run() {
        db.runs.push({ sql, params: this.params });

        if (/INSERT INTO request_rate_limits/i.test(sql)) {
          db.claimRateLimitCount += 1;
        }

        if (/UPDATE docs SET owner_user_id = \? WHERE id = \? AND owner_user_id IS NULL/i.test(sql)) {
          const [ownerUserId, docId] = this.params as [string, string];
          const existing = db.docs.get(docId);
          if (existing && !existing.owner_user_id) {
            existing.owner_user_id = ownerUserId;
          }
        }

        return { success: true };
      },
      async first<T>() {
        db.firsts.push({ sql, params: this.params });

        if (/SELECT COUNT\(\*\) as count FROM request_rate_limits/i.test(sql)) {
          return { count: db.claimRateLimitCount } as T;
        }

        if (/SELECT id, title, owner_user_id, admin_token FROM docs WHERE id = \?/i.test(sql)) {
          const [docId] = this.params as [string];
          return (db.docs.get(docId) ?? null) as T;
        }

        if (/SELECT owner_user_id FROM docs WHERE id = \?/i.test(sql)) {
          const [docId] = this.params as [string];
          const doc = db.docs.get(docId);
          if (!doc) return null;
          return { owner_user_id: doc.owner_user_id } as T;
        }

        return null;
      },
      async all<T>() {
        return { results: [] as T };
      },
    };

    return statement;
  }
}

class MockAnalytics {
  public calls: unknown[] = [];

  async writeDataPoint(payload: unknown) {
    this.calls.push(payload);
  }
}

function createEnv(db: MockDB, analytics: MockAnalytics, issuer: string): Env {
  return {
    DB: db as unknown as D1Database,
    DOCS_BUCKET: {} as R2Bucket,
    ANALYTICS: analytics as unknown as AnalyticsEngineDataset,
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
    kid: "claim-test-key",
  };

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: issuer,
    sub: subject,
    sid: "sess_claim",
    email: "owner@example.com",
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
      kid: "claim-test-key",
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

async function postClaim({
  env,
  token,
  body,
}: {
  env: Env;
  token?: string;
  body: Record<string, unknown>;
}) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return authRoutes.request(
    "http://local/claim-link",
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
    env
  );
}

test("/api/auth/claim-link requires auth", async () => {
  const issuer = "https://clerk.example.dev/claim";
  const db = new MockDB([]);
  const analytics = new MockAnalytics();
  const env = createEnv(db, analytics, issuer);

  const response = await postClaim({
    env,
    body: { id: "doc_123456", adminToken: "sk_validtoken_123" },
  });

  assert.equal(response.status, 401);
  const payload = (await response.json()) as Record<string, unknown>;
  assert.equal(payload.code, "auth_required");
});

test("/api/auth/claim-link claims unowned legacy doc with valid token", async () => {
  const issuer = "https://clerk.example.dev/claim-success";
  const { token, jwk } = createSignedJwt({ issuer, subject: "user_claimer", expiresInSeconds: 600 });

  const db = new MockDB([
    {
      id: "doc_claimable",
      title: "Legacy Spec",
      owner_user_id: null,
      admin_token: "sk_legacy_claim_token_12345",
    },
  ]);
  const analytics = new MockAnalytics();
  const env = createEnv(db, analytics, issuer);

  const response = await withMockedJwks(issuer, jwk, () =>
    postClaim({
      env,
      token,
      body: { id: "doc_claimable", adminToken: "sk_legacy_claim_token_12345" },
    })
  );

  assert.equal(response.status, 200);
  const payload = (await response.json()) as Record<string, unknown>;
  assert.equal(payload.claimed, true);
  assert.equal(payload.code, "claimed");
  assert.equal(db.getDoc("doc_claimable")?.owner_user_id, "user_claimer");
  assert.equal(analytics.calls.length, 1);
});

test("/api/auth/claim-link rejects invalid admin token", async () => {
  const issuer = "https://clerk.example.dev/claim-invalid-proof";
  const { token, jwk } = createSignedJwt({ issuer, subject: "user_claimer", expiresInSeconds: 600 });

  const db = new MockDB([
    {
      id: "doc_claimable",
      title: "Legacy Spec",
      owner_user_id: null,
      admin_token: "sk_real_token_12345",
    },
  ]);
  const analytics = new MockAnalytics();
  const env = createEnv(db, analytics, issuer);

  const response = await withMockedJwks(issuer, jwk, () =>
    postClaim({
      env,
      token,
      body: { id: "doc_claimable", adminToken: "sk_wrong_token_12345" },
    })
  );

  assert.equal(response.status, 403);
  const payload = (await response.json()) as Record<string, unknown>;
  assert.equal(payload.code, "invalid_claim_proof");
  assert.equal(db.getDoc("doc_claimable")?.owner_user_id, null);
  assert.equal(analytics.calls.length, 0);
});

test("/api/auth/claim-link blocks claiming links owned by another user", async () => {
  const issuer = "https://clerk.example.dev/claim-owner-mismatch";
  const { token, jwk } = createSignedJwt({ issuer, subject: "user_intruder", expiresInSeconds: 600 });

  const db = new MockDB([
    {
      id: "doc_owned",
      title: "Owned Doc",
      owner_user_id: "user_original_owner",
      admin_token: "sk_owned_token_12345",
    },
  ]);
  const analytics = new MockAnalytics();
  const env = createEnv(db, analytics, issuer);

  const response = await withMockedJwks(issuer, jwk, () =>
    postClaim({
      env,
      token,
      body: { id: "doc_owned", adminToken: "sk_owned_token_12345" },
    })
  );

  assert.equal(response.status, 403);
  const payload = (await response.json()) as Record<string, unknown>;
  assert.equal(payload.code, "owner_mismatch");
  assert.equal(db.getDoc("doc_owned")?.owner_user_id, "user_original_owner");
});

test("/api/auth/claim-link returns already_owned for same owner", async () => {
  const issuer = "https://clerk.example.dev/claim-already-owned";
  const { token, jwk } = createSignedJwt({ issuer, subject: "user_claimer", expiresInSeconds: 600 });

  const db = new MockDB([
    {
      id: "doc_owned",
      title: "Already Mine",
      owner_user_id: "user_claimer",
      admin_token: "sk_owned_token_12345",
    },
  ]);
  const analytics = new MockAnalytics();
  const env = createEnv(db, analytics, issuer);

  const response = await withMockedJwks(issuer, jwk, () =>
    postClaim({
      env,
      token,
      body: { id: "doc_owned", adminToken: "sk_owned_token_12345" },
    })
  );

  assert.equal(response.status, 200);
  const payload = (await response.json()) as Record<string, unknown>;
  assert.equal(payload.claimed, false);
  assert.equal(payload.code, "already_owned");
  assert.equal(analytics.calls.length, 0);
});

test("/api/auth/claim-link validates malformed payload", async () => {
  const issuer = "https://clerk.example.dev/claim-malformed";
  const { token, jwk } = createSignedJwt({ issuer, subject: "user_claimer", expiresInSeconds: 600 });

  const db = new MockDB([]);
  const analytics = new MockAnalytics();
  const env = createEnv(db, analytics, issuer);

  const response = await withMockedJwks(issuer, jwk, () =>
    postClaim({
      env,
      token,
      body: { id: "../../etc/passwd", adminToken: "not-a-token" },
    })
  );

  assert.equal(response.status, 400);
  const payload = (await response.json()) as Record<string, unknown>;
  assert.equal(payload.code, "invalid_claim_payload");
});
