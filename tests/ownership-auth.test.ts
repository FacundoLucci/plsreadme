import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { linksRoutes } from "../worker/routes/links.ts";
import { docsRoutes } from "../worker/routes/docs.ts";

type QueryRecord = { sql: string; params: unknown[] };

class MockDB {
  public preparedSql: string[] = [];
  public runs: QueryRecord[] = [];
  public firsts: QueryRecord[] = [];
  public rateCount = 0;
  public docForAdminToken: Record<string, unknown> | null = null;

  prepare(sql: string) {
    this.preparedSql.push(sql);
    const db = this;

    return {
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

        if (sql.includes("SELECT COUNT(*) as count FROM request_rate_limits")) {
          return { count: db.rateCount } as T;
        }

        if (sql.includes("SELECT * FROM docs WHERE id = ? AND admin_token = ?")) {
          return db.docForAdminToken as T;
        }

        return null;
      },
      async all() {
        return { results: [] };
      },
    };
  }
}

class MockBucket {
  public puts: Array<{ key: string; body: string }> = [];
  private objects = new Map<string, string>();

  constructor(seed: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(seed)) {
      this.objects.set(key, value);
    }
  }

  async put(key: string, body: unknown) {
    const textBody = String(body);
    this.puts.push({ key, body: textBody });
    this.objects.set(key, textBody);
  }

  async get(key: string) {
    const value = this.objects.get(key);
    if (value === undefined) {
      return null;
    }

    return {
      async text() {
        return value;
      },
    };
  }

  async delete(key: string) {
    this.objects.delete(key);
  }
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
    kid: "test-key-ownership",
  };

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: issuer,
    sub: subject,
    sid: "sess_ownership",
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
      kid: "test-key-ownership",
      alg: "RS256",
      use: "sig",
      n: publicJwk.n,
      e: publicJwk.e,
    },
  };
}

function createEnv(db: MockDB, bucket: MockBucket, issuer: string) {
  return {
    DB: db,
    DOCS_BUCKET: bucket,
    ANALYTICS: {
      async writeDataPoint() {
        return;
      },
    },
    MCP_OBJECT: {} as DurableObjectNamespace,
    ASSETS: { fetch: async () => new Response("ok") } as Fetcher,
    CLERK_JWT_ISSUER: issuer,
  } as any;
}

async function withMockedJwks<T>(
  issuer: string,
  jwk: Record<string, unknown>,
  fn: () => Promise<T>
): Promise<T> {
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

test("authenticated create-link assigns owner_user_id", async () => {
  const issuer = "https://clerk.example.dev/links";
  const { token, jwk } = createSignedJwt({
    issuer,
    subject: "user_link_owner",
    expiresInSeconds: 600,
  });

  const db = new MockDB();
  const bucket = new MockBucket();
  const env = createEnv(db, bucket, issuer);

  const markdown = "# Owned link\nhello";
  const body = JSON.stringify({ markdown });

  const response = await withMockedJwks(issuer, jwk, async () =>
    linksRoutes.request(
      "http://local/",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(new TextEncoder().encode(body).length),
          authorization: `Bearer ${token}`,
        },
        body,
      },
      env
    )
  );

  assert.equal(response.status, 200);

  const docsInsert = db.runs.find((entry) =>
    entry.sql.startsWith("INSERT INTO docs (id, r2_key, content_type, bytes, created_at, sha256, title, view_count, owner_user_id)")
  );

  assert.ok(docsInsert, "expected docs insert query");
  assert.equal(docsInsert?.params[8], "user_link_owner");
});

test("authenticated update of legacy anonymous doc backfills owner_user_id", async () => {
  const issuer = "https://clerk.example.dev/update";
  const { token, jwk } = createSignedJwt({
    issuer,
    subject: "user_owner",
    expiresInSeconds: 600,
  });

  const db = new MockDB();
  db.docForAdminToken = {
    id: "doc123",
    r2_key: "md/doc123.md",
    content_type: "text/markdown",
    bytes: 100,
    created_at: new Date().toISOString(),
    sha256: "abc",
    title: "Legacy",
    view_count: 0,
    admin_token: "sk_doc123",
    doc_version: 1,
    owner_user_id: null,
  };

  const bucket = new MockBucket({ "md/doc123.md": "# old" });
  const env = createEnv(db, bucket, issuer);

  const markdown = "# New title\nUpdated content";
  const body = JSON.stringify({ markdown });

  const response = await withMockedJwks(issuer, jwk, async () =>
    docsRoutes.request(
      "http://local/doc123",
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "content-length": String(new TextEncoder().encode(body).length),
          authorization: "Bearer sk_doc123",
          cookie: `__session=${encodeURIComponent(token)}`,
        },
        body,
      },
      env
    )
  );

  assert.equal(response.status, 200);

  const docsUpdate = db.runs.find((entry) => entry.sql.startsWith("UPDATE docs SET bytes = ?, sha256 = ?, title = ?, doc_version = ?, owner_user_id = COALESCE(owner_user_id, ?) WHERE id = ?"));
  assert.ok(docsUpdate, "expected docs update query");
  assert.equal(docsUpdate?.params[4], "user_owner");
});

test("cross-user owned doc mutation is denied", async () => {
  const issuer = "https://clerk.example.dev/cross-user";
  const { token, jwk } = createSignedJwt({
    issuer,
    subject: "user_intruder",
    expiresInSeconds: 600,
  });

  const db = new MockDB();
  db.docForAdminToken = {
    id: "doc777",
    r2_key: "md/doc777.md",
    content_type: "text/markdown",
    bytes: 100,
    created_at: new Date().toISOString(),
    sha256: "abc",
    title: "Owned",
    view_count: 0,
    admin_token: "sk_doc777",
    doc_version: 2,
    owner_user_id: "user_owner",
  };

  const bucket = new MockBucket({ "md/doc777.md": "# owned" });
  const env = createEnv(db, bucket, issuer);

  const markdown = "# Hacked\nNope";
  const body = JSON.stringify({ markdown });

  const response = await withMockedJwks(issuer, jwk, async () =>
    docsRoutes.request(
      "http://local/doc777",
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "content-length": String(new TextEncoder().encode(body).length),
          authorization: "Bearer sk_doc777",
          cookie: `__session=${encodeURIComponent(token)}`,
        },
        body,
      },
      env
    )
  );

  assert.equal(response.status, 403);
  const payload = (await response.json()) as Record<string, unknown>;
  assert.equal(payload.code, "owner_mismatch");

  const docsUpdateRan = db.runs.some((entry) =>
    entry.sql.startsWith("UPDATE docs SET bytes = ?, sha256 = ?, title = ?, doc_version = ?, owner_user_id = COALESCE(owner_user_id, ?) WHERE id = ?")
  );
  assert.equal(docsUpdateRan, false);
});
