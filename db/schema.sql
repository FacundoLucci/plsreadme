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
  view_count INTEGER NOT NULL DEFAULT 0,
  raw_view_count INTEGER NOT NULL DEFAULT 0,
  admin_token TEXT,
  doc_version INTEGER NOT NULL DEFAULT 1,
  owner_user_id TEXT
);

CREATE INDEX idx_docs_created_at ON docs(created_at);
CREATE INDEX idx_docs_sha256 ON docs(sha256);
CREATE INDEX idx_docs_owner_user_id ON docs(owner_user_id);
CREATE INDEX idx_docs_owner_created_at ON docs(owner_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS doc_create_events (
  doc_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  source TEXT NOT NULL,
  auth_mode TEXT NOT NULL,
  client_id TEXT,
  client_name TEXT,
  actor_user_id TEXT,
  actor_email TEXT,
  actor_session_id TEXT,
  api_key_id TEXT,
  api_key_name TEXT
);
CREATE INDEX IF NOT EXISTS idx_doc_create_events_source_created ON doc_create_events(source, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_doc_create_events_auth_mode_created ON doc_create_events(auth_mode, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_doc_create_events_actor_created ON doc_create_events(actor_user_id, created_at DESC);

-- Saved/starred links
CREATE TABLE IF NOT EXISTS saved_links (
  user_id TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, doc_id),
  FOREIGN KEY (doc_id) REFERENCES docs(id)
);
CREATE INDEX IF NOT EXISTS idx_saved_links_user_created_at ON saved_links(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_saved_links_doc_user ON saved_links(doc_id, user_id);

-- Comments table
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  author_user_id TEXT,
  author_email TEXT,
  author_display_name TEXT,
  body TEXT NOT NULL,
  anchor_id TEXT NOT NULL DEFAULT 'doc-root',
  created_at TEXT NOT NULL,
  ip_hash TEXT,
  flagged INTEGER DEFAULT 0,
  doc_version INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (doc_id) REFERENCES docs(id)
);
CREATE INDEX IF NOT EXISTS idx_comments_doc_id ON comments(doc_id, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_doc_anchor ON comments(doc_id, anchor_id, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_ip_hash ON comments(ip_hash);
CREATE INDEX IF NOT EXISTS idx_comments_author_user_id ON comments(author_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS comment_notifications (
  id TEXT PRIMARY KEY,
  comment_id TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  doc_owner_user_id TEXT,
  commenter_user_id TEXT,
  commenter_email TEXT,
  commenter_display_name TEXT,
  commenter_author_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS idx_comment_notifications_doc_created ON comment_notifications(doc_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comment_notifications_owner_created ON comment_notifications(doc_owner_user_id, created_at DESC);

-- Write endpoint rate limiting events
CREATE TABLE IF NOT EXISTS request_rate_limits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_request_rate_limits_endpoint_ip_time ON request_rate_limits(endpoint, ip_hash, created_at);

-- Abuse rejection audit log (no raw payload storage)
CREATE TABLE IF NOT EXISTS abuse_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  reason TEXT NOT NULL,
  content_length INTEGER,
  payload_bytes INTEGER,
  total_chars INTEGER,
  max_line_chars INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_abuse_audit_log_created ON abuse_audit_log(created_at);
