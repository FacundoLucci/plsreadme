import assert from "node:assert/strict";
import test from "node:test";
import { docsRoutes } from "../worker/routes/docs.ts";
import type { DocRecord, Env } from "../worker/types.ts";

type QueryRecord = { sql: string; params: unknown[] };

class MockDB {
  public firsts: QueryRecord[] = [];
  public runs: QueryRecord[] = [];
  public rateCount = 0;
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

        if (/SELECT COUNT\(\*\) as count FROM request_rate_limits/i.test(sql)) {
          return { count: db.rateCount } as T;
        }

        if (/SELECT \* FROM docs WHERE id = \? AND admin_token = \?/i.test(sql)) {
          const [docId, adminToken] = this.params as [string, string];
          const doc = db.docs.get(docId);
          if (!doc || doc.admin_token !== adminToken) {
            return null as T;
          }
          return doc as T;
        }

        if (/SELECT \* FROM docs WHERE id = \?/i.test(sql)) {
          const [docId] = this.params as [string];
          return (db.docs.get(docId) || null) as T;
        }

        return null;
      },
      async run() {
        db.runs.push({ sql, params: this.params });

        if (/UPDATE docs SET bytes = \?, sha256 = \?, title = \?, doc_version = \? WHERE id = \?/i.test(sql)) {
          const [bytes, sha256Value, title, docVersion, docId] = this.params as [
            number,
            string,
            string | null,
            number,
            string,
          ];

          const existingDoc = db.docs.get(docId);
          if (existingDoc) {
            db.docs.set(docId, {
              ...existingDoc,
              bytes: Number(bytes),
              sha256: sha256Value,
              title,
              doc_version: Number(docVersion),
            });
          }
        }

        return { success: true };
      },
      async all<T>() {
        return { results: [] as T };
      },
    };
  }
}

class MockBucket {
  public puts: Array<{ key: string; body: string }> = [];
  private readonly objects = new Map<string, string>();

  constructor(seedObjects: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(seedObjects)) {
      this.objects.set(key, value);
    }
  }

  async put(key: string, body: unknown) {
    const textBody = String(body);
    this.puts.push({ key, body: textBody });
    this.objects.set(key, textBody);
  }

  async get(key: string) {
    const value = this.objects.get(key);
    if (value === undefined) {
      return null;
    }

    return {
      async text() {
        return value;
      },
    };
  }
}

function createEnv(db: MockDB, bucket: MockBucket): Env {
  return {
    DB: db as unknown as D1Database,
    DOCS_BUCKET: bucket as unknown as R2Bucket,
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
  const env = createEnv(db, new MockBucket());

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

test("GET /:id/history renders restore affordances with explicit warnings", async () => {
  const db = new MockDB([seedDoc()]);
  const env = createEnv(db, new MockBucket());

  const response = await docsRoutes.request("http://local/doc123/history", { method: "GET" }, env);

  assert.equal(response.status, 200);
  const html = await response.text();

  assert.match(html, /Version history/i);
  assert.match(html, /Current version v3/i);
  assert.match(html, /restore-admin-token/);
  assert.match(html, /Restoring will create a new current version/i);
  assert.match(html, /data-restore-version="2"/);
  assert.match(html, /data-restore-version="1"/);
  assert.ok(!html.includes('data-restore-version="3"'), "current version should not have restore action");
  assert.match(html, /restore-success/);
  assert.match(html, /restore-readable-link/);
  assert.match(html, /\/v\/doc123\/raw\?version=2/);
  assert.match(html, /\/v\/doc123/);
});

test("GET /:id renders mobile actions-only viewer chrome", async () => {
  const db = new MockDB([seedDoc()]);
  const env = createEnv(
    db,
    new MockBucket({
      "md/doc123.md": "# Title\n\nViewer body",
    })
  );

  const response = await docsRoutes.request("http://local/doc123", { method: "GET" }, env);

  assert.equal(response.status, 200);
  const html = await response.text();

  assert.doesNotMatch(html, /Current version · v3/);
  assert.doesNotMatch(html, /class="viewer-header-actions"/);
  assert.match(html, /fonts\.googleapis\.com\/css2\?family=Lexend/);
  assert.match(html, /id="doc-toolbar-menu"\s+open/);
  assert.match(html, /id="doc-toolbar-toggle"[^>]*aria-expanded="true"[^>]*>Actions<\/summary>/);
  assert.match(
    html,
    /id="doc-toolbar-actions-panel"[\s\S]*Current v3[\s\S]*id="preview-save-btn"[\s\S]*Save to My Links[\s\S]*id="preview-save-status"[\s\S]*Copy link[\s\S]*\/v\/doc123\/raw[\s\S]*\/v\/doc123\/history/
  );
  assert.match(html, /doc-toolbar \{[^}]*gap: 0\.42rem;/);
  assert.match(html, /doc-toolbar-toggle \{[^}]*min-height: 2\.25rem;[^}]*padding: 0\.42rem 0\.82rem;/);
  assert.match(html, /doc-toolbar-actions-panel \{[^}]*flex-wrap: wrap;/);
  assert.match(html, /doc-toolbar-actions-panel \{[^}]*bottom: calc\(100% \+ 0\.22rem\);[^}]*padding: 0\.58rem;/);
  assert.match(html, /doc-toolbar-item \{[^}]*width: fit-content;/);
  assert.match(html, /doc-toolbar-item \{[^}]*white-space: nowrap;/);
  assert.match(html, /doc-toolbar-save-status \{[^}]*flex-basis: 100%;/);
  assert.match(html, /<div class="doc-toolbar-meta">\s*<span class="doc-toolbar-brand">Made readable with <a href="\/">plsreadme<\/a><\/span>\s*<\/div>/);
  assert.match(html, /<div class="doc-toolbar-auth-floating">\s*<div class="viewer-auth-shell doc-toolbar-auth-shell" data-auth-root data-auth-variant="read-link"><\/div>\s*<\/div>/);
  assert.match(html, /doc-toolbar-auth-floating \{[^}]*z-index: 45;[^}]*pointer-events: auto;/);
  assert.match(html, /doc-toolbar-auth-shell \.auth-menu-trigger \{[^}]*pointer-events: auto;/);
});

test("GET /:id/versions returns 404 for missing docs", async () => {
  const db = new MockDB([]);
  const env = createEnv(db, new MockBucket());

  const response = await docsRoutes.request("http://local/missing/versions", { method: "GET" }, env);

  assert.equal(response.status, 404);
  const payload = (await response.json()) as Record<string, unknown>;
  assert.equal(payload.error, "Document not found");
});

test("POST /:id/restore restores a prior version, archives current markdown, and bumps doc_version", async () => {
  const db = new MockDB([seedDoc()]);
  const bucket = new MockBucket({
    "md/doc123.md": "# Current V3\nLatest markdown",
    "md/doc123_v2.md": "# Restored V2\nEarlier markdown",
  });
  const env = createEnv(db, bucket);

  const response = await docsRoutes.request(
    "http://local/doc123/restore",
    {
      method: "POST",
      headers: {
        authorization: "Bearer sk_doc123",
        "content-type": "application/json",
      },
      body: JSON.stringify({ version: 2 }),
    },
    env
  );

  assert.equal(response.status, 200);
  const payload = (await response.json()) as Record<string, unknown>;
  assert.equal(payload.restored, true);
  assert.equal(payload.restored_from_version, 2);
  assert.equal(payload.current_version, 4);
  assert.equal(payload.raw_url, "http://local/v/doc123/raw");
  assert.equal(payload.versions_url, "http://local/v/doc123/versions");
  assert.equal(payload.history_url, "http://local/v/doc123/history");

  assert.equal(bucket.puts[0]?.key, "md/doc123_v3.md");
  assert.equal(bucket.puts[0]?.body, "# Current V3\nLatest markdown");
  assert.equal(bucket.puts[1]?.key, "md/doc123.md");
  assert.equal(bucket.puts[1]?.body, "# Restored V2\nEarlier markdown");

  const restoreUpdate = db.runs.find((entry) =>
    /^UPDATE docs SET bytes = \?, sha256 = \?, title = \?, doc_version = \? WHERE id = \?/i.test(entry.sql)
  );
  assert.ok(restoreUpdate, "expected docs metadata update for restore");
  assert.equal(restoreUpdate?.params[3], 4);

  const versionsResponse = await docsRoutes.request("http://local/doc123/versions", { method: "GET" }, env);
  assert.equal(versionsResponse.status, 200);
  const versionsPayload = (await versionsResponse.json()) as { current_version: number; total_versions: number };
  assert.equal(versionsPayload.current_version, 4);
  assert.equal(versionsPayload.total_versions, 4);

  const archivedSnapshotResponse = await docsRoutes.request(
    "http://local/doc123/raw?version=3",
    { method: "GET" },
    env
  );
  assert.equal(archivedSnapshotResponse.status, 200);
  assert.equal(await archivedSnapshotResponse.text(), "# Current V3\nLatest markdown");
});

test("POST /:id/restore is rate-limited like updates", async () => {
  const db = new MockDB([seedDoc()]);
  db.rateCount = 60;
  const env = createEnv(db, new MockBucket({ "md/doc123.md": "# Current" }));

  const response = await docsRoutes.request(
    "http://local/doc123/restore",
    {
      method: "POST",
      headers: {
        authorization: "Bearer sk_doc123",
        "content-type": "application/json",
      },
      body: JSON.stringify({ version: 1 }),
    },
    env
  );

  assert.equal(response.status, 429);
  const payload = (await response.json()) as Record<string, unknown>;
  assert.equal(payload.reason, "rate_limit_exceeded");
  assert.equal(payload.limit, 60);
  assert.equal(payload.error, "Rate limit exceeded. Maximum 60 restores per hour.");

  assert.equal(
    db.runs.some((entry) =>
      /^UPDATE docs SET bytes = \?, sha256 = \?, title = \?, doc_version = \? WHERE id = \?/i.test(entry.sql)
    ),
    false
  );
});

test("POST /:id/restore requires admin token", async () => {
  const db = new MockDB([seedDoc()]);
  const env = createEnv(db, new MockBucket({ "md/doc123.md": "# Current" }));

  const response = await docsRoutes.request(
    "http://local/doc123/restore",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ version: 1 }),
    },
    env
  );

  assert.equal(response.status, 401);
  const payload = (await response.json()) as Record<string, unknown>;
  assert.equal(payload.error, "Authorization required. Pass admin_token as Bearer token.");
});

test("POST /:id/restore rejects missing version payload", async () => {
  const db = new MockDB([seedDoc()]);
  const env = createEnv(db, new MockBucket({ "md/doc123.md": "# Current" }));

  const response = await docsRoutes.request(
    "http://local/doc123/restore",
    {
      method: "POST",
      headers: {
        authorization: "Bearer sk_doc123",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    },
    env
  );

  assert.equal(response.status, 400);
  const payload = (await response.json()) as Record<string, unknown>;
  assert.equal(payload.error, "Invalid JSON body. Expected { version: number }");
});
