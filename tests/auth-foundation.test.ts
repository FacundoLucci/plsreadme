import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { authRoutes } from "../worker/routes/auth.ts";

function createEnv(overrides: Record<string, unknown> = {}) {
  return {
    CLERK_PUBLISHABLE_KEY: "pk_test_example",
    CLERK_JWT_ISSUER: "https://clerk.example.dev",
    CLERK_SIGN_IN_URL: "/sign-in",
    CLERK_SIGN_UP_URL: "/sign-up",
    ...overrides,
  } as any;
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
    kid: "test-key-1",
  };

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: issuer,
    sub: subject,
    sid: "sess_123",
    email: "jane@example.com",
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
      kid: "test-key-1",
      alg: "RS256",
      use: "sig",
      n: publicJwk.n,
      e: publicJwk.e,
    },
  };
}

test("/api/auth/config reports auth enabled when clerk keys are configured", async () => {
  const response = await authRoutes.request("http://local/config", { method: "GET" }, createEnv());

  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(body.enabled, true);
  assert.equal(body.publishableKey, "pk_test_example");
  assert.equal(body.frontendApiUrl, "https://clerk.example.dev");
  assert.deepEqual(body.providers, ["github", "google", "email"]);
});

test("/api/auth/me returns 401 for unauthenticated requests", async () => {
  const response = await authRoutes.request("http://local/me", { method: "GET" }, createEnv());

  assert.equal(response.status, 401);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.code, "auth_required");
});

test("/api/auth/me accepts valid clerk JWT bearer token", async () => {
  const issuer = "https://clerk.example.dev";
  const { token, jwk } = createSignedJwt({
    issuer,
    subject: "user_abc123",
    expiresInSeconds: 600,
  });

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
    const response = await authRoutes.request(
      "http://local/me",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
      createEnv({ CLERK_JWT_ISSUER: issuer })
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.userId, "user_abc123");
    assert.equal(body.email, "jane@example.com");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
