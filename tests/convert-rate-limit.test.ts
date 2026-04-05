import assert from "node:assert/strict";
import test from "node:test";
import { convertRoutes } from "../worker/routes/convert.ts";

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

function createEnv(db: MockDB) {
  return {
    DB: db as unknown as D1Database,
    ANALYTICS: {
      async writeDataPoint() {
        return;
      },
    } as AnalyticsEngineDataset,
    DOCS_BUCKET: {} as R2Bucket,
    MCP_OBJECT: {} as DurableObjectNamespace,
    ASSETS: { fetch: async () => new Response("ok") } as Fetcher,
  } as any;
}

test("/api/convert uses durable request_rate_limits and logs rate-limit abuse", async () => {
  const db = new MockDB();
  db.rateCount = 10;
  const env = createEnv(db);

  const response = await convertRoutes.request(
    "http://local/",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": "21",
        "cf-connecting-ip": "203.0.113.7",
      },
      body: JSON.stringify({ text: "hello world" }),
    },
    env
  );

  assert.equal(response.status, 429);
  const payload = (await response.json()) as Record<string, unknown>;
  assert.match(String(payload.error), /Max 10 conversions per hour/);

  const rateLimitQuery = db.firsts.find((entry) =>
    entry.sql.includes("SELECT COUNT(*) as count FROM request_rate_limits")
  );
  assert.ok(rateLimitQuery, "expected durable rate-limit count query");
  assert.equal(rateLimitQuery?.params[0], "convert");

  const abuseInsert = db.runs.find((entry) =>
    entry.sql.startsWith("INSERT INTO abuse_audit_log")
  );
  assert.ok(abuseInsert, "expected abuse log write");
  assert.equal(abuseInsert?.params[0], "/api/convert");
  assert.equal(abuseInsert?.params[2], "rate_limit_exceeded");
});
