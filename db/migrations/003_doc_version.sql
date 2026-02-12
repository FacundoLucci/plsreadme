-- Add doc versioning for docs and comments
ALTER TABLE docs ADD COLUMN doc_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE comments ADD COLUMN doc_version INTEGER NOT NULL DEFAULT 1;

CREATE INDEX idx_comments_doc_version ON comments(doc_id, doc_version, created_at);
