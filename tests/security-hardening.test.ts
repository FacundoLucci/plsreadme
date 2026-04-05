import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { authRoutes } from "../worker/routes/auth.ts";
import { linksRoutes } from "../worker/routes/links.ts";
import { docsRoutes, generateHtmlTemplate } from "../worker/routes/docs.ts";
import {
  DEMO_GRANT_COOKIE_NAME,
  MAX_PAYLOAD_BYTES,
  MAX_SINGLE_LINE_CHARS,
} from "../worker/security.ts";

type QueryRecord = { sql: string; params: unknown[] };
type DemoGrantRow = {
  ip_hash: string;
  user_agent_hash: string;
  expires_at: string;
  used_at: string | null;
};

const TEST_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)";

class MockDB {
  public preparedSql: string[] = [];
  public runs: QueryRecord[] = [];
  public firsts: QueryRecord[] = [];
  public rateCount = 0;
  public demoGrants = new Map<string, DemoGrantRow>();

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
        }

        if (sql.startsWith("DELETE FROM demo_grants")) {
          const [nowIso] = this.params as [string];
          for (const [tokenHash, row] of db.demoGrants.entries()) {
            if (row.expires_at <= nowIso || row.used_at) {
              db.demoGrants.delete(tokenHash);
            }
          }
        }

        if (sql.startsWith("UPDATE demo_grants SET used_at")) {
          const [usedAt, tokenHash] = this.params as [string, string];
          const row = db.demoGrants.get(tokenHash);
          if (row && !row.used_at) {
            row.used_at = usedAt;
          }
        }

        return { success: true };
      },
      async first<T>() {
        db.firsts.push({ sql, params: this.params });

        if (sql.includes("SELECT COUNT(*) as count FROM request_rate_limits")) {
          return { count: db.rateCount } as T;
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

function createBaseEnv(db: MockDB) {
  const puts: Array<{ key: string; body: string }> = [];

  const env = {
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
  } as any;

  return { env, puts };
}

function extractDemoGrantCookie(setCookie: string | null): string | null {
  if (!setCookie) return null;
  const match = setCookie.match(new RegExp(`${DEMO_GRANT_COOKIE_NAME}=([^;]+)`));
  if (!match) return null;
  return `${DEMO_GRANT_COOKIE_NAME}=${match[1]}`;
}

async function issueDemoGrantCookie(env: any): Promise<string> {
  const response = await authRoutes.request(
    "http://local/demo-grant",
    {
      method: "GET",
      headers: {
        "user-agent": TEST_USER_AGENT,
      },
    },
    env
  );

  const cookie = extractDemoGrantCookie(response.headers.get("set-cookie"));
  assert.ok(cookie, "expected anonymous demo grant cookie");
  return cookie!;
}

test("SQLi-like markdown is handled as data and insert query stays parameterized", async () => {
  const db = new MockDB();
  const { env, puts } = createBaseEnv(db);
  const markdown = "# title\n'); DROP TABLE docs; --";
  const demoGrantCookie = await issueDemoGrantCookie(env);

  const res = await linksRoutes.request(
    "http://local/",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(new TextEncoder().encode(markdown).length),
        "user-agent": TEST_USER_AGENT,
        cookie: demoGrantCookie,
      },
      body: JSON.stringify({ markdown }),
    },
    env
  );

  assert.equal(res.status, 200);
  assert.equal(puts.length, 1);
  assert.equal(puts[0]?.body, markdown);

  const docsInsert = db.runs.find((entry) =>
    entry.sql.startsWith("INSERT INTO docs")
  );
  assert.ok(docsInsert, "expected docs INSERT query to run");
  assert.match(
    docsInsert!.sql,
    /VALUES \(\?, \?, \?, \?, \?, \?, \?, \?, \?\)/,
    "docs insert should stay parameterized"
  );
  assert.ok(!docsInsert!.sql.includes("DROP TABLE"));

  const rateLimitQuery = db.firsts.find((entry) =>
    entry.sql.includes("SELECT COUNT(*) as count FROM request_rate_limits")
  );
  assert.ok(rateLimitQuery, "expected request_rate_limits count query");
  const expectedAnonymousIpHash = createHash("sha256").update("unknown").digest("hex");
  assert.equal(rateLimitQuery?.params[1], expectedAnonymousIpHash);
});

test("oversized payloads are rejected early via Content-Length", async () => {
  const db = new MockDB();
  const { env, puts } = createBaseEnv(db);

  const res = await linksRoutes.request(
    "http://local/",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(MAX_PAYLOAD_BYTES + 1),
      },
      body: JSON.stringify({ markdown: "ok" }),
    },
    env
  );

  assert.equal(res.status, 413);
  const payload = (await res.json()) as Record<string, unknown>;
  assert.equal(payload.reason, "max_payload_bytes");
  assert.equal(puts.length, 0);
  assert.equal(
    db.runs.some((entry) => entry.sql.startsWith("INSERT INTO docs")),
    false,
    "docs INSERT should not run on rejected payload"
  );
});

test("single-line markdown limit rejects pathological unbroken lines", async () => {
  const db = new MockDB();
  const { env, puts } = createBaseEnv(db);
  const markdown = `# ok\n${"a".repeat(MAX_SINGLE_LINE_CHARS + 1)}`;
  const demoGrantCookie = await issueDemoGrantCookie(env);

  const res = await linksRoutes.request(
    "http://local/",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(new TextEncoder().encode(markdown).length),
        "user-agent": TEST_USER_AGENT,
        cookie: demoGrantCookie,
      },
      body: JSON.stringify({ markdown }),
    },
    env
  );

  assert.equal(res.status, 400);
  const payload = (await res.json()) as Record<string, unknown>;
  assert.equal(payload.reason, "max_single_line_chars");
  assert.equal(puts.length, 0);
});

test("/api/render create route uses dedicated IP rate-limit table (not docs.sha256)", async () => {
  const db = new MockDB();
  const { env } = createBaseEnv(db);

  const markdown = "# hello\nworld";
  const res = await docsRoutes.request(
    "http://local/",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(new TextEncoder().encode(markdown).length),
      },
      body: JSON.stringify({ markdown }),
    },
    env
  );

  assert.equal(res.status, 200);

  const preparedSql = db.preparedSql.join("\n");
  assert.match(preparedSql, /request_rate_limits/);
  assert.equal(preparedSql.includes("FROM docs WHERE sha256"), false);
});

test("rendered HTML includes wrap-safe CSS for markdown, comments, code blocks, and tables", () => {
  const html = generateHtmlTemplate(
    "Wrap Test",
    "<pre><code>" + "x".repeat(200) + "</code></pre><table><thead><tr><th>Very Long Heading</th></tr></thead><tbody><tr><td>Value</td></tr></tbody></table><p>ok</p>",
    "doc123",
    1
  );

  assert.ok(html.includes("overflow-wrap: anywhere;"));
  assert.ok(html.includes(".doc-content pre { max-width: 100%; overflow-x: auto; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }"));
  assert.ok(html.includes(".doc-content .doc-table-scroll {"));
  assert.ok(html.includes("overflow-x: auto;"));
  assert.ok(html.includes("-webkit-overflow-scrolling: touch;"));
  assert.ok(html.includes("border: 1px solid var(--table-border);"));
  assert.ok(html.includes("border-radius: 12px;"));
  assert.ok(html.includes("box-shadow: var(--table-shadow);"));
  assert.ok(html.includes(".doc-content .doc-table-scroll > table {"));
  assert.ok(html.includes("width: max-content;"));
  assert.ok(html.includes("min-width: 100%;"));
  assert.ok(html.includes("border-collapse: separate;"));
  assert.ok(html.includes("border-spacing: 0;"));
  assert.ok(html.includes("line-height: 1.55;"));
  assert.ok(html.includes(".doc-content .doc-table-scroll :is(th,td) {"));
  assert.ok(html.includes("padding: 0.68rem 0.85rem;"));
  assert.ok(html.includes("border-right: 1px solid var(--table-border);"));
  assert.ok(html.includes("border-bottom: 1px solid var(--table-border);"));
  assert.ok(html.includes(".doc-content .doc-table-scroll th {"));
  assert.ok(html.includes("font-size: 0.84rem;"));
  assert.ok(html.includes("font-weight: 650;"));
  assert.ok(html.includes(".doc-content .doc-table-scroll tbody td {"));
  assert.ok(html.includes(".doc-content .doc-table-scroll :is(td,th) :is(p,strong,em,code,a,ul,ol,li) {"));
  assert.ok(html.includes(".doc-content .doc-table-scroll :is(td,th) :is(p,ul,ol) { margin: 0; }"));
  assert.ok(html.includes(".doc-content .doc-table-scroll :is(td,th) :is(ul,ol) { padding-left: 1.2rem; }"));
  assert.ok(html.includes(".doc-content .doc-table-scroll tbody tr:nth-child(even) td { background: var(--table-row-alt); }"));
  assert.ok(html.includes(".doc-content .doc-table-scroll tbody tr:hover td { background: var(--table-row-hover); }"));
  assert.ok(html.includes("--table-bg: #fffefb;"));
  assert.ok(html.includes("--table-bg: #1a1e26;"));
  assert.equal(html.includes(".doc-content .doc-table-scroll > table { min-width: 620px; }"), false);
  assert.equal(html.includes(".doc-content .doc-table-scroll :is(th,td) { white-space: nowrap; }"), false);
  assert.match(html, /<div class="doc-table-scroll"><table>[\s\S]*<\/table><\/div>/);
  assert.ok(html.includes(".comment-body { margin: 0.3rem 0 0; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; font-size: 0.88rem; }"));
  assert.ok(html.includes(".sidebar-comment .sc-body { margin: 0.15rem 0 0; color: #4f5663; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }"));
  assert.ok(html.includes("--node-hover-highlight-bg: rgba(59, 130, 246, 0.12);"));
  assert.ok(html.includes("--node-hover-highlight-bg: rgba(96, 165, 250, 0.19);"));
  assert.ok(html.includes(".comment-group-hover-highlight { position: absolute; top: 0; left: 0; width: 0; height: 0; border-radius: 14px;"));
  assert.ok(html.includes("#sidebar-groups.is-hover-highlight-ready .comment-group-header:hover { background: transparent; }"));
  assert.ok(html.includes("var SIDEBAR_HOVER_BLEED_X = 10;"));
  assert.ok(html.includes("function setSidebarHoverTarget(target, immediate) {"));
});
