-- Add admin_token column for edit/delete without auth
ALTER TABLE docs ADD COLUMN admin_token TEXT;
CREATE INDEX idx_docs_admin_token ON docs(admin_token);
