import assert from "node:assert/strict";
import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { commentsRoutes } from "../worker/routes/comments.ts";

type QueryRecord = { sql: string; params: unknown[] };

class MockDB {
  public runs: QueryRecord[] = [];
  public firsts: QueryRecord[] = [];
  private readonly docOwnerUserId: string | null;

  constructor(docOwnerUserId: string | null = "owner_123") {
    this.docOwnerUserId = docOwnerUserId;
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
        return { success: true };
      },
      async first<T>() {
        db.firsts.push({ sql, params: this.params });

        if (sql.includes("SELECT id, COALESCE(doc_version, 1) as doc_version, owner_user_id FROM docs")) {
          return {
            id: "doc_abc",
            doc_version: 3,
            owner_user_id: db.docOwnerUserId,
          } as T;
        }

        if (sql.includes("SELECT id FROM docs WHERE id = ?")) {
          return { id: "doc_abc" } as T;
        }

        if (sql.includes("SELECT COUNT(*) as count FROM comments WHERE ip_hash = ?")) {
          return { count: 0 } as T;
        }

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
  email,
  expiresInSeconds,
}: {
  issuer: string;
  subject: string;
  email: string;
  expiresInSeconds: number;
}) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicJwk = publicKey.export({ format: "jwk" }) as JsonWebKey;

  const header = {
    alg: "RS256",
    typ: "JWT",
    kid: "test-key-comments",
  };

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: issuer,
    sub: subject,
    sid: "sess_comments",
    email,
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
      kid: "test-key-comments",
      alg: "RS256",
      use: "sig",
      n: publicJwk.n,
      e: publicJwk.e,
    },
  };
}

function createEnv(db: MockDB, issuer?: string) {
  const analyticsWrites: unknown[] = [];

  return {
    env: {
      DB: db,
      CLERK_JWT_ISSUER: issuer,
      ANALYTICS: {
        async writeDataPoint(payload: unknown) {
          analyticsWrites.push(payload);
        },
      },
    } as any,
    analyticsWrites,
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

test("authenticated comment stores user identity and notification metadata", async () => {
  const issuer = "https://clerk.example.dev/comments";
  const { token, jwk } = createSignedJwt({
    issuer,
    subject: "user_commenter",
    email: "commenter@example.com",
    expiresInSeconds: 600,
  });

  const db = new MockDB("owner_doc_user");
  const { env, analyticsWrites } = createEnv(db, issuer);

  const response = await withMockedJwks(issuer, jwk, async () =>
    commentsRoutes.request(
      "http://local/doc_abc",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "cf-connecting-ip": "203.0.113.10",
        },
        body: JSON.stringify({
          author_display_name: "Casey",
          body: "Looks great",
          anchor_id: "section-1",
        }),
      },
      env
    )
  );

  assert.equal(response.status, 201);
  const payload = (await response.json()) as { comment: Record<string, unknown> };

  assert.equal(payload.comment.author_user_id, "user_commenter");
  assert.equal(payload.comment.author_email, "commenter@example.com");
  assert.equal(payload.comment.author_display_name, "Casey");
  assert.equal(payload.comment.author_name, "Casey");

  const commentInsert = db.runs.find((entry) =>
    entry.sql.startsWith("INSERT INTO comments (id, doc_id, author_name, author_user_id")
  );
  assert.ok(commentInsert, "expected comments insert query");
  assert.equal(commentInsert?.params[3], "user_commenter");
  assert.equal(commentInsert?.params[4], "commenter@example.com");
  assert.equal(commentInsert?.params[5], "Casey");

  const expectedIpHash = createHash("sha256").update("203.0.113.10").digest("hex");
  const storedRateActorKey = String(commentInsert?.params[9] ?? "");
  assert.match(storedRateActorKey, /^auth:[a-f0-9]{64}$/);
  assert.notEqual(storedRateActorKey, expectedIpHash);

  const rateCheckQuery = db.firsts.find((entry) =>
    entry.sql.includes("SELECT COUNT(*) as count FROM comments WHERE ip_hash = ?")
  );
  assert.ok(rateCheckQuery, "expected rate limit query");
  assert.equal(rateCheckQuery?.params[0], storedRateActorKey);

  const notificationInsert = db.runs.find((entry) =>
    entry.sql.includes("INSERT INTO comment_notifications")
  );
  assert.ok(notificationInsert, "expected notification metadata insert");
  assert.equal(notificationInsert?.params[2], "doc_abc");
  assert.equal(notificationInsert?.params[3], "owner_doc_user");
  assert.equal(notificationInsert?.params[4], "user_commenter");
  assert.equal(notificationInsert?.params[5], "commenter@example.com");

  assert.equal(analyticsWrites.length, 1);
});

test("anonymous comment remains anonymous while still stashing notification context", async () => {
  const db = new MockDB(null);
  const { env } = createEnv(db);

  const response = await commentsRoutes.request(
    "http://local/doc_abc",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.11",
      },
      body: JSON.stringify({
        author_name: "Anonymous Friend",
        body: "hello",
        anchor_id: "doc-root",
      }),
    },
    env
  );

  assert.equal(response.status, 201);
  const payload = (await response.json()) as { comment: Record<string, unknown> };

  assert.equal(payload.comment.author_name, "Anonymous Friend");
  assert.equal(payload.comment.author_user_id, null);
  assert.equal(payload.comment.author_email, null);
  assert.equal(payload.comment.author_display_name, null);

  const commentInsert = db.runs.find((entry) =>
    entry.sql.startsWith("INSERT INTO comments (id, doc_id, author_name, author_user_id")
  );
  assert.ok(commentInsert, "expected comments insert query");
  assert.equal(commentInsert?.params[2], "Anonymous Friend");
  assert.equal(commentInsert?.params[3], null);
  assert.equal(commentInsert?.params[4], null);
  assert.equal(commentInsert?.params[5], null);

  const expectedIpHash = createHash("sha256").update("203.0.113.11").digest("hex");
  assert.equal(commentInsert?.params[9], expectedIpHash);

  const rateCheckQuery = db.firsts.find((entry) =>
    entry.sql.includes("SELECT COUNT(*) as count FROM comments WHERE ip_hash = ?")
  );
  assert.ok(rateCheckQuery, "expected rate limit query");
  assert.equal(rateCheckQuery?.params[0], expectedIpHash);

  const notificationInsert = db.runs.find((entry) =>
    entry.sql.includes("INSERT INTO comment_notifications")
  );
  assert.ok(notificationInsert, "expected notification metadata insert");
  assert.equal(notificationInsert?.params[3], null);
  assert.equal(notificationInsert?.params[4], null);
  assert.equal(notificationInsert?.params[7], "Anonymous Friend");
});
