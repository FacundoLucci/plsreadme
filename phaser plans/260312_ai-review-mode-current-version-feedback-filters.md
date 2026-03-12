# AI Review Mode: Current-Version Feedback Filters — Phaser Plan

**Date:** 2026-03-12
**Status:** 🟡 In Progress

## Objective
- [x] Define the feature contract for AI-first review mode.
- [ ] Ship a comments review mode that defaults to **current-version feedback** so collaborators and agents see what still matters on the latest draft.
- [ ] Preserve timeline visibility (`all` comments) for audits/history without overwhelming day-to-day iteration.

## Scope
- In scope:
  - [x] Comments API filter contract for current-version vs timeline views.
  - [ ] Viewer sidebar controls for switching review mode.
  - [ ] URL/query-state persistence for review mode.
  - [ ] Automated tests for API behavior and regression safety.
- Out of scope:
  - [ ] Threaded replies or comment resolution workflows.
  - [ ] Notification fanout or digest-email redesign.
  - [ ] Schema migrations unrelated to comment filtering.

## Phases

### Phase 1 — API Filter Contract + Tests ✅ (commit: ec218fa)
**Context Scope:** `worker/routes/comments.ts` API behavior + server-side tests under `tests/`.
**Out of Scope (for this phase):** client UI controls and layout changes in docs viewer.
- [x] Add `GET /api/comments/:docId` query filter support for `view=current|all`.
- [x] Return `meta` payload describing applied filter and current doc version.
- [x] Keep backward compatibility (`all` remains default).
- [x] Add tests covering filter behavior and no-regression list semantics.
- [x] Run checks after implementation (`npm test`).

**Files:**
- `worker/routes/comments.ts` — view-filter parsing + filtered query + response metadata.
- `tests/comments-review-mode.test.ts` — API coverage for `view=all`, `view=current`, and unknown fallback.
- `phaser plans/260312_ai-review-mode-current-version-feedback-filters.md` — phase tracking.

**Acceptance Criteria:**
- [x] API supports explicit current-version filtering without breaking existing clients.
- [x] Response includes enough metadata for viewer to render review mode state.
- [x] Test suite passes with new coverage.

**Build Notes (decisions/learning):**
- Kept `view=all` as default to avoid breaking any existing consumers.
- Added lightweight `meta` contract to avoid client-side inference from comment rows.
- Unknown `view` values now normalize to `all` for safety.

**Phase Run Log:**
- [x] `2026-03-12 19:15 UTC` — Agent: coder — Status: started — Notes: validated branch safety and drafted API contract.
- [x] `2026-03-12 19:30 UTC` — Agent: coder — Status: completed — Notes: filters + tests landed in `ec218fa`; `npm test` passed.

### Phase 2 — Viewer Review-Mode UX (Current vs Timeline) ⚪
**Context Scope:** inline docs viewer template in `worker/routes/docs.ts` (comments sidebar and load behavior).
**Out of Scope (for this phase):** backend schema changes, threaded replies, notification systems.
- [ ] Add review mode controls in sidebar (`Current draft`, `Timeline`).
- [ ] Default viewer to `Current draft` when doc has multiple versions; keep `Timeline` available.
- [ ] Wire mode changes to `GET /api/comments/:docId?view=...`.
- [ ] Persist mode in URL query param for shareable review links.
- [ ] Ensure comment badges/counts reflect active mode and remain stable after posting.
- [ ] Run checks after implementation (`npm test`).

**Files:**
- `worker/routes/docs.ts` — UI controls, state, fetch params, count/badge rendering updates.
- `README.md` (optional mention if UX ships in same phase).
- `phaser plans/260312_ai-review-mode-current-version-feedback-filters.md` — phase tracking.

**Acceptance Criteria:**
- [ ] Users can switch between latest actionable feedback and full timeline.
- [ ] Default mode reduces stale-comment noise for iterative AI doc editing.
- [ ] No regression to comment posting flow.

**Build Notes (decisions/learning):**
- Pending.

**Phase Run Log:**
- [ ] `YYYY-MM-DD HH:MM UTC` — Agent: coder — Status: started — Notes:

### Phase 3 — Documentation + Rollout Validation ⚪
**Context Scope:** product docs and AI workflow guidance.
**Out of Scope (for this phase):** new backend features beyond documented scope.
- [ ] Update README feature list and usage notes for review mode.
- [ ] Update `docs/ai-iteration-versioning.md` with recommended “Current draft first, Timeline on demand” workflow.
- [ ] Run final validation checks for shipped phases (`npm test`; optional `npx wrangler deploy --dry-run` if env allows).
- [ ] Capture release notes/changelog snippet.

**Files:**
- `README.md` — feature and behavior updates.
- `docs/ai-iteration-versioning.md` — AI loop guidance.
- `phaser plans/260312_ai-review-mode-current-version-feedback-filters.md` — final status and notes.

**Acceptance Criteria:**
- [ ] Docs clearly explain review-mode behavior and why it helps AI iteration.
- [ ] Validation evidence is captured in plan run logs.
- [ ] Plan is ready for next `/loop` pass without ambiguity.

**Build Notes (decisions/learning):**
- Pending.

**Phase Run Log:**
- [ ] `YYYY-MM-DD HH:MM UTC` — Agent: coder — Status: started — Notes:

## Risks
- Risk: Clients that assume all comments always return may mis-handle filtered responses.
  Mitigation: keep default `view=all` and add explicit response `meta` for mode awareness.
- Risk: Viewer mode switching could desync counts/badges after posting.
  Mitigation: centralize render path from filtered `allComments` state and run targeted manual checks.

## Notes
- Idea selection rubric (brief):
  - **Idea A (chosen):** Current-version review mode filters — ROI **High** (clearer iteration loops), Risk **Low-Medium**, Effort **1–2 days**.
  - **Idea B:** Comment resolution workflow — ROI **High**, Risk **Medium-High** (auth + schema + permissions), Effort **2–4 days**.
  - **Idea C:** AI change digest per version — ROI **Medium-High**, Risk **High** (diff/LLM complexity), Effort **3–5+ days**.
- Chosen because it is immediately user-visible, targets AI-doc iteration pain directly, and fits a safe shippable window.
