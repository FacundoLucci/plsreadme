# PM: Comments System for plsreadme

## Overview
Add a flat commenting system to document preview pages (`/v/:id`). Anyone can comment with a display name (stored in localStorage). Lightweight spam prevention via rate limiting + optional Turnstile captcha on suspicious behavior.

## Architecture

### Database
New `comments` table in D1:

```sql
CREATE TABLE comments (
  id TEXT PRIMARY KEY,           -- nanoid(12)
  doc_id TEXT NOT NULL,          -- FK to docs.id
  author_name TEXT NOT NULL,     -- display name (max 50 chars)
  body TEXT NOT NULL,            -- comment text (max 2000 chars)
  created_at TEXT NOT NULL,      -- ISO timestamp
  ip_hash TEXT,                  -- hashed IP for rate limiting
  flagged INTEGER DEFAULT 0,    -- 1 = hidden by spam filter
  FOREIGN KEY (doc_id) REFERENCES docs(id)
);

CREATE INDEX idx_comments_doc_id ON comments(doc_id, created_at);
CREATE INDEX idx_comments_ip_hash ON comments(ip_hash);
```

### API Routes (mounted at `/api/comments`)

- `GET /:docId` — list comments for a doc (ordered by created_at ASC), excludes flagged
- `POST /:docId` — create comment `{ author_name, body }`
  - Rate limit: 10 comments per hour per IP
  - Validates: name 1-50 chars, body 1-2000 chars
  - Returns created comment

### Spam Prevention (lightweight)
- IP-based rate limiting (10/hour)
- Basic content validation (no empty, length limits)
- Optional: Turnstile captcha triggered if >5 comments in 30 min from same IP (future enhancement, skip for V1)

### Frontend Changes
- Add comments section below document content in the viewer template (`generateHtmlTemplate` in `docs.ts`)
- Name input with localStorage persistence (`plsreadme_author_name`)
- Textarea for comment body
- Submit button
- Comments list with author name, relative timestamp, body
- Simple, clean styling matching existing design

### Files to Create/Modify

**Create:**
- `worker/routes/comments.ts` — API routes
- `db/comments.sql` — migration script

**Modify:**
- `worker/index.ts` — mount comments routes
- `worker/types.ts` — add CommentRecord interface
- `worker/routes/docs.ts` — add comments UI to the HTML template (inline JS for fetching/posting comments, localStorage name persistence)
- `db/schema.sql` — add comments table

---

## Phases

### ⚪ Phase 1: Database & API
Create the comments table migration, CommentRecord type, and `/api/comments` routes with rate limiting and validation.

**Files:** `db/comments.sql`, `db/schema.sql`, `worker/types.ts`, `worker/routes/comments.ts`, `worker/index.ts`

**Acceptance:** API endpoints work — can POST a comment and GET comments for a doc. Rate limiting enforced.

### ⚪ Phase 2: Frontend UI
Add comments section to the document viewer HTML template. Name field with localStorage, comment list, submit form. Styled to match existing design (light + dark mode).

**Files:** `worker/routes/docs.ts`

**Acceptance:** Viewing a doc at `/v/:id` shows comments section below content. Can submit and see comments. Name persists across page loads.

### ⚪ Phase 3: Polish & Deploy
Final cleanup — ensure mobile responsive, test edge cases (empty doc, long comments, special chars in names), update schema.sql to include comments table for fresh deploys.

**Files:** Various touch-ups

**Acceptance:** Clean UX on mobile + desktop, both themes. No XSS vectors. Ready to deploy.
