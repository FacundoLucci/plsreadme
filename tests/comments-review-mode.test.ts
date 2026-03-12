import assert from "node:assert/strict";
import test from "node:test";
import { commentsRoutes } from "../worker/routes/comments.ts";

type CommentRow = {
  id: string;
  doc_id: string;
  author_name: string;
  body: string;
  anchor_id: string;
  created_at: string;
  flagged: number;
  doc_version: number;
};

type QueryRecord = { sql: string; params: unknown[] };

class MockDB {
  public alls: QueryRecord[] = [];
  public firsts: QueryRecord[] = [];
  public runs: QueryRecord[] = [];
  private readonly docVersion: number;
  private readonly comments: CommentRow[];

  constructor(docVersion: number, comments: CommentRow[]) {
    this.docVersion = docVersion;
    this.comments = comments;
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

        if (sql.includes("SELECT id, COALESCE(doc_version, 1) as doc_version FROM docs WHERE id = ?")) {
          return {
            id: "doc_abc",
            doc_version: db.docVersion,
          } as T;
        }

        return null;
      },
      async all() {
        db.alls.push({ sql, params: this.params });

        if (sql.includes("FROM comments") && sql.includes("COALESCE(doc_version, 1) = ?")) {
          const requestedVersion = Number(this.params[1]);
          return {
            results: db.comments.filter((comment) => comment.doc_version === requestedVersion),
          };
        }

        if (sql.includes("FROM comments")) {
          return { results: db.comments };
        }

        return { results: [] };
      },
    };
  }
}

function createEnv(db: MockDB) {
  return {
    DB: db,
  } as any;
}

const comments: CommentRow[] = [
  {
    id: "c1",
    doc_id: "doc_abc",
    author_name: "Ada",
    body: "Old version comment",
    anchor_id: "p1",
    created_at: "2026-03-12T10:00:00.000Z",
    flagged: 0,
    doc_version: 1,
  },
  {
    id: "c2",
    doc_id: "doc_abc",
    author_name: "Ben",
    body: "Current version comment",
    anchor_id: "p2",
    created_at: "2026-03-12T10:05:00.000Z",
    flagged: 0,
    doc_version: 2,
  },
];

test("GET /api/comments/:docId defaults to timeline view", async () => {
  const db = new MockDB(2, comments);
  const response = await commentsRoutes.request("http://local/doc_abc", { method: "GET" }, createEnv(db));

  assert.equal(response.status, 200);
  const payload = (await response.json()) as {
    comments: Array<{ id: string }>;
    meta: { view: string; current_doc_version: number };
  };

  assert.equal(payload.meta.view, "all");
  assert.equal(payload.meta.current_doc_version, 2);
  assert.equal(payload.comments.length, 2);

  const commentsQuery = db.alls.find((entry) => entry.sql.includes("FROM comments"));
  assert.ok(commentsQuery, "expected comments query");
  assert.equal(commentsQuery?.params.length, 1);
  assert.equal(commentsQuery?.params[0], "doc_abc");
});

test("GET /api/comments/:docId with view=current only returns latest-version comments", async () => {
  const db = new MockDB(2, comments);
  const response = await commentsRoutes.request(
    "http://local/doc_abc?view=current",
    { method: "GET" },
    createEnv(db)
  );

  assert.equal(response.status, 200);
  const payload = (await response.json()) as {
    comments: Array<{ id: string; doc_version: number }>;
    meta: { view: string; current_doc_version: number };
  };

  assert.equal(payload.meta.view, "current");
  assert.equal(payload.meta.current_doc_version, 2);
  assert.deepEqual(
    payload.comments.map((comment) => comment.id),
    ["c2"]
  );

  const commentsQuery = db.alls.find(
    (entry) => entry.sql.includes("FROM comments") && entry.sql.includes("COALESCE(doc_version, 1) = ?")
  );
  assert.ok(commentsQuery, "expected version-filtered comments query");
  assert.equal(commentsQuery?.params[0], "doc_abc");
  assert.equal(commentsQuery?.params[1], 2);
});

test("GET /api/comments/:docId with unknown view falls back to all", async () => {
  const db = new MockDB(2, comments);
  const response = await commentsRoutes.request(
    "http://local/doc_abc?view=unexpected",
    { method: "GET" },
    createEnv(db)
  );

  assert.equal(response.status, 200);
  const payload = (await response.json()) as {
    comments: Array<{ id: string }>;
    meta: { view: string; current_doc_version: number };
  };

  assert.equal(payload.meta.view, "all");
  assert.equal(payload.comments.length, 2);
});
