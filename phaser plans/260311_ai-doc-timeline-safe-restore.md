# AI Doc Timeline + Safe Restore — Phaser Plan

**Date:** 2026-03-11
**Status:** ✅ Complete

## Objective
- [x] Ship a clear iteration timeline so AI-generated docs can be reviewed with confidence.
- [x] Add a safe rollback flow so users can recover from bad AI edits without data loss.
- [x] Make version-aware collaboration easy (share exact revision context during feedback loops).

## Scope
- In scope:
  - [x] Version history discovery endpoints + lightweight history page.
  - [x] Admin-token + owner-safe restore API for prior revisions.
  - [x] UX affordances for “restore this version” with clear confirmation copy.
  - [x] Minimal docs/tests to keep behavior stable and maintainable.
- Out of scope:
  - [ ] Full text diff viewer.
  - [ ] Branching/parallel version trees.
  - [ ] Real-time multi-user editing.
  - [ ] Billing/roles/enterprise permissions.

## Phases

### Phase 1 — Timeline Discovery Surface ✅ (`c393be0`)
**Context Scope:** `worker/routes/docs.ts` viewer/API route layer + targeted tests for version timeline behavior.
**Out of Scope (for this phase):** mutation/restore logic, schema changes, complex modal UI.
- [x] Add `GET /v/:id/versions` JSON timeline endpoint (descending versions, current marker, raw links).
- [x] Add `GET /v/:id/history` human-readable page to browse snapshots quickly.
- [x] Add “History” entry in viewer toolbar for direct discovery from shared docs.
- [x] Add automated tests for timeline JSON + history page rendering + 404 behavior.
- [x] Run validation checks after implementation (`npm test`; additional `npx tsc --noEmit` attempted).

**Files:**
- `worker/routes/docs.ts` — version timeline helpers + `/versions` + `/history` routes + toolbar link.
- `tests/doc-version-history.test.ts` — route-level coverage for timeline and history rendering.

**Acceptance Criteria:**
- [x] Existing docs render unchanged while exposing a visible “History” entry.
- [x] Timeline API returns deterministic version list from current version down to v1.
- [x] History page lists current + archived snapshot links.
- [x] Missing docs return 404 for timeline endpoint.
- [x] Test suite passes.

**Build Notes (decisions/learning):**
- Kept timeline generation DB-driven from `doc_version` to avoid expensive R2 listing calls.
- Added both JSON and human-readable endpoints so MCP/automation and humans can use the same source.
- Typecheck shows pre-existing repo issues unrelated to this phase (`worker/mcp-agent.ts` SDK mismatch and `worker/routes/auth.ts` nullable warning).

**Phase Run Log:**
- [x] `2026-03-11 19:03 UTC` — Agent: coder — Status: started — Notes: Created feature branch and seeded Phaser plan.
- [x] `2026-03-11 19:08 UTC` — Agent: coder — Status: completed — Notes: Implemented timeline/history endpoints + tests; `npm test` passed.

### Phase 2 — Safe Restore API (token + owner checks) ✅ (`6b044eb`)
**Context Scope:** `worker/routes/docs.ts` update/authorization flow + R2 archival semantics + regression tests.
**Out of Scope (for this phase):** frontend confirmation UI polish.
- [x] Add `POST /v/:id/restore` accepting `{ version }` and requiring admin token.
- [x] Reuse owner-auth guard so owned docs can only be restored by current owner session.
- [x] Archive current markdown before restore and increment `doc_version` monotonically.
- [x] Return restoration payload with new current version and URLs.
- [x] Add tests for success, unauthorized restore, missing version, and owner mismatch.
- [x] Run checks after phase changes.

**Files:**
- `worker/routes/docs.ts` — restore endpoint and storage/version mutation path.
- `tests/ownership-auth.test.ts` + `tests/doc-version-history.test.ts` — restore auth + timeline correctness after restore.

**Acceptance Criteria:**
- [x] Restore never overwrites history destructively.
- [x] Cross-user restore attempts are blocked.
- [x] Current version increases after restore and remains recoverable.
- [x] Tests cover happy path + guard rails.

**Build Notes (decisions/learning):**
- Kept restore auth layered: admin token validation first, then owned-doc session enforcement to block cross-user restores.
- Used archive-first restore semantics (`md/<id>_v<current>.md` before rewriting canonical `md/<id>.md`) so rollback is non-destructive.
- Restores always advance `doc_version` and return direct viewer/raw/history URLs, making post-restore review deterministic.

**Phase Run Log:**
- [x] `2026-03-12 03:55 UTC` — Agent: coder — Status: started — Notes: Began Phase 2 safe-restore implementation + test expansion.
- [x] `2026-03-12 04:05 UTC` — Agent: coder — Status: completed — Notes: Added restore endpoint + auth guards + archival/version bump flow; tests passed; committed as `6b044eb6881e8f8883f4a66acc7e75c63a3969d9`.

### Phase 3 — Restore UX + Review Loop Clarity ✅ (`30c880e`)
**Context Scope:** viewer template UX in `generateHtmlTemplate` + minimal inline JS interactions.
**Out of Scope (for this phase):** heavy diff visualizations.
- [x] Add a lightweight restore action entry from history page (with explicit warning text).
- [x] Surface “current version” badge in viewer header/toolbar for context while commenting.
- [x] Show restore success state and link back to readable doc.
- [x] Add test coverage for history-page affordances.
- [x] Run checks after phase changes.

**Files:**
- `worker/routes/docs.ts` — history page markup and small client-side behaviors.
- `tests/doc-version-history.test.ts` — verify rendered affordances.

**Acceptance Criteria:**
- [x] Users can identify current vs historical versions without reading raw URLs.
- [x] Restore UI flow is explicit and hard to trigger accidentally.
- [x] No regression to commenting and sharing flows.

**Build Notes (decisions/learning):**
- Added explicit restore safety UX in history view (warning copy, admin-token field, confirm prompt, and success/error status states) so rollback intent is clear before action.
- Introduced persistent current-version context in both the viewer header and bottom toolbar, reducing ambiguity during review/comment loops.
- Kept affordances test-driven by expanding history-page and viewer rendering assertions, including “no restore for current version” behavior.

**Phase Run Log:**
- [x] `2026-03-12 04:10 UTC` — Agent: coder — Status: started — Notes: Began Phase 3 UX polish for restore safety + version context.
- [x] `2026-03-12 04:13 UTC` — Agent: coder — Status: completed — Notes: Implemented restore panel/actions + current-version badges + test updates; `npm test` passed; committed as `30c880eef32ce2ef071ccfa14f11fee490c69c0e`. 

### Phase 4 — Trust/Safety + Automation Hand-off ✅ (`a60418d`)
**Context Scope:** docs + MCP-facing usage notes + operational hardening.
**Out of Scope (for this phase):** analytics dashboard build-out.
- [x] Update README/docs with version timeline + restore usage patterns for AI iteration workflows.
- [x] Add simple abuse guard (rate-limit restore endpoint similarly to updates if needed).
- [x] Document MCP/agent consumption of `/versions` for auto-review loops.
- [x] Run checks after phase changes.

**Files:**
- `README.md` — surfaced timeline/restore APIs, MCP loop guidance, and updated rate-limit table.
- `docs/ai-iteration-versioning.md` — dedicated human + agent playbook for `/versions` and safe restore.
- `worker/routes/docs.ts` + `worker/security.ts` — restore endpoint now uses update-style actor-key rate limiting.
- `tests/doc-version-history.test.ts` — restore-rate-limit regression coverage.

**Acceptance Criteria:**
- [x] Feature is documented for both human and agent users.
- [x] Restore behavior is rate-limited and safe-by-default.
- [x] End-to-end checks pass.

**Build Notes (decisions/learning):**
- Consolidated hand-off docs into both README quick-start guidance and a deeper `docs/ai-iteration-versioning.md` playbook to support human review and MCP automation.
- Standardized restore abuse protection to the same actor-key limiter profile as updates (`60/hour`), reducing policy drift across mutation routes.
- Added explicit restore 429 regression coverage to keep safety behavior stable as route logic evolves.

**Phase Run Log:**
- [x] `2026-03-12 04:16 UTC` — Agent: coder — Status: started — Notes: Began Phase 4 docs hand-off + trust/safety hardening pass.
- [x] `2026-03-12 04:19 UTC` — Agent: coder — Status: completed — Notes: Shipped README + playbook docs + restore rate-limit hardening + tests; `npm test` passed; committed as `a60418d8b38d2466c0fb24efcb06b9a52984a204`. 

## Risks
- Risk: Restore endpoint could become destructive if version archiving is skipped.
  Mitigation: enforce archive-first write order and test for monotonic `doc_version` increments.
- Risk: Token leakage enables unauthorized restore attempts.
  Mitigation: keep existing token auth + owner session checks; avoid exposing restore in anonymous pathways.
- Risk: Version list may include entries whose archived object was manually deleted.
  Mitigation: restore endpoint validates object existence; history page copy clarifies when a snapshot is unavailable.

## Notes
- This plan extends prior versioning work (`260212_doc-versioning-and-comment-anchoring.md`) by adding discoverability + rollback.
- Designed for high user-visible value in AI doc iteration loops (draft → feedback → refine → recover quickly).
