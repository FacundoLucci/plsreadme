-- Track raw vs likely-human views and store auth/source attribution for every new doc.
ALTER TABLE docs ADD COLUMN raw_view_count INTEGER NOT NULL DEFAULT 0;

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
