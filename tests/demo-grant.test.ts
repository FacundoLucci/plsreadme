import assert from "node:assert/strict";
import test from "node:test";
import { authRoutes } from "../worker/routes/auth.ts";
import { linksRoutes } from "../worker/routes/links.ts";
import { DEMO_GRANT_COOKIE_NAME } from "../worker/security.ts";

type DemoGrantRow = {
  ip_hash: string;
  user_agent_hash: string;
  expires_at: string;
  used_at: string | null;
};

class MockDB {
  public demoGrants = new Map<string, DemoGrantRow>();
  public rateLimitRows: Array<{ endpoint: string; ipHash: string; createdAt: string }> = [];
  public docsInserts: Array<unknown[]> = [];

  prepare(sql: string) {
    const db = this;

    return {
      params: [] as unknown[],
      bind(...params: unknown[]) {
        this.params = params;
        return this;
      },
      async run() {
        if (sql.startsWith("INSERT INTO demo_grants")) {
          const [tokenHash, ipHash, userAgentHash, , expiresAt] = this.params as [
            string,
            string,
            string,
            string,
            string,
          ];
          db.demoGrants.set(tokenHash, {
            ip_hash: ipHash,
            user_agent_hash: userAgentHash,
            expires_at: expiresAt,
            used_at: null,
          });
          return { success: true };
        }

        if (sql.startsWith("DELETE FROM demo_grants")) {
          const [nowIso] = this.params as [string];
          for (const [tokenHash, row] of db.demoGrants.entries()) {
            if (row.expires_at <= nowIso || row.used_at) {
              db.demoGrants.delete(tokenHash);
            }
          }
          return { success: true };
        }

        if (sql.startsWith("UPDATE demo_grants SET used_at")) {
          const [usedAt, tokenHash] = this.params as [string, string];
          const row = db.demoGrants.get(tokenHash);
          if (row && !row.used_at) {
            row.used_at = usedAt;
          }
          return { success: true };
        }

        if (sql.startsWith("INSERT INTO request_rate_limits")) {
          const [endpoint, ipHash, createdAt] = this.params as [string, string, string];
          db.rateLimitRows.push({ endpoint, ipHash, createdAt });
          return { success: true };
        }

        if (sql.startsWith("INSERT INTO docs")) {
          db.docsInserts.push(this.params);
          return { success: true };
        }

        return { success: true };
      },
      async first<T>() {
        if (sql.includes("SELECT COUNT(*) as count FROM request_rate_limits")) {
          const [endpoint, ipHash] = this.params as [string, string, string];
          const count = db.rateLimitRows.filter(
            (row) => row.endpoint === endpoint && row.ipHash === ipHash
          ).length;
          return { count } as T;
        }

        if (sql.includes("SELECT COUNT(*) as count FROM docs WHERE owner_user_id")) {
          return { count: 0 } as T;
        }

        if (sql.includes("SELECT ip_hash, user_agent_hash, expires_at, used_at FROM demo_grants")) {
          const [tokenHash] = this.params as [string];
          return (db.demoGrants.get(tokenHash) ?? null) as T;
        }

        return null;
      },
      async all() {
        return { results: [] };
      },
    };
  }
}

function createEnv(db: MockDB) {
  const puts: Array<{ key: string; body: string }> = [];

  return {
    env: {
      DB: db,
      DOCS_BUCKET: {
        async put(key: string, body: unknown) {
          puts.push({ key, body: String(body) });
        },
        async get() {
          return null;
        },
        async delete() {
          return;
        },
      },
      ANALYTICS: {
        async writeDataPoint() {
          return;
        },
      },
      MCP_OBJECT: {} as DurableObjectNamespace,
      ASSETS: { fetch: async () => new Response("ok") } as Fetcher,
    } as any,
    puts,
  };
}

function extractDemoGrantCookie(setCookie: string | null): string | null {
  if (!setCookie) return null;
  const match = setCookie.match(new RegExp(`${DEMO_GRANT_COOKIE_NAME}=([^;]+)`));
  if (!match) return null;
  return `${DEMO_GRANT_COOKIE_NAME}=${match[1]}`;
}

function createMarkdownRequestInit(markdown: string, extraHeaders: Record<string, string> = {}) {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(new TextEncoder().encode(markdown).length),
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)",
      ...extraHeaders,
    },
    body: JSON.stringify({ markdown }),
  };
}

test("GET /api/auth/demo-grant issues an HttpOnly browser proof cookie for anonymous callers", async () => {
  const db = new MockDB();
  const { env } = createEnv(db);

  const response = await authRoutes.request(
    "http://local/demo-grant",
    {
      method: "GET",
      headers: {
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)",
      },
    },
    env
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.requiresGrant, true);
  assert.equal(body.authenticated, false);

  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie, "expected demo grant Set-Cookie header");
  assert.match(setCookie!, /plsreadme_demo_grant=/);
  assert.match(setCookie!, /HttpOnly/);
  assert.match(setCookie!, /SameSite=Lax/);
});

test("POST /api/create-link rejects anonymous create requests without a demo grant", async () => {
  const db = new MockDB();
  const { env } = createEnv(db);
  const markdown = "# hello\nworld";

  const response = await linksRoutes.request(
    "http://local/",
    createMarkdownRequestInit(markdown),
    env
  );

  assert.equal(response.status, 403);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.code, "demo_grant_required");
});

test("POST /api/create-link accepts a valid demo grant once and tags the result as web_demo", async () => {
  const db = new MockDB();
  const { env, puts } = createEnv(db);
  const markdown = "# hello\nworld";

  const grantResponse = await authRoutes.request(
    "http://local/demo-grant",
    {
      method: "GET",
      headers: {
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)",
      },
    },
    env
  );

  const cookie = extractDemoGrantCookie(grantResponse.headers.get("set-cookie"));
  assert.ok(cookie, "expected demo grant cookie");

  const response = await linksRoutes.request(
    "http://local/",
    createMarkdownRequestInit(markdown, {
      cookie: cookie!,
    }),
    env
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.owned, false);
  assert.equal(body.authMode, "anonymous_demo");
  assert.equal(body.source, "web_demo");
  assert.equal(puts.length, 1);

  const reused = await linksRoutes.request(
    "http://local/",
    createMarkdownRequestInit(markdown, {
      cookie: cookie!,
    }),
    env
  );

  assert.equal(reused.status, 403);
  const reusedBody = (await reused.json()) as Record<string, unknown>;
  assert.equal(reusedBody.code, "demo_grant_invalid");
});
