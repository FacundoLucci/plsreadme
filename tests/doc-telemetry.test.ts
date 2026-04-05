import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { linksRoutes } from "../worker/routes/links.ts";
import { docsRoutes } from "../worker/routes/docs.ts";

type QueryRecord = { sql: string; params: unknown[] };

class MockBucket {
  public puts: Array<{ key: string; body: string; options?: Record<string, unknown> }> = [];
  private objects = new Map<string, string>();

  constructor(seed: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(seed)) {
      this.objects.set(key, value);
    }
  }

  async put(key: string, body: unknown, options?: Record<string, unknown>) {
    const textBody = String(body);
    this.puts.push({ key, body: textBody, options });
    this.objects.set(key, textBody);
  }

  async get(key: string) {
    const value = this.objects.get(key);
    if (value === undefined) return null;

    return {
      async text() {
        return value;
      },
    };
  }
}

class MockDB {
  public firsts: QueryRecord[] = [];
  public runs: QueryRecord[] = [];
  public rateCount = 0;
  public docRow: Record<string, unknown> | null = null;

  prepare(sql: string) {
    const db = this;

    return {
      params: [] as unknown[],
      bind(...params: unknown[]) {
        this.params = params;
        return this;
      },
      async first<T>() {
        db.firsts.push({ sql, params: this.params });

        if (sql.includes("SELECT COUNT(*) as count FROM request_rate_limits")) {
          return { count: db.rateCount } as T;
        }

        if (sql.includes("SELECT COUNT(*) as count FROM docs WHERE owner_user_id = ?")) {
          return { count: 0 } as T;
        }

        if (sql.includes("SELECT * FROM docs WHERE id = ?")) {
          return db.docRow as T;
        }

        return null as T;
      },
      async run() {
        db.runs.push({ sql, params: this.params });
        return { success: true };
      },
      async all() {
        return { results: [] };
      },
    };
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
    kid: "doc-telemetry-test-key",
  };

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: issuer,
    sub: subject,
    sid: "sess_doc_telemetry",
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
      kid: "doc-telemetry-test-key",
      alg: "RS256",
      use: "sig",
      n: publicJwk.n,
      e: publicJwk.e,
    },
  };
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

function createEnv(db: MockDB, bucket: MockBucket, issuer = "https://clerk.example.dev/doc-telemetry") {
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

test("authenticated web creates record doc_create_events attribution and custom metadata", async () => {
  const issuer = "https://clerk.example.dev/doc-telemetry-create";
  const { token, jwk } = createSignedJwt({
    issuer,
    subject: "user_link_owner",
    expiresInSeconds: 600,
  });

  const db = new MockDB();
  const bucket = new MockBucket();
  const env = createEnv(db, bucket, issuer);
  const body = JSON.stringify({ markdown: "# Owned link\nhello" });

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

  const attributionInsert = db.runs.find((entry) =>
    entry.sql.startsWith("INSERT OR REPLACE INTO doc_create_events")
  );
  assert.ok(attributionInsert, "expected doc_create_events insert");
  assert.equal(attributionInsert?.params[2], "web_signed_in");
  assert.equal(attributionInsert?.params[3], "clerk_session");
  assert.equal(attributionInsert?.params[5], "website");
  assert.equal(attributionInsert?.params[6], "user_link_owner");
  assert.equal(attributionInsert?.params[7], "owner@example.com");

  const customMetadata = bucket.puts[0]?.options?.customMetadata as Record<string, string>;
  assert.equal(customMetadata.created_source, "web_signed_in");
  assert.equal(customMetadata.auth_mode, "clerk_session");
  assert.equal(customMetadata.client_name, "website");
  assert.equal(customMetadata.owner_user_id, "user_link_owner");
});

test("document page tracks raw and likely-human views separately", async () => {
  const db = new MockDB();
  db.docRow = {
    id: "doc_human_view",
    r2_key: "md/doc_human_view.md",
    content_type: "text/markdown",
    bytes: 10,
    created_at: new Date().toISOString(),
    sha256: "abc",
    title: "Human view",
    view_count: 2,
    raw_view_count: 5,
    admin_token: null,
    doc_version: 1,
    owner_user_id: null,
  };
  const bucket = new MockBucket({ "md/doc_human_view.md": "# hello" });
  const env = createEnv(db, bucket);

  const response = await docsRoutes.request(
    "http://local/doc_human_view",
    {
      method: "GET",
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)",
        "sec-fetch-dest": "document",
      },
    },
    env
  );

  assert.equal(response.status, 200);
  const viewUpdate = db.runs.find((entry) =>
    entry.sql.includes("raw_view_count = COALESCE(raw_view_count, 0) + 1, view_count = view_count + 1")
  );
  assert.ok(viewUpdate, "expected likely-human view update");
});

test("bot and unfurl traffic only increments raw_view_count", async () => {
  const db = new MockDB();
  db.docRow = {
    id: "doc_bot_view",
    r2_key: "md/doc_bot_view.md",
    content_type: "text/markdown",
    bytes: 10,
    created_at: new Date().toISOString(),
    sha256: "abc",
    title: "Bot view",
    view_count: 2,
    raw_view_count: 5,
    admin_token: null,
    doc_version: 1,
    owner_user_id: null,
  };
  const bucket = new MockBucket({ "md/doc_bot_view.md": "# hello" });
  const env = createEnv(db, bucket);

  const response = await docsRoutes.request(
    "http://local/doc_bot_view",
    {
      method: "GET",
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "Slackbot 1.0",
      },
    },
    env
  );

  assert.equal(response.status, 200);
  const rawOnlyUpdate = db.runs.find((entry) =>
    entry.sql === "UPDATE docs SET raw_view_count = COALESCE(raw_view_count, 0) + 1 WHERE id = ?"
  );
  assert.ok(rawOnlyUpdate, "expected raw-only view update");
});
