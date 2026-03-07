import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { authRoutes } from "../worker/routes/auth.ts";
import type { Env } from "../worker/types.ts";

type QueryRecord = { sql: string; params: unknown[] };

class MockDB {
  public runs: QueryRecord[] = [];
  public firsts: QueryRecord[] = [];
  public alls: QueryRecord[] = [];
  public count: number;
  public rows: Array<Record<string, unknown>>;

  constructor({ count, rows }: { count: number; rows: Array<Record<string, unknown>> }) {
    this.count = count;
    this.rows = rows;
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
        return { success: true };
      },
      async first<T>() {
        db.firsts.push({ sql, params: this.params });
        if (/COUNT\(\*\)/i.test(sql)) {
          return { count: db.count } as T;
        }
        return null;
      },
      async all<T>() {
        db.alls.push({ sql, params: this.params });
        return { results: db.rows as T };
      },
    };

    return statement;
  }
}

function createEnv(db: MockDB, issuer: string) {
  return {
    DB: db,
    DOCS_BUCKET: {} as R2Bucket,
    ANALYTICS: {
      async writeDataPoint() {
        return;
      },
    },
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
    kid: "my-links-test-key",
  };

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: issuer,
    sub: subject,
    sid: "sess_my_links",
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
      kid: "my-links-test-key",
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

test("/api/auth/my-links requires authentication", async () => {
  const db = new MockDB({ count: 0, rows: [] });
  const env = createEnv(db, "https://clerk.example.dev/my-links");

  const response = await authRoutes.request("http://local/my-links", { method: "GET" }, env);

  assert.equal(response.status, 401);
  const payload = (await response.json()) as Record<string, unknown>;
  assert.equal(payload.code, "auth_required");
});

test("/api/auth/my-links returns owner rows with search + pagination", async () => {
  const issuer = "https://clerk.example.dev/my-links";
  const { token, jwk } = createSignedJwt({ issuer, subject: "user_123", expiresInSeconds: 600 });

  const rows = [
    {
      id: "doc_alpha",
      title: "Alpha Spec",
      created_at: "2025-01-02T00:00:00.000Z",
      bytes: 2048,
      view_count: 42,
      doc_version: 3,
    },
  ];

  const db = new MockDB({ count: 7, rows });
  const env = createEnv(db, issuer);
  const url = "http://local/my-links?page=2&page_size=5&sort=title_asc&search=alpha";

  const response = await withMockedJwks(issuer, jwk, () =>
    authRoutes.request(
      url,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
      env
    )
  );

  assert.equal(response.status, 200);
  const payload = (await response.json()) as Record<string, any>;

  assert.equal(Array.isArray(payload.items), true);
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].id, "doc_alpha");
  assert.equal(payload.items[0].slug, "alpha-spec");
  assert.equal(payload.items[0].url.endsWith("/v/doc_alpha"), true);

  assert.deepEqual(payload.pagination, {
    page: 2,
    pageSize: 5,
    total: 7,
    totalPages: 2,
    hasNextPage: false,
    hasPrevPage: true,
  });

  const countQuery = db.firsts.find((entry) => /COUNT\(\*\)/i.test(entry.sql));
  assert.ok(countQuery, "expected count query to run");
  assert.deepEqual(countQuery?.params, ["user_123", "%alpha%", "%alpha%", "%alpha%"]);

  const listQuery = db.alls[0];
  assert.ok(listQuery, "expected list query to run");
  assert.deepEqual(listQuery.params, ["user_123", "%alpha%", "%alpha%", "%alpha%", 5, 5]);
});
