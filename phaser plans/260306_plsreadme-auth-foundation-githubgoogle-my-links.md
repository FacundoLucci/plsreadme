# plsreadme Auth Foundation (GitHub/Google + My Links) — Phaser Plan

**Date:** 2026-03-06
**Status:** ✅ Complete (validated 2026-03-10)

## Objective
- [x] Ship low-friction login (GitHub + Google) so users can reliably return and see all links they created.
- [x] Preserve anonymous creation flow while enabling account ownership and a first-class “My Links” dashboard.
- [x] Establish a clean foundation for future features (private docs, collaboration, analytics, billing).

## Scope
- In scope:
  - [x] Add Clerk auth integration for web app entry points.
  - [x] Add owner identity fields and migration strategy for docs/links records.
  - [x] Implement authenticated “My Links” listing page (search/sort/basic filters).
  - [x] Implement claim flow for legacy links via existing token proof.
  - [x] Add basic telemetry for activation funnel (login → first saved link → dashboard revisit).
- Out of scope:
  - [ ] Team workspaces and org roles.
  - [ ] Billing/paywalls.
  - [ ] Full RBAC/private-sharing matrix.
  - [ ] Deep analytics dashboard beyond minimal activation metrics.

## Phases

### Phase 1 — Auth Architecture + Provider Wiring ✅
**Context Scope:** Auth entry points, session verification boundaries, env config, deployment docs.
**Out of Scope (for this phase):** DB ownership migration and UI dashboard implementation.
- [x] Decide auth provider contract (Clerk JWT/session model) and map required claims (stable `userId`, email, provider metadata).
- [x] Add Clerk frontend auth wiring for GitHub and Google sign-in/sign-up.
- [x] Add backend auth verification middleware/util in worker routes for authenticated endpoints.
- [x] Add environment configuration docs and local/dev/prod setup checklist.
- [x] Add abuse-safe handling for unauthenticated vs authenticated requests.
- [x] Run checks after phase changes.

**Files:**
- `worker/index.ts` — auth middleware mount points and protected route wiring.
- `worker/routes/*.ts` (auth-gated endpoints) — session/user extraction and guard rails.
- `public/*` (or web app auth entry) — sign-in CTA and session-aware UI shell.
- `README.md` + `docs/*` — setup and deployment instructions.
- `.env.example` / config docs — provider keys and required vars.

**Acceptance Criteria:**
- [x] Users can sign in with GitHub and Google in dev + production config.
- [x] Backend can resolve authenticated user ID for protected endpoints.
- [x] Anonymous users still access current public creation flow.
- [x] Clear setup doc exists for Clerk integration and env variables.
- [x] Lint/type/build checks pass for touched areas.

**Build Notes (decisions/learning):**
- Clerk selected over BetterAuth for speed-to-market and reduced auth maintenance burden.
- Primary implementation landed in `5391aea` (`feat(auth): add Clerk auth foundation and route guards (Phase 1)`).
- Follow-up auth shell and Clerk SDK hardening landed in `643aaa9`, `806748e`, `9894755`, `36f8bef`, and `1f3496c`.

**Phase Run Log:**
- [x] `2026-03-06 01:22 UTC` — Agent: gus — Status: started — Notes: Plan drafted and phase defined.
- [x] `2026-03-10 22:20 UTC` — Agent: coder — Status: completed — Notes: Existing phase implementation verified via `5391aea` (+ follow-ups listed above); `npm test` and `npx wrangler deploy --dry-run` passed.

---

### Phase 2 — Ownership Model + Data Migration ✅
**Context Scope:** D1 schema, ownership columns, migration scripts, route write-path updates.
**Out of Scope (for this phase):** Dashboard UX polish and claim UI flows.
- [x] Add `owner_user_id` (and useful indexes) to docs/links tables.
- [x] Update create/update handlers to persist ownership when authenticated.
- [x] Keep anonymous docs supported (nullable owner) with explicit behavior.
- [x] Add migration/backfill strategy for existing records (safe, idempotent).
- [x] Add API-level ownership checks for edit/delete operations where applicable.
- [x] Run checks after phase changes.

**Files:**
- `db/schema.sql` — ownership columns and indexes.
- `migrations/*` — migration scripts for existing environments.
- `worker/routes/docs.ts` — owner assignment + authorization checks.
- `worker/routes/links.ts` — owner assignment + query updates.
- `tests/*` — ownership/authorization test coverage.

**Acceptance Criteria:**
- [x] New authenticated creates are linked to `owner_user_id`.
- [x] Existing anonymous behavior remains functional.
- [x] Ownership checks prevent cross-user mutation for owned records.
- [x] Migration executes cleanly and is reversible/documented.
- [x] Lint/type/tests pass for touched areas.

**Build Notes (decisions/learning):**
- Core implementation landed in `a0449ed` (`feat(auth): add ownership model, migration, and email fallback docs (Phase 2)`).
- Added explicit owner helpers and route-level ownership enforcement (`worker/ownership.ts`, updated docs/links routes).
- Downstream My Links work in `aa74b5d` + `db0cc18` validated owner scoping against realistic listing queries.

**Phase Run Log:**
- [x] `2026-03-10 22:22 UTC` — Agent: coder — Status: completed — Notes: Existing phase implementation verified via `a0449ed`; checks re-run (`npm test`, `npx wrangler deploy --dry-run`) and passed.

---

### Phase 3 — My Links Dashboard (MVP) ✅
**Context Scope:** Authenticated UI routes, list/search/sort API query path, basic empty/loading/error states.
**Out of Scope (for this phase):** Team collaboration, advanced analytics visualizations.
- [x] Add `/my-links` authenticated route/page.
- [x] Implement API endpoint for current user’s links/docs with pagination and sort.
- [x] Add search by title/slug/id and quick copy/open actions.
- [x] Add obvious navigation entry from main page and post-create success flow.
- [x] Add instrumentation for activation events (`login_success`, `my_links_view`, `first_saved_link`).
- [x] Run checks after phase changes.

**Files:**
- `public/*` or app UI files for dashboard route/components.
- `worker/routes/*` for user-specific list endpoints.
- `worker/index.ts` for route registration.
- `tests/*` UI/API tests for listing and access control.

**Acceptance Criteria:**
- [x] Signed-in user can see their created links in one place.
- [x] List endpoint returns only caller-owned records.
- [x] Search/sort/pagination work on realistic data sizes.
- [x] Empty state clearly guides user to create first link.
- [x] Lint/type/tests pass for touched areas.

**Build Notes (decisions/learning):**
- Dashboard UI and initial API wiring landed in `aa74b5d` (`feat: add my links dashboard and migration audit`).
- Owner-scoped pagination/search behavior refined in `db0cc18` (`feat(auth): add owner-scoped My Links API (Phase 3 chunk 1)`).
- Clerk-aware viewer shell updates in `1f3496c` ensured session continuity on `/v` pages after login.

**Phase Run Log:**
- [x] `2026-03-10 22:24 UTC` — Agent: coder — Status: completed — Notes: Existing phase implementation verified via `aa74b5d` + `db0cc18`; checks re-run (`npm test`, `npx wrangler deploy --dry-run`) and passed.

---

### Phase 4 — Legacy Link Claim + Rollout Hardening ✅
**Context Scope:** Claim API/UX, rollout guards, metrics verification, release readiness.
**Out of Scope (for this phase):** Monetization and team permissions.
- [x] Implement “Claim this link” flow for legacy anonymous links using existing edit/admin token proof.
- [x] Add guard rails to prevent unauthorized claiming.
- [x] Add migration helper UI copy and support notes.
- [x] Validate rollout checklist (envs, secrets, migration order, rollback).
- [x] Define launch KPIs and dashboards for first week.
- [x] Run checks after phase changes.

**Files:**
- `worker/routes/*` — claim endpoint(s) + validation logic.
- `public/*` — claim CTA and confirmation/error flows.
- `docs/runbooks/*` — rollout + rollback playbook.
- `tests/*` — claim authorization and edge-case tests.

**Acceptance Criteria:**
- [x] Legacy links can be claimed by legitimate controller (token proof).
- [x] Unauthorized users cannot claim others’ links.
- [x] Rollout/rollback docs are complete and tested in staging.
- [x] Core KPIs available for post-launch review.
- [x] Lint/type/tests pass for touched areas.

**Build Notes (decisions/learning):**
- Added `/api/auth/claim-link` with authenticated + token-proof requirements, plus owner-mismatch and invalid-proof guard rails.
- Reused existing ownership semantics: claimed links remain protected by owner session checks in update/delete flows.
- Added My Links “Claim a legacy link” helper UX with support-oriented copy and clear status handling.
- Added rollout runbook with explicit env/secrets/migration order + rollback + week-one KPI checklist.
- Implementation landed in `e9cc015`.

**Phase Run Log:**
- [x] `2026-03-07 06:55 UTC` — Agent: coder — Status: completed — Notes: `npm test` and `npx wrangler deploy --dry-run` both passed.
- [x] `2026-03-10 22:26 UTC` — Agent: coder — Status: re-validated — Notes: Current branch still passes `npm test` and `npx wrangler deploy --dry-run` during phase-loop completion pass.

## Risks
- Risk: Auth misconfiguration blocks sign-in in prod.
  Mitigation: staged environment checklist, smoke tests for each provider before release.
- Risk: Ownership migration impacts existing anonymous workflows.
  Mitigation: nullable owner model + feature flag + migration dry-run.
- Risk: Claim flow becomes account-takeover vector.
  Mitigation: require token proof + short-lived verification + rate limiting + audit logs.
- Risk: Over-scoping delays core usability fix.
  Mitigation: strict MVP definition (My Links first, no teams/billing in this plan).

## Notes
- Preferred provider for this plan: **Clerk** (speed and lower auth ops burden).
- BetterAuth can be revisited post-traction if migration/control economics justify it.
- Suggested KPI targets (first 2 weeks post-launch):
  - login conversion ≥ 25% of creators
  - first-day dashboard revisit ≥ 30%
  - “can’t find my link” support complaints reduced by >70%
