-- Phase 2: Optional ownership on docs for authenticated users.
-- Existing anonymous docs remain valid with owner_user_id = NULL.
ALTER TABLE docs ADD COLUMN owner_user_id TEXT;

CREATE INDEX IF NOT EXISTS idx_docs_owner_user_id ON docs(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_docs_owner_created_at ON docs(owner_user_id, created_at DESC);
