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
  public createdCount: number;
  public savedCount: number;
  public createdRows: Array<Record<string, unknown>>;
  public savedRows: Array<Record<string, unknown>>;

  constructor({
    createdCount,
    savedCount,
    createdRows,
    savedRows,
  }: {
    createdCount: number;
    savedCount: number;
    createdRows: Array<Record<string, unknown>>;
    savedRows: Array<Record<string, unknown>>;
  }) {
    this.createdCount = createdCount;
    this.savedCount = savedCount;
    this.createdRows = createdRows;
    this.savedRows = savedRows;
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

        if (/COUNT\(\*\) as count FROM docs d/i.test(sql)) {
          return { count: db.createdCount } as T;
        }

        if (/COUNT\(\*\) as count\s+FROM saved_links sl/i.test(sql)) {
          return { count: db.savedCount } as T;
        }

        return null;
      },
      async all<T>() {
        db.alls.push({ sql, params: this.params });

        if (/FROM docs d/i.test(sql) && /WHERE d\.owner_user_id = \?/i.test(sql)) {
          return { results: db.createdRows as T };
        }

        if (/FROM saved_links sl/i.test(sql)) {
          return { results: db.savedRows as T };
        }

        return { results: [] as T };
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
  const db = new MockDB({ createdCount: 0, savedCount: 0, createdRows: [], savedRows: [] });
  const env = createEnv(db, "https://clerk.example.dev/my-links");

  const response = await authRoutes.request("http://local/my-links", { method: "GET" }, env);

  assert.equal(response.status, 401);
  const payload = (await response.json()) as Record<string, unknown>;
  assert.equal(payload.code, "auth_required");
});

test("/api/auth/my-links returns separated created and saved rows with shared search/sort", async () => {
  const issuer = "https://clerk.example.dev/my-links";
  const { token, jwk } = createSignedJwt({ issuer, subject: "user_123", expiresInSeconds: 600 });

  const createdRows = [
    {
      id: "doc_created",
      title: "Alpha Spec",
      created_at: "2025-01-02T00:00:00.000Z",
      bytes: 2048,
      view_count: 42,
      doc_version: 3,
    },
  ];

  const savedRows = [
    {
      id: "doc_saved",
      title: "Beta Notes",
      created_at: "2025-01-01T00:00:00.000Z",
      bytes: 1024,
      view_count: 7,
      doc_version: 1,
      saved_at: "2025-01-03T00:00:00.000Z",
    },
  ];

  const db = new MockDB({
    createdCount: 7,
    savedCount: 2,
    createdRows,
    savedRows,
  });
  const env = createEnv(db, issuer);
  const url = "http://local/my-links?page=2&page_size=5&sort=title_asc&search=alpha-spec";

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

  assert.equal(payload.created.items.length, 1);
  assert.equal(payload.created.items[0].id, "doc_created");
  assert.equal(payload.created.items[0].relationship, "created");

  assert.equal(payload.saved.items.length, 1);
  assert.equal(payload.saved.items[0].id, "doc_saved");
  assert.equal(payload.saved.items[0].relationship, "saved");

  assert.deepEqual(payload.created.pagination, {
    page: 2,
    pageSize: 5,
    total: 7,
    totalPages: 2,
    hasNextPage: false,
    hasPrevPage: true,
  });

  assert.deepEqual(payload.saved.pagination, {
    page: 2,
    pageSize: 5,
    total: 2,
    totalPages: 1,
    hasNextPage: false,
    hasPrevPage: true,
  });

  assert.deepEqual(payload.totals, {
    created: 7,
    saved: 2,
    all: 9,
  });

  const createdListQuery = db.alls.find((entry) => /FROM docs d/i.test(entry.sql));
  assert.ok(createdListQuery, "expected created links query");
  assert.match(createdListQuery?.sql ?? "", /WHERE d\.owner_user_id = \?/i);
  assert.match(createdListQuery?.sql ?? "", /ORDER BY COALESCE\(d\.title, ''\) COLLATE NOCASE ASC/i);

  const savedListQuery = db.alls.find((entry) => /FROM saved_links sl/i.test(entry.sql));
  assert.ok(savedListQuery, "expected saved links query");
  assert.match(savedListQuery?.sql ?? "", /sl\.user_id = \?/i);
  assert.match(savedListQuery?.sql ?? "", /d\.owner_user_id IS NULL OR d\.owner_user_id <> \?/i);
  assert.match(savedListQuery?.sql ?? "", /ORDER BY COALESCE\(d\.title, ''\) COLLATE NOCASE ASC/i);
});
