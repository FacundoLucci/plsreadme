# Doc Versioning and Comment Anchoring

## Objective

Add soft versioning to plsreadme documents so that editing a doc doesn't break or silently orphan existing comments. Comments should remain visible and attributed to the version they were created on, while new comments attach to the current version.

## Scope

### In Scope
- Document version counter (increments on edit)
- Comments stamped with `doc_version`
- Previous-version comments shown with visual indicator
- Orphaned anchors (current version) fall back to "General"
- Previous versions stored in R2 for reference
- Version badge on comments in sidebar

### Out of Scope
- Full version history browser / diff view
- Comment migration between versions
- Version rollback
- Custom slugs / private links
- MCP tool changes (API handles versioning transparently)

## Phases

### Phase 1: Database & API Layer ✅ (0c2f92f)

Add versioning to the data model and update API endpoints.

**Primary code area:** `worker/routes/docs.ts`, `worker/types.ts`, `db/`
**Out of scope:** Frontend rendering, comment display changes

- [x] Add `doc_version INTEGER NOT NULL DEFAULT 1` column to `docs` table (migration `003_doc_version.sql`)
- [x] Add `doc_version INTEGER NOT NULL DEFAULT 1` column to `comments` table (same migration)
- [x] Update `DocRecord` and `CommentRecord` types in `worker/types.ts`
- [x] On PUT `/v/:id` (edit): increment `doc_version`, store previous markdown in R2 as `md/{id}_v{old_version}.md` before overwriting
- [x] On POST `/api/comments/:docId`: stamp new comments with current `doc_version` from docs table
- [x] Ensure GET `/api/comments/:docId` returns `doc_version` field on each comment
- [ ] Run migration against remote D1 (blocked: missing CLOUDFLARE_API_TOKEN in non-interactive environment)

**Acceptance Criteria:**
- Editing a doc increments version in DB
- Previous content preserved in R2 under versioned key
- New comments get current version number
- Existing comments (no version) treated as version 1

**Phase Run Log:**
<!-- UTC timestamps for starts/completions/blockers -->

**Build Notes:**
<!-- Decisions, tradeoffs, learnings -->

---

### Phase 2: Frontend Comment Display ✅ (5898157)

Update the preview page to visually distinguish comments from previous versions and handle orphaned anchors.

**Primary code area:** `worker/routes/docs.ts` (the `generateHtmlTemplate` function and inline JS)
**Out of scope:** API changes, R2 storage changes

- [x] Pass `doc_version` into the HTML template (from docs table on render)
- [x] In sidebar comment rendering: compare comment `doc_version` to current `doc_version`
- [x] Comments from older versions get a subtle badge: `v{n}` in muted text next to timestamp
- [x] Comments from older versions get a slightly different background (e.g., light yellow / amber tint)
- [x] Group header for older-version comments shows "(from earlier version)" label
- [x] Orphaned anchors (anchor ID not found in current DOM): fall back comment to "General" group with note "original paragraph was edited"
- [x] Dark mode styles for version badges and older-comment tint
- [x] Test: create doc, add comment, edit doc so anchor breaks → comment should appear in General with version badge

**Acceptance Criteria:**
- Comments on current version display normally (no badge)
- Comments from previous versions show version badge and visual differentiation
- Comments with broken anchors appear in General section
- Dark mode renders correctly

**Phase Run Log:**
<!-- UTC timestamps for starts/completions/blockers -->

**Build Notes:**
<!-- Decisions, tradeoffs, learnings -->

---

### Phase 3: Version Reference & Polish ⚪

Allow readers to see what a comment was referencing, and handle edge cases.

**Primary code area:** `worker/routes/docs.ts` (template JS), `worker/routes/comments.ts`
**Out of scope:** Full version browser, version rollback

- [ ] On sidebar comment from previous version: add small "view original context" link that fetches the versioned raw markdown from R2 (`/v/{id}/raw?version={n}`)
- [ ] Add `GET /v/:id/raw?version=n` endpoint: serve `md/{id}_v{n}.md` from R2 (404 if not found)
- [ ] Handle edge case: doc edited multiple times → all version comments display correctly with their respective version badges
- [ ] Handle edge case: doc with no comments → edit works exactly as before (no regressions)
- [ ] Handle edge case: comment POST on a doc that was just edited → gets latest version
- [ ] Update API resource info in MCP to mention versioning behavior
- [ ] Commit, push, deploy

**Acceptance Criteria:**
- "View original context" link works for old-version comments
- Multiple edits produce correct version chain
- No regressions on docs without comments
- Deployed and tested end-to-end

**Phase Run Log:**
<!-- UTC timestamps for starts/completions/blockers -->

**Build Notes:**
<!-- Decisions, tradeoffs, learnings -->

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| R2 storage growth from version copies | Low cost (markdown is small) | Could add version cap later (keep last N) |
| Existing comments have no `doc_version` | Display breaks | Default NULL/missing to version 1 |
| Anchor algorithm changes break versioned comments | Comments orphan | Anchor fallback to General handles this |

## Notes

- This is "Option 2" (soft versioning) from the earlier discussion
- Full version history browser is a natural premium feature add-on later
- The MCP tools don't need changes — the API handles versioning transparently on edit
- Version count is monotonic, never decremented
