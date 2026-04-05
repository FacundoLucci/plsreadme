import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { authRoutes } from "../worker/routes/auth.ts";
import { docsRoutes } from "../worker/routes/docs.ts";
import type { Env } from "../worker/types.ts";

interface ApiKeyRow {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  token_prefix: string;
  created_at: string;
  last_used_at: string | null;
  last_used_source: string | null;
  revoked_at: string | null;
}

interface DocRow {
  id: string;
  owner_user_id: string | null;
  title: string | null;
}

class MockBucket {
  public puts: Array<{ key: string; body: string; options?: Record<string, unknown> }> = [];

  async put(key: string, body: unknown, options?: Record<string, unknown>) {
    this.puts.push({ key, body: String(body), options });
  }
}

class MockDB {
  public apiKeys: ApiKeyRow[] = [];
  public docs: DocRow[] = [];

  prepare(sql: string) {
    const db = this;
    return {
      params: [] as unknown[],
      bind(...params: unknown[]) {
        this.params = params;
        return this;
      },
      async run() {
        if (/CREATE TABLE|CREATE INDEX|ALTER TABLE/i.test(sql)) {
          return { success: true };
        }

        if (sql.startsWith("INSERT INTO mcp_api_keys")) {
          const [id, userId, name, tokenHash, tokenPrefix, createdAt] = this.params as string[];
          db.apiKeys.push({
            id,
            user_id: userId,
            name,
            token_hash: tokenHash,
            token_prefix: tokenPrefix,
            created_at: createdAt,
            last_used_at: null,
            last_used_source: null,
            revoked_at: null,
          });
          return { success: true };
        }

        if (sql.startsWith("UPDATE mcp_api_keys SET revoked_at")) {
          const [revokedAt, keyId] = this.params as string[];
          const row = db.apiKeys.find((item) => item.id === keyId);
          if (row) row.revoked_at = revokedAt;
          return { success: true };
        }

        if (sql.startsWith("UPDATE mcp_api_keys SET last_used_at")) {
          const [lastUsedAt, lastUsedSource, keyId] = this.params as string[];
          const row = db.apiKeys.find((item) => item.id === keyId);
          if (row) {
            row.last_used_at = lastUsedAt;
            row.last_used_source = lastUsedSource;
          }
          return { success: true };
        }

        if (sql.startsWith("INSERT INTO docs")) {
          const [id, , , , , , title, , ownerUserId] = this.params as Array<string | null>;
          db.docs.push({
            id: String(id),
            owner_user_id: ownerUserId ?? null,
            title: typeof title === "string" ? title : null,
          });
          return { success: true };
        }

        return { success: true };
      },
      async first<T>() {
        if (sql.includes("FROM mcp_api_keys") && sql.includes("WHERE id = ? AND user_id = ?")) {
          const [keyId, userId] = this.params as string[];
          return (db.apiKeys.find((item) => item.id === keyId && item.user_id === userId) ?? null) as T;
        }

        if (sql.includes("FROM mcp_api_keys") && sql.includes("WHERE token_hash = ?")) {
          const [tokenHash] = this.params as string[];
          return (db.apiKeys.find((item) => item.token_hash === tokenHash) ?? null) as T;
        }

        if (sql.includes("COUNT(*) as count FROM docs WHERE owner_user_id = ?")) {
          const [userId] = this.params as string[];
          const count = db.docs.filter((item) => item.owner_user_id === userId).length;
          return { count } as T;
        }

        return null as T;
      },
      async all<T>() {
        if (sql.includes("FROM mcp_api_keys") && sql.includes("WHERE user_id = ?")) {
          const [userId] = this.params as string[];
          return {
            results: db.apiKeys
              .filter((item) => item.user_id === userId)
              .sort((a, b) => b.created_at.localeCompare(a.created_at)),
          } as { results: T[] };
        }

        return { results: [] as T[] };
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
    kid: "mcp-api-key-test-key",
  };

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: issuer,
    sub: subject,
    sid: "sess_mcp_api_key",
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
      kid: "mcp-api-key-test-key",
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

function createEnv(issuer: string, db: MockDB): Env {
  return {
    DB: db as unknown as D1Database,
    DOCS_BUCKET: new MockBucket() as unknown as R2Bucket,
    ANALYTICS: {
      async writeDataPoint() {
        return;
      },
    } as AnalyticsEngineDataset,
    MCP_OBJECT: {} as DurableObjectNamespace,
    ASSETS: { fetch: async () => new Response("ok") } as Fetcher,
    CLERK_JWT_ISSUER: issuer,
  } as Env;
}

test("/api/auth/mcp-api-keys issues, lists, and revokes personal MCP API keys", async () => {
  const issuer = "https://clerk.example.dev/mcp-api-keys";
  const { token, jwk } = createSignedJwt({
    issuer,
    subject: "user_api_keys",
    expiresInSeconds: 600,
  });
  const db = new MockDB();
  const env = createEnv(issuer, db);

  const createResponse = await withMockedJwks(issuer, jwk, () =>
    authRoutes.request(
      "http://local/mcp-api-keys",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "Claude Desktop" }),
      },
      env
    )
  );

  assert.equal(createResponse.status, 201);
  const created = (await createResponse.json()) as Record<string, any>;
  assert.match(created.token, /^plsr_pk_/);
  assert.equal(created.key.name, "Claude Desktop");
  assert.match(created.key.revokeUrl, /\/api\/auth\/mcp-api-keys\/mk_/);

  const listResponse = await withMockedJwks(issuer, jwk, () =>
    authRoutes.request(
      "http://local/mcp-api-keys",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
      env
    )
  );

  assert.equal(listResponse.status, 200);
  const listed = (await listResponse.json()) as Record<string, any>;
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].name, "Claude Desktop");
  assert.equal(listed.items[0].lastUsedAt, null);
  assert.equal(listed.guidance.localEnvVar, "PLSREADME_API_KEY");

  const revokeResponse = await withMockedJwks(issuer, jwk, () =>
    authRoutes.request(
      `http://local/mcp-api-keys/${created.key.id}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
      env
    )
  );

  assert.equal(revokeResponse.status, 200);
  const revoked = (await revokeResponse.json()) as Record<string, any>;
  assert.equal(revoked.ok, true);
  assert.equal(revoked.revoked, true);
  assert.ok(revoked.key.revokedAt);
});

test("/api/render treats a valid personal API key as an owned local MCP create", async () => {
  const issuer = "https://clerk.example.dev/mcp-api-render";
  const { token, jwk } = createSignedJwt({
    issuer,
    subject: "user_render_owner",
    expiresInSeconds: 600,
  });
  const db = new MockDB();
  const env = createEnv(issuer, db);

  const createKeyResponse = await withMockedJwks(issuer, jwk, () =>
    authRoutes.request(
      "http://local/mcp-api-keys",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "Local npm MCP" }),
      },
      env
    )
  );

  const { token: apiKey } = (await createKeyResponse.json()) as Record<string, string>;

  const response = await docsRoutes.request(
    "http://local/",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ markdown: "# Owned doc\n\nBody" }),
    },
    env
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, any>;
  assert.equal(body.ownership.owned, true);
  assert.equal(body.ownership.source, "mcp_local_api_key");
  assert.equal(body.ownership.auth_mode, "personal_api_key");
  assert.equal(db.docs.length, 1);
  assert.equal(db.docs[0].owner_user_id, "user_render_owner");
  assert.equal(db.apiKeys[0].last_used_source, "mcp_local_api_key");
});

test("/api/render rejects invalid personal API keys instead of silently falling back to anonymous", async () => {
  const db = new MockDB();
  const env = createEnv("https://clerk.example.dev/mcp-api-invalid", db);

  const response = await docsRoutes.request(
    "http://local/",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer plsr_pk_invalidvalue",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ markdown: "# Should fail" }),
    },
    env
  );

  assert.equal(response.status, 401);
  const body = (await response.json()) as Record<string, string>;
  assert.equal(body.code, "invalid_api_key");
  assert.equal(db.docs.length, 0);
});
