import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { authRoutes } from "../worker/routes/auth.ts";
import type { Env } from "../worker/types.ts";

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
    kid: "mcp-grants-test-key",
  };

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: issuer,
    sub: subject,
    sid: "sess_mcp_grants",
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
      kid: "mcp-grants-test-key",
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

function createEnv(
  issuer: string,
  overrides: Partial<Env> = {}
): Env {
  return {
    DB: {} as D1Database,
    DOCS_BUCKET: {} as R2Bucket,
    ANALYTICS: {
      async writeDataPoint() {
        return;
      },
    } as AnalyticsEngineDataset,
    MCP_OBJECT: {} as DurableObjectNamespace,
    ASSETS: { fetch: async () => new Response("ok") } as Fetcher,
    CLERK_JWT_ISSUER: issuer,
    ...overrides,
  } as Env;
}

test("/api/auth/mcp-grants lists hosted remote login grants and lifecycle metadata", async () => {
  const issuer = "https://clerk.example.dev/mcp-grants";
  const { token, jwk } = createSignedJwt({
    issuer,
    subject: "user_remote_owner",
    expiresInSeconds: 600,
  });

  const env = createEnv(issuer, {
    OAUTH_PROVIDER: {
      async listUserGrants(userId: string) {
        return {
          items: [
            {
              id: "grant_remote_1",
              clientId: "cursor",
              userId,
              scope: ["mcp:tools"],
              metadata: {
                source: "mcp_remote_login",
                clientId: "cursor",
                clientName: "Cursor",
                approvedAt: "2026-04-04T16:02:00.000Z",
              },
              createdAt: 1775328000,
              expiresAt: 1777920000,
            },
            {
              id: "grant_other_1",
              clientId: "other",
              userId,
              scope: ["other:scope"],
              metadata: {
                source: "other_surface",
              },
              createdAt: 1775328000,
            },
          ],
          cursor: "cursor_next",
        };
      },
    } as Env["OAUTH_PROVIDER"],
  });

  const response = await withMockedJwks(issuer, jwk, () =>
    authRoutes.request(
      "http://local/mcp-grants?limit=10",
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
  const body = (await response.json()) as Record<string, any>;

  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].id, "grant_remote_1");
  assert.equal(body.items[0].clientName, "Cursor");
  assert.equal(body.items[0].source, "mcp_remote_login");
  assert.match(body.items[0].revokeUrl, /\/api\/auth\/mcp-grants\/grant_remote_1$/);
  assert.equal(body.cursor, "cursor_next");
  assert.equal(body.lifecycle.accessTokenTtlSeconds, 3600);
  assert.equal(body.lifecycle.refreshTokenTtlSeconds, 2592000);
  assert.match(body.lifecycle.logoutBehavior, /does not revoke/i);
  assert.equal(body.endpoints.authorize, "/authorize");
  assert.equal(body.endpoints.token, "/oauth/token");
});

test("/api/auth/mcp-grants/:grantId revokes a hosted remote login grant", async () => {
  const issuer = "https://clerk.example.dev/mcp-grants-revoke";
  const { token, jwk } = createSignedJwt({
    issuer,
    subject: "user_remote_owner",
    expiresInSeconds: 600,
  });

  const revoked: Array<{ grantId: string; userId: string }> = [];
  const env = createEnv(issuer, {
    OAUTH_PROVIDER: {
      async listUserGrants(userId: string) {
        return {
          items: [
            {
              id: "grant_remote_2",
              clientId: "claude-code",
              userId,
              scope: ["mcp:tools"],
              metadata: {
                source: "mcp_remote_login",
                clientName: "Claude Code",
              },
              createdAt: 1775328000,
            },
          ],
        };
      },
      async revokeGrant(grantId: string, userId: string) {
        revoked.push({ grantId, userId });
      },
    } as Env["OAUTH_PROVIDER"],
  });

  const response = await withMockedJwks(issuer, jwk, () =>
    authRoutes.request(
      "http://local/mcp-grants/grant_remote_2",
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
      env
    )
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.ok, true);
  assert.equal(body.revoked, true);
  assert.equal(body.clientName, "Claude Code");
  assert.deepEqual(revoked, [
    {
      grantId: "grant_remote_2",
      userId: "user_remote_owner",
    },
  ]);
});
