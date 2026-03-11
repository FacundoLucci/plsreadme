import assert from "node:assert/strict";
import test from "node:test";
import { docsRoutes } from "../worker/routes/docs.ts";
import type { DocRecord, Env } from "../worker/types.ts";

type QueryRecord = { sql: string; params: unknown[] };

class MockDB {
  public firsts: QueryRecord[] = [];
  private readonly docs = new Map<string, DocRecord>();

  constructor(seedDocs: DocRecord[]) {
    for (const doc of seedDocs) {
      this.docs.set(doc.id, doc);
    }
  }

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

        if (/SELECT \* FROM docs WHERE id = \?/i.test(sql)) {
          const [docId] = this.params as [string];
          return (db.docs.get(docId) || null) as T;
        }

        return null;
      },
      async run() {
        return { success: true };
      },
      async all<T>() {
        return { results: [] as T };
      },
    };
  }
}

function createEnv(db: MockDB): Env {
  return {
    DB: db as unknown as D1Database,
    DOCS_BUCKET: {} as R2Bucket,
    ANALYTICS: {
      async writeDataPoint() {
        return;
      },
    } as unknown as AnalyticsEngineDataset,
    MCP_OBJECT: {} as DurableObjectNamespace,
    ASSETS: { fetch: async () => new Response("ok") } as Fetcher,
  } as Env;
}

function seedDoc(overrides: Partial<DocRecord> = {}): DocRecord {
  return {
    id: "doc123",
    r2_key: "md/doc123.md",
    content_type: "text/markdown",
    bytes: 123,
    created_at: "2026-03-11T18:45:00.000Z",
    sha256: "abc",
    title: "AI Notes",
    view_count: 8,
    admin_token: "sk_doc123",
    doc_version: 3,
    owner_user_id: null,
    ...overrides,
  };
}

test("GET /:id/versions returns descending version timeline", async () => {
  const db = new MockDB([seedDoc()]);
  const env = createEnv(db);

  const response = await docsRoutes.request("http://local/doc123/versions", { method: "GET" }, env);

  assert.equal(response.status, 200);
  const payload = (await response.json()) as {
    id: string;
    current_version: number;
    total_versions: number;
    versions: Array<{ version: number; is_current: boolean; raw_url: string }>;
  };

  assert.equal(payload.id, "doc123");
  assert.equal(payload.current_version, 3);
  assert.equal(payload.total_versions, 3);
  assert.deepEqual(
    payload.versions.map((entry) => entry.version),
    [3, 2, 1]
  );
  assert.equal(payload.versions[0]?.is_current, true);
  assert.equal(payload.versions[0]?.raw_url, "http://local/v/doc123/raw");
  assert.equal(payload.versions[1]?.raw_url, "http://local/v/doc123/raw?version=2");
});

test("GET /:id/history renders a readable version history page", async () => {
  const db = new MockDB([seedDoc()]);
  const env = createEnv(db);

  const response = await docsRoutes.request("http://local/doc123/history", { method: "GET" }, env);

  assert.equal(response.status, 200);
  const html = await response.text();

  assert.match(html, /Version history/i);
  assert.match(html, /v3 \(current\)/);
  assert.match(html, /\/v\/doc123\/raw\?version=2/);
  assert.match(html, /\/v\/doc123/);
});

test("GET /:id/versions returns 404 for missing docs", async () => {
  const db = new MockDB([]);
  const env = createEnv(db);

  const response = await docsRoutes.request("http://local/missing/versions", { method: "GET" }, env);

  assert.equal(response.status, 404);
  const payload = (await response.json()) as Record<string, unknown>;
  assert.equal(payload.error, "Document not found");
});
