CREATE TABLE IF NOT EXISTS upload_rate_buckets (
  scope TEXT NOT NULL,
  actor_key TEXT NOT NULL,
  window_start TEXT NOT NULL,
  count INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, actor_key, window_start)
);

CREATE TABLE IF NOT EXISTS upload_account_controls (
  user_id TEXT PRIMARY KEY,
  suspended_until TEXT,
  reason TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_upload_rate_buckets_updated_at
  ON upload_rate_buckets(updated_at);
