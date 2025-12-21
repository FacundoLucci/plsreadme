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

