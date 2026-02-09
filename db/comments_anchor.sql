-- Add anchor support for comments (safe migration)
-- Run after existing schema has comments table

ALTER TABLE comments ADD COLUMN anchor_id TEXT;

UPDATE comments
SET anchor_id = 'doc-root'
WHERE anchor_id IS NULL OR anchor_id = '';

CREATE INDEX IF NOT EXISTS idx_comments_doc_anchor
  ON comments(doc_id, anchor_id, created_at);
