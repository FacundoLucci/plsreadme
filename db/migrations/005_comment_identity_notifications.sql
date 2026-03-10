-- Add authenticated commenter identity fields + notification metadata stash
ALTER TABLE comments ADD COLUMN author_user_id TEXT;
ALTER TABLE comments ADD COLUMN author_email TEXT;
ALTER TABLE comments ADD COLUMN author_display_name TEXT;

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
