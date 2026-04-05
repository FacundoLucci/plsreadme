import assert from "node:assert/strict";
import test from "node:test";
import { createHostedMcpDoc, HostedMcpRateLimitError } from "../worker/mcp-create.ts";

type QueryRecord = { sql: string; params: unknown[] };

class MockDB {
  public firsts: QueryRecord[] = [];
  public runs: QueryRecord[] = [];
  public rateCount = 0;

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

test("hosted MCP creates use durable rate limits before writing docs", async () => {
  const db = new MockDB();
  db.rateCount = 60;

  await assert.rejects(
    () =>
      createHostedMcpDoc(
        {
          DB: db as unknown as D1Database,
          DOCS_BUCKET: {
            async put() {
              throw new Error("should not write object on rate limit");
            },
          } as unknown as R2Bucket,
          ANALYTICS: {
            async writeDataPoint() {
              return;
            },
          } as AnalyticsEngineDataset,
        } as any,
        {
          markdown: "# rate-limited",
        },
        {
          userId: "user_remote_owner",
          sessionId: "sess_remote_owner",
          email: "remote-owner@example.com",
          authMode: "remote_login",
          source: "mcp_remote_login",
          clientId: "cursor",
          clientName: "Cursor",
          grantedAt: new Date().toISOString(),
          apiKeyId: null,
          apiKeyName: null,
        }
      ),
    HostedMcpRateLimitError
  );

  const rateLimitQuery = db.firsts.find((entry) =>
    entry.sql.includes("SELECT COUNT(*) as count FROM request_rate_limits")
  );
  assert.ok(rateLimitQuery, "expected durable rate-limit count query");
  assert.equal(rateLimitQuery?.params[0], "mcp-create");
  assert.match(String(rateLimitQuery?.params[1] ?? ""), /^auth:[a-f0-9]{64}$/);

  const docsInsert = db.runs.find((entry) => entry.sql.startsWith("INSERT INTO docs"));
  assert.equal(Boolean(docsInsert), false, "should not write docs on rate limit");

  const abuseInsert = db.runs.find((entry) => entry.sql.startsWith("INSERT INTO abuse_audit_log"));
  assert.ok(abuseInsert, "expected abuse log write");
  assert.equal(abuseInsert?.params[0], "/mcp");
});
