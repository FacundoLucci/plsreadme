CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  ip_hash TEXT,
  flagged INTEGER DEFAULT 0,
  FOREIGN KEY (doc_id) REFERENCES docs(id)
);
CREATE INDEX IF NOT EXISTS idx_comments_doc_id ON comments(doc_id, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_ip_hash ON comments(ip_hash);
