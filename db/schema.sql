-- Outframer Waitlist Schema
-- Run with: npm run db:migrate

DROP TABLE IF EXISTS waitlist_signups;

CREATE TABLE waitlist_signups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  requested_features TEXT,
  source TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_content TEXT,
  utm_term TEXT,
  referrer TEXT,
  landing_path TEXT,
  user_agent TEXT,
  ip_hash TEXT
);

-- Index for faster email lookups
CREATE INDEX idx_waitlist_email ON waitlist_signups(email);

-- Index for analytics queries
CREATE INDEX idx_waitlist_created ON waitlist_signups(created_at);
CREATE INDEX idx_waitlist_source ON waitlist_signups(utm_source, utm_medium, utm_campaign);

-- Documents table for markdown storage
DROP TABLE IF EXISTS docs;

CREATE TABLE docs (
  id TEXT PRIMARY KEY,
  r2_key TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'text/markdown',
  bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  sha256 TEXT,
  title TEXT,
  view_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_docs_created_at ON docs(created_at);
CREATE INDEX idx_docs_sha256 ON docs(sha256);

-- Comments table
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  body TEXT NOT NULL,
  anchor_id TEXT NOT NULL DEFAULT 'doc-root',
  created_at TEXT NOT NULL,
  ip_hash TEXT,
  flagged INTEGER DEFAULT 0,
  FOREIGN KEY (doc_id) REFERENCES docs(id)
);
CREATE INDEX IF NOT EXISTS idx_comments_doc_id ON comments(doc_id, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_doc_anchor ON comments(doc_id, anchor_id, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_ip_hash ON comments(ip_hash);