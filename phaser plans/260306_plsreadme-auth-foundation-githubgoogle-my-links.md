# plsreadme Auth Foundation (GitHub/Google + My Links) — Phaser Plan

**Date:** 2026-03-06
**Status:** ⚪ Not Started

## Objective
- [ ] Ship low-friction login (GitHub + Google) so users can reliably return and see all links they created.
- [ ] Preserve anonymous creation flow while enabling account ownership and a first-class “My Links” dashboard.
- [ ] Establish a clean foundation for future features (private docs, collaboration, analytics, billing).

## Scope
- In scope:
  - [ ] Add Clerk auth integration for web app entry points.
  - [ ] Add owner identity fields and migration strategy for docs/links records.
  - [ ] Implement authenticated “My Links” listing page (search/sort/basic filters).
  - [ ] Implement claim flow for legacy links via existing token proof.
  - [ ] Add basic telemetry for activation funnel (login → first saved link → dashboard revisit).
- Out of scope:
  - [ ] Team workspaces and org roles.
  - [ ] Billing/paywalls.
  - [ ] Full RBAC/private-sharing matrix.
  - [ ] Deep analytics dashboard beyond minimal activation metrics.

## Phases

### Phase 1 — Auth Architecture + Provider Wiring ⚪
**Context Scope:** Auth entry points, session verification boundaries, env config, deployment docs.
**Out of Scope (for this phase):** DB ownership migration and UI dashboard implementation.
- [ ] Decide auth provider contract (Clerk JWT/session model) and map required claims (stable `userId`, email, provider metadata).
- [ ] Add Clerk frontend auth wiring for GitHub and Google sign-in/sign-up.
- [ ] Add backend auth verification middleware/util in worker routes for authenticated endpoints.
- [ ] Add environment configuration docs and local/dev/prod setup checklist.
- [ ] Add abuse-safe handling for unauthenticated vs authenticated requests.
- [ ] Run checks after phase changes.

**Files:**
- `worker/index.ts` — auth middleware mount points and protected route wiring.
- `worker/routes/*.ts` (auth-gated endpoints) — session/user extraction and guard rails.
- `public/*` (or web app auth entry) — sign-in CTA and session-aware UI shell.
- `README.md` + `docs/*` — setup and deployment instructions.
- `.env.example` / config docs — provider keys and required vars.

**Acceptance Criteria:**
- [ ] Users can sign in with GitHub and Google in dev + production config.
- [ ] Backend can resolve authenticated user ID for protected endpoints.
- [ ] Anonymous users still access current public creation flow.
- [ ] Clear setup doc exists for Clerk integration and env variables.
- [ ] Lint/type/build checks pass for touched areas.

**Build Notes (decisions/learning):**
- Clerk selected over BetterAuth for speed-to-market and reduced auth maintenance burden.
- 

**Phase Run Log:**
- [ ] `2026-03-06 01:22 UTC` — Agent: gus — Status: started — Notes: Plan drafted and phase defined.
- [ ] `YYYY-MM-DD HH:MM UTC` — Agent: [name] — Status: completed/blocked — Notes: 

---

### Phase 2 — Ownership Model + Data Migration ⚪
**Context Scope:** D1 schema, ownership columns, migration scripts, route write-path updates.
**Out of Scope (for this phase):** Dashboard UX polish and claim UI flows.
- [ ] Add `owner_user_id` (and useful indexes) to docs/links tables.
- [ ] Update create/update handlers to persist ownership when authenticated.
- [ ] Keep anonymous docs supported (nullable owner) with explicit behavior.
- [ ] Add migration/backfill strategy for existing records (safe, idempotent).
- [ ] Add API-level ownership checks for edit/delete operations where applicable.
- [ ] Run checks after phase changes.

**Files:**
- `db/schema.sql` — ownership columns and indexes.
- `migrations/*` — migration scripts for existing environments.
- `worker/routes/docs.ts` — owner assignment + authorization checks.
- `worker/routes/links.ts` — owner assignment + query updates.
- `tests/*` — ownership/authorization test coverage.

**Acceptance Criteria:**
- [ ] New authenticated creates are linked to `owner_user_id`.
- [ ] Existing anonymous behavior remains functional.
- [ ] Ownership checks prevent cross-user mutation for owned records.
- [ ] Migration executes cleanly and is reversible/documented.
- [ ] Lint/type/tests pass for touched areas.

**Build Notes (decisions/learning):**
- 

**Phase Run Log:**
- [ ] `YYYY-MM-DD HH:MM UTC` — Agent: [name] — Status: started/completed/blocked — Notes: 

---

### Phase 3 — My Links Dashboard (MVP) ⚪
**Context Scope:** Authenticated UI routes, list/search/sort API query path, basic empty/loading/error states.
**Out of Scope (for this phase):** Team collaboration, advanced analytics visualizations.
- [ ] Add `/my-links` authenticated route/page.
- [ ] Implement API endpoint for current user’s links/docs with pagination and sort.
- [ ] Add search by title/slug/id and quick copy/open actions.
- [ ] Add obvious navigation entry from main page and post-create success flow.
- [ ] Add instrumentation for activation events (`login_success`, `my_links_view`, `first_saved_link`).
- [ ] Run checks after phase changes.

**Files:**
- `public/*` or app UI files for dashboard route/components.
- `worker/routes/*` for user-specific list endpoints.
- `worker/index.ts` for route registration.
- `tests/*` UI/API tests for listing and access control.

**Acceptance Criteria:**
- [ ] Signed-in user can see their created links in one place.
- [ ] List endpoint returns only caller-owned records.
- [ ] Search/sort/pagination work on realistic data sizes.
- [ ] Empty state clearly guides user to create first link.
- [ ] Lint/type/tests pass for touched areas.

**Build Notes (decisions/learning):**
- 

**Phase Run Log:**
- [ ] `YYYY-MM-DD HH:MM UTC` — Agent: [name] — Status: started/completed/blocked — Notes: 

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

**Phase Run Log:**
- [x] `2026-03-07 06:55 UTC` — Agent: coder — Status: completed — Notes: `npm test` and `npx wrangler deploy --dry-run` both passed.

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
