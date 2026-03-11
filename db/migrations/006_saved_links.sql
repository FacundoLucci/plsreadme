-- Add saved/starred links table for authenticated users.
CREATE TABLE IF NOT EXISTS saved_links (
  user_id TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, doc_id)
);

CREATE INDEX IF NOT EXISTS idx_saved_links_user_created_at ON saved_links(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_saved_links_doc_user ON saved_links(doc_id, user_id);
