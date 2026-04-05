import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildHostedMcpOauthErrorResponse,
  buildHostedMcpGrantPropsForTest,
  handleHostedMcpAuthorizeRequest,
} from "../worker/mcp-oauth.ts";
import { createHostedMcpDoc } from "../worker/mcp-create.ts";
import type { Env } from "../worker/types.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class MockBucket {
  public puts: Array<{ key: string; body: string; options: Record<string, unknown> | undefined }> = [];

  async put(key: string, body: unknown, options?: Record<string, unknown>) {
    this.puts.push({
      key,
      body: String(body),
      options,
    });
  }
}

class MockDB {
  public runs: Array<{ sql: string; params: unknown[] }> = [];

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
        return { success: true };
      },
      async first() {
        return null;
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
    kid: "mcp-remote-login-test-key",
  };

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: issuer,
    sub: subject,
    sid: "sess_mcp_remote",
    email: "remote-owner@example.com",
    iat: now,
    exp: now + expiresInSeconds,
  };

  const encodedHeader = Buffer.from(JSON.stringify(header)).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const unsigned = `${encodedHeader}.${encodedPayload}`;
  const signature = createSign("RSA-SHA256")
    .update(unsigned)
    .sign(privateKey)
    .toString("base64url");

  return {
    token: `${unsigned}.${signature}`,
    jwk: {
      kty: "RSA",
      kid: "mcp-remote-login-test-key",
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

test("hosted MCP OAuth errors carry setup guidance and local fallback copy", async () => {
  const response = buildHostedMcpOauthErrorResponse({
    code: "invalid_token",
    description: "Authorization required",
    status: 401,
    headers: {
      "WWW-Authenticate": 'Bearer resource_metadata="https://plsreadme.com/.well-known/oauth-protected-resource"',
    },
  });

  assert.equal(response.status, 401);
  assert.match(response.headers.get("www-authenticate") ?? "", /resource_metadata=/i);

  const payload = (await response.json()) as Record<string, string>;
  assert.equal(payload.error, "invalid_token");
  assert.match(payload.setupUrl, /\/mcp-setup$/);
  assert.match(payload.localMcpCommand, /plsreadme-mcp/);
});

test("hosted authorize screen renders a sign-in gate when no Clerk session is present", async () => {
  const response = await handleHostedMcpAuthorizeRequest(
    new Request("https://plsreadme.com/authorize?client_id=cursor"),
    {
      OAUTH_PROVIDER: {
        async parseAuthRequest() {
          return {
            responseType: "code",
            clientId: "cursor",
            redirectUri: "https://cursor.example/callback",
            scope: ["mcp:tools"],
            state: "state_cursor",
          };
        },
        async lookupClient() {
          return {
            clientId: "cursor",
            clientName: "Cursor",
            redirectUris: ["https://cursor.example/callback"],
            tokenEndpointAuthMethod: "none",
          };
        },
      } as Env["OAUTH_PROVIDER"],
    } as Env
  );

  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Sign in to connect Cursor/);
  assert.match(html, /data-auth-root/);
  assert.match(html, /clerk-auth-shell\.js/);
});

test("authenticated authorize approval completes the OAuth grant with mcp_remote_login props", async () => {
  const issuer = "https://clerk.example.dev/mcp-remote";
  const { token, jwk } = createSignedJwt({
    issuer,
    subject: "user_remote_owner",
    expiresInSeconds: 600,
  });

  const completed: Array<Record<string, unknown>> = [];

  const response = await withMockedJwks(issuer, jwk, () =>
    handleHostedMcpAuthorizeRequest(
      new Request("https://plsreadme.com/authorize?client_id=cursor", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          cookie: "__Host-plsreadme-mcp-csrf=csrf-remote-123",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "csrf_token=csrf-remote-123",
      }),
      {
        CLERK_JWT_ISSUER: issuer,
        OAUTH_PROVIDER: {
          async parseAuthRequest() {
            return {
              responseType: "code",
              clientId: "cursor",
              redirectUri: "https://cursor.example/callback",
              scope: ["mcp:tools"],
              state: "state_cursor",
            };
          },
          async lookupClient() {
            return {
              clientId: "cursor",
              clientName: "Cursor",
              redirectUris: ["https://cursor.example/callback"],
              tokenEndpointAuthMethod: "none",
            };
          },
          async completeAuthorization(options) {
            completed.push(options as unknown as Record<string, unknown>);
            return {
              redirectTo: "https://cursor.example/callback?code=done",
            };
          },
        } as Env["OAUTH_PROVIDER"],
      } as Env
    )
  );

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "https://cursor.example/callback?code=done");
  assert.match(response.headers.get("set-cookie") ?? "", /Max-Age=0/);

  assert.equal(completed.length, 1);
  assert.equal(completed[0].userId, "user_remote_owner");
  assert.deepEqual(completed[0].scope, ["mcp:tools"]);
  assert.equal((completed[0].props as Record<string, string>).source, "mcp_remote_login");
  assert.equal((completed[0].props as Record<string, string>).authMode, "remote_login");
  assert.equal((completed[0].props as Record<string, string>).clientName, "Cursor");
});

test("createHostedMcpDoc persists owner attribution for hosted remote login creates", async () => {
  const db = new MockDB();
  const bucket = new MockBucket();
  const analyticsWrites: Array<Record<string, unknown>> = [];

  const result = await createHostedMcpDoc(
    {
      DB: db as unknown as D1Database,
      DOCS_BUCKET: bucket as unknown as R2Bucket,
      ANALYTICS: {
        async writeDataPoint(payload: Record<string, unknown>) {
          analyticsWrites.push(payload);
        },
      } as AnalyticsEngineDataset,
      ASSETS: { fetch: async () => new Response("ok") } as Fetcher,
      MCP_OBJECT: {} as DurableObjectNamespace,
    } as Env,
    {
      markdown: "# Remote Doc\nhello",
    },
    buildHostedMcpGrantPropsForTest(
      {
        isAuthenticated: true,
        tokenSource: "authorization",
        userId: "user_remote_owner",
        sessionId: "sess_remote_owner",
        email: "remote-owner@example.com",
      },
      "cursor",
      "Cursor"
    )
  );

  assert.match(result.url, /https:\/\/plsreadme\.com\/v\//);
  assert.equal(bucket.puts.length, 1);
  assert.equal(
    (bucket.puts[0].options?.customMetadata as Record<string, string>).created_source,
    "mcp_remote_login"
  );
  assert.equal(
    (bucket.puts[0].options?.customMetadata as Record<string, string>).owner_user_id,
    "user_remote_owner"
  );

  const insert = db.runs.find((entry) => entry.sql.startsWith("INSERT INTO docs"));
  assert.ok(insert, "expected docs insert");
  assert.equal(insert?.params[8], "user_remote_owner");

  const attributionInsert = db.runs.find((entry) =>
    entry.sql.startsWith("INSERT OR REPLACE INTO doc_create_events")
  );
  assert.ok(attributionInsert, "expected doc_create_events insert");
  assert.equal(attributionInsert?.params[2], "mcp_remote_login");
  assert.equal(attributionInsert?.params[3], "remote_login");

  const rateLimitQuery = db.runs.find((entry) =>
    entry.sql.startsWith("INSERT INTO request_rate_limits")
  );
  assert.ok(rateLimitQuery, "expected durable mcp rate-limit insert");
  assert.equal(rateLimitQuery?.params[0], "mcp-create");

  assert.equal(analyticsWrites.length, 1);
  assert.deepEqual(analyticsWrites[0].indexes, ["mcp_remote_login", "user_remote_owner"]);
});

test("mcp setup page includes auth shell and remote login guidance", async () => {
  const html = await readFile(path.join(__dirname, "../public/mcp-setup.html"), "utf8");

  assert.match(html, /data-auth-root/);
  assert.match(html, /Recommended Remote Setup/);
  assert.match(html, /Current as of April 5, 2026/);
  assert.match(html, /clerk-auth-shell\.js/);
  assert.match(html, /mcp_remote_login/);
  assert.match(html, /PLSREADME_API_KEY/);
});
