# MCP Auth UX + Demoable Web Flow — Phase Plan

**Date:** 2026-04-03
**Status:** ✅ Completed

## Objective
Build a secure auth model for plsreadme where the website remains instantly demoable without MCP setup, supported MCP clients use a browser login flow for the best UX, unsupported clients use a personal API key, and every authenticated create is owned and attributable.

## Scope
- In scope:
  - login-based auth for hosted remote MCP where client support allows it
  - API key auth as a first-class fallback for remote MCP and local npm MCP
  - anonymous website demo flow that stays fast but becomes abuse-resistant
  - ownership binding, source attribution, rate limiting, and migration guidance
  - updated docs and website UX that explain the path split clearly
- Out of scope:
  - billing, quotas, or paid plans
  - org/team RBAC and enterprise policy features
  - replacing Clerk with a different auth provider
  - removing anonymous website demos entirely

## Plan Structure
- Phase 1 defines the product/auth contract and immediate containment plan.
- Phase 2 preserves the anonymous website demo path while tightening abuse controls.
- Phase 3 adds browser-login UX for hosted remote MCP.
- Phase 4 adds API key fallback and local npm MCP auth UX.
- Phase 5 hardens backend enforcement, telemetry, and metrics attribution.
- Phase 6 handles rollout, docs, migration, and compatibility guidance.

## Phase Design Principle (Critical)
- Never force first-time website visitors through auth just to try the product.
- Prefer browser login for supported MCP clients because it is the best UX and gives automatic ownership.
- Always offer API key auth for clients that cannot complete interactive login.
- Treat website demo and programmable/editor automation as separate trust surfaces with different controls.
- Every phase must preserve at least one clean working path end-to-end: website demo, hosted remote MCP, or local npm MCP.

## Status Markers
- `⚪` Not started
- `🟡` In progress
- `✅` Completed
- `🟠` Blocked by external dependency
- `🔴` At risk / needs redesign

## Quality Rules
- Keep the anonymous website demo path under 30 seconds from landing to first share.
- Keep the recommended MCP auth path to one sign-in and one config step where client support allows it.
- Treat API key auth as a supported method, not a hidden escape hatch.
- Stamp every create with source and auth mode so future spikes are attributable.
- Use durable server-side rate limits and abuse logs on every public AI or MCP surface.
- Run feature-specific checks after each implementation phase (`npm test`, deployment packaging checks, and targeted smoke tests).

## Phases

### Phase 1: Product Contract + Immediate Containment ✅
**Context Scope (Required)**
- Primary code area(s) in scope:
  - `worker/index.ts`
  - `worker/mcp-agent.ts`
  - `packages/mcp/src/index.ts`
- Primary docs/specs in scope:
  - `README.md`
  - `packages/mcp/README.md`
  - `docs/auth-clerk.md`
- Out-of-scope areas for that phase:
  - visual redesign of the broader marketing site
  - billing and pricing concepts

**Task Checklist**
- [✅] Define three official journeys: anonymous website demo, hosted remote MCP with login, MCP with API key auth.
- [✅] Decide recommendation order in docs and UI: website demo first, hosted login second, API key fallback third.
- [✅] Decide immediate containment behavior for the currently public hosted remote MCP surface while the new auth flows are built.
- [✅] Define ownership rules for each journey (`owner_user_id`, anonymous fallback, claim-link compatibility, mutation rules).
- [✅] Define source attribution values for every create path (`web_demo`, `web_signed_in`, `mcp_remote_login`, `mcp_remote_api_key`, `mcp_local_api_key`, `mcp_local_anonymous`).
- [✅] Define user-facing copy for auth failures, unsupported clients, and fallback recommendations.

**Files to Modify**
- `README.md`
- `packages/mcp/README.md`
- `docs/auth-clerk.md`
- `worker/index.ts`
- `worker/mcp-agent.ts`

**Acceptance Criteria**
- [✅] A written product contract exists for login-first plus API-key fallback.
- [✅] Containment for the hosted remote MCP surface is explicit and implementation-ready.
- [✅] Ownership and attribution rules are unambiguous for every create path.

**Build Notes (Decisions/Learnings)**
- `2026-04-04 14:07 UTC` — Starting Phase 1 execution. Current code already auto-binds website-created docs to `owner_user_id` when a valid Clerk session is present, but hosted `/mcp` and `/sse` remain fully public. Immediate containment will block hosted remote MCP while preserving the website demo path and local stdio MCP package flow.
- `2026-04-04 14:11 UTC` — Hosted remote MCP containment now happens before Durable Object handoff via `worker/index.ts`, so `/mcp`, `/sse`, and `/sse/message` return a consistent `403` fallback response while the website and local npm MCP path remain available. Product-contract docs now define recommendation order, ownership rules, source tags, and fallback copy in `README.md`, `packages/mcp/README.md`, and `docs/auth-clerk.md`.

**Phase Run Log (UTC timestamps)**
- [ ] `2026-04-03 00:00 UTC` — Agent: coder — Status: planned — Notes: phase scaffold created.
- [✅] `2026-04-04 14:07 UTC` — Agent: Codex — Status: in progress — Notes: began Phase 1; inspecting current auth/create behavior and preparing hosted remote MCP containment plus contract docs.
- [✅] `2026-04-04 14:11 UTC` — Agent: Codex — Status: completed — Notes: added hosted remote MCP containment response + tests, updated auth/product contract docs, ran `npm test` and `npx wrangler deploy --dry-run` successfully.

**Risks + Mitigations**
- Risk: client login support varies more than expected.
  Mitigation: keep API key auth first-class in both product contract and docs.
- Risk: containment accidentally breaks all live demos.
  Mitigation: keep website demo separated from hosted remote MCP controls.

### Phase 2: Website Demo Flow (Anonymous but Abuse-Resistant) ✅
**Context Scope (Required)**
- Primary code area(s) in scope:
  - `public/index.html`
  - `public/app.html`
  - `public/app.js`
  - `worker/routes/docs.ts`
  - `worker/security.ts`
- Primary docs/specs in scope:
  - `README.md`
  - `docs/auth-clerk.md`
- Out-of-scope areas for that phase:
  - hosted remote MCP login transport
  - local npm MCP auth setup

**Task Checklist**
- [✅] Keep paste/upload/share available from the website without requiring login or MCP setup.
- [✅] Replace the current raw anonymous create trust model with a browser-scoped proof for website demos (for example Turnstile, signed demo grant, or similar browser-only challenge).
- [✅] Ensure signed-in website creates remain frictionless and automatically owned when trust signals are good.
- [✅] Add post-create UI actions for `Save to my account`, `Connect your editor`, and `Copy link`.
- [✅] Separate anonymous website demo rate limits from authenticated website limits.
- [✅] Define blocked/suspicious-traffic UX that still gives users a path forward through sign-in or a verified browser flow.

**Files to Modify**
- `public/index.html`
- `public/app.html`
- `public/app.js`
- `public/clerk-auth-shell.js`
- `worker/routes/docs.ts`
- `worker/security.ts`

**Acceptance Criteria**
- [✅] A first-time visitor can still create a share link from the website without an account.
- [✅] Anonymous scripted traffic can no longer reuse the same create surface without the browser proof.
- [✅] Signed-in website users get owned docs automatically.
- [✅] The post-create experience clearly branches into save/manage/editor-connect next steps.

**Build Notes (Decisions/Learnings)**
- `2026-04-04 14:23 UTC` — Phase 2 work started. Implementation direction: require a short-lived browser demo grant for anonymous website creates on `/api/create-link`, back the grant with D1 + an HttpOnly cookie so simple raw POST reuse fails, keep signed-in website flows grant-free, and add post-create save/editor actions to the homepage and app UI.
- `2026-04-04 14:26 UTC` — Anonymous website create now requires `GET /api/auth/demo-grant` + a one-time D1-backed demo grant cookie, while authenticated website create continues to bypass that proof. `public/app.html`, `public/app.js`, and `public/index.html` now branch post-create into save/editor/copy next steps, and anonymous error states offer either browser re-verification or sign-in recovery. Checks passed: `node --experimental-strip-types --test tests/demo-grant.test.ts tests/website-demo-ui.test.ts`, `npm test`, and `npx wrangler deploy --dry-run`.

**Phase Run Log (UTC timestamps)**
- [ ] `2026-04-03 00:00 UTC` — Agent: coder — Status: planned — Notes: phase scaffold created.
- [✅] `2026-04-04 14:23 UTC` — Agent: Codex — Status: in progress — Notes: implementing browser-scoped demo grants, separate anonymous website rate limits, and post-create website actions for save/editor/copy flows.
- [✅] `2026-04-04 14:26 UTC` — Agent: Codex — Status: completed — Notes: shipped one-time anonymous demo grants, split website create rate limits, added homepage/app recovery and post-create actions, updated docs, and reran the full test + dry-run packaging checks successfully.

**Risks + Mitigations**
- Risk: adding a challenge hurts demo conversion.
  Mitigation: use adaptive friction only for anonymous browser demos and keep signed-in flows challenge-light.
- Risk: website and API behavior drift apart.
  Mitigation: document website-demo-specific proof rules explicitly and keep create pipeline shared under the hood.

### Phase 3: Hosted Remote MCP Login Flow ✅
**Context Scope (Required)**
- Primary code area(s) in scope:
  - `worker/mcp-agent.ts`
  - `worker/index.ts`
  - `worker/auth.ts`
  - `public/mcp.html`
  - `public/mcp-setup.html`
- Primary docs/specs in scope:
  - `README.md`
  - `docs/auth-clerk.md`
  - `packages/mcp/README.md`
- Out-of-scope areas for that phase:
  - local npm MCP token persistence details
  - anonymous website demo controls

**Task Checklist**
- [✅] Implement browser-login auth for hosted remote MCP on clients that support interactive auth well.
- [✅] Define session lifecycle, reconnect behavior, token refresh/revocation behavior, and logout semantics for remote MCP.
- [✅] Add a `Connect your editor` website flow that signs users in and shows client-specific setup instructions after auth.
- [✅] Ensure hosted remote MCP creates are owned and tagged `mcp_remote_login`.
- [✅] Add actionable error responses for expired login, revoked access, unsupported login flow, and missing capability support.
- [✅] Add a compatibility matrix that marks login-supported clients vs API-key-required clients.

**Files to Modify**
- `worker/mcp-agent.ts`
- `worker/index.ts`
- `worker/auth.ts`
- `worker/mcp-oauth.ts`
- `worker/mcp-create.ts`
- `worker/routes/auth.ts`
- `worker/types.ts`
- `public/mcp.html`
- `public/mcp-setup.html`
- `README.md`
- `docs/auth-clerk.md`
- `packages/mcp/README.md`
- `wrangler.jsonc`
- `tests/mcp-remote-login.test.ts`
- `tests/mcp-grants.test.ts`

**Acceptance Criteria**
- [✅] A supported MCP client can sign in once and create owned docs without manual token copying.
- [✅] Hosted remote MCP login failures degrade cleanly into documented fallback steps.
- [✅] Hosted remote MCP creates are attributable as `mcp_remote_login`.

**Build Notes (Decisions/Learnings)**
- `2026-04-04 14:26 UTC` — Blocked pending external capability validation. The repo has no remote OAuth callback/session transport, no client capability matrix, and no verified path for editor-specific browser-login handoff. Phase 3 acceptance requires a real supported-client login flow plus documented compatibility guarantees, which cannot be implemented safely from local code alone without current client/protocol verification.
- `2026-04-04 16:02 UTC` — Reopened after verifying current MCP and client docs. Cloudflare’s `workers-oauth-provider` can wrap the existing `McpAgent.serve("/mcp")` handler, and current Claude Code / Windsurf / MCP auth docs confirm supported remote OAuth login flows. Implementation direction: protect `/mcp` and `/sse` with OAuth, use the existing Clerk session as the authorization UI identity layer, pass grant props into `McpAgent`, and update the MCP setup page to recommend remote login first while keeping local npm setup as the fallback.
- `2026-04-04 15:21 UTC` — Added explicit hosted-MCP grant lifecycle controls via `GET /api/auth/mcp-grants` and `DELETE /api/auth/mcp-grants/:grantId`, documented access/refresh TTLs plus logout semantics, and recorded the required `OAUTH_KV` Cloudflare Workers KV binding in worker config/docs. The worker packages and tests pass locally, but production rollout is still blocked until that binding exists in the deployed Cloudflare account and one real hosted editor login is verified end to end.
- `2026-04-04 15:24 UTC` — Provisioned dedicated Cloudflare KV namespaces for hosted OAuth (`OAUTH_KV` production + preview), updated `wrangler.jsonc` with the live namespace IDs, and confirmed `npx wrangler deploy --dry-run` now exposes `env.OAUTH_KV`. The remaining blocker is no longer storage provisioning; it is a real deploy plus supported-client verification against the live worker.
- `2026-04-04 20:02 UTC` — Deployed the updated worker live (Cloudflare version `cc9ee01f-a616-4554-8935-7b4754fe5e3d`) and verified the production OAuth metadata + `401` challenge contract on `https://plsreadme.com/mcp`. Claude Code recognizes the server as `Needs authentication`, which matches the live OAuth gate, but I could not complete the final approval flow because the available browser context is signed out of Clerk and no reusable account credentials/session were available for a real browser login.
- `2026-04-04 20:15 UTC` — Investigated the live “Continue does nothing” report and confirmed the hosted Clerk account portal was accepting credentials but leaving the user on the same page after a hidden `needs_client_trust` step. Replaced hosted redirects with first-party `/sign-in` and `/sign-up` pages on `plsreadme.com`, mounted Clerk’s embedded auth components locally, switched the Clerk SDK loader to the official frontend-API UI bundle (`clerk.plsreadme.com/npm/@clerk/clerk-js@5/...`), and redeployed. Live browser verification now shows the embedded email/password/passkey sign-in form on `plsreadme.com` instead of the stuck `accounts.plsreadme.com` dialog.
- `2026-04-04 20:46 UTC` — Followed up on a live signup failure at `/sign-up/verify-email-address?...` and confirmed Clerk’s path-based embedded auth flow needs the worker to serve nested auth routes, not only `/sign-in` and `/sign-up`. Added wildcard worker routes plus matching `run_worker_first` asset patterns for `/sign-in/*` and `/sign-up/*`, redeployed, and verified the exact failing URL now renders Clerk’s email-verification step on `plsreadme.com` with no console errors.
- `2026-04-04 20:52 UTC` — Verified the supported-client handshake shape with Claude Code itself: `claude -p` now exposes `mcp__plsreadme-live__authenticate`, returns a valid OAuth authorization URL, and the live approval page renders signed-in account context plus the `Approve and continue` button. Clicking approval issues a real authorization code redirect back to the client’s localhost callback URL, which proves the hosted server/browser side is working. The remaining gap is client-side automation only: Claude’s one-shot `-p` flow exits before its localhost callback listener can stay alive long enough to receive the redirect, so end-to-end owned-doc verification still needs a real interactive Claude Code session rather than a headless print invocation.
- `2026-04-05 16:52 UTC` — Closed the last Phase 3 blocker using a real interactive user verification: the signed-in `plsreadme-live` Claude Code session successfully called `plsreadme_share_text`, returned a live share URL, and did so without manual token copying. That satisfies the supported-client proof for hosted remote login and upgrades the phase from blocked to complete.

**Phase Run Log (UTC timestamps)**
- [ ] `2026-04-03 00:00 UTC` — Agent: coder — Status: planned — Notes: phase scaffold created.
- [❌] `2026-04-04 14:26 UTC` — Agent: Codex — Status: blocked — Notes: stopped before Phase 3 implementation because supported-client remote auth behavior and compatibility guarantees need current external verification and a concrete callback/session design.
- [✅] `2026-04-04 16:02 UTC` — Agent: Codex — Status: in progress — Notes: verified current MCP/client OAuth support, cleared the external blocker, and resumed Phase 3 implementation around a Cloudflare OAuth wrapper + Clerk-backed authorization UI.
- [❌] `2026-04-04 15:21 UTC` — Agent: Codex — Status: blocked — Notes: finished the hosted OAuth wrapper, grant lifecycle/revocation endpoints, setup/docs updates, and remote-login tests; `npm test` and `npx wrangler deploy --dry-run` both passed, but Phase 3 remains externally blocked until `OAUTH_KV` is provisioned in the deployed Cloudflare environment and one supported client is verified against the live worker.
- [❌] `2026-04-04 15:24 UTC` — Agent: Codex — Status: blocked — Notes: provisioned the dedicated `OAUTH_KV` namespaces and wired them into `wrangler.jsonc`, then reran `npx wrangler deploy --dry-run` to confirm the binding is present. Phase 3 is still blocked on the last acceptance step: deploying the updated worker and verifying the browser-login flow from one real supported MCP client end to end.
- [❌] `2026-04-04 20:02 UTC` — Agent: Codex — Status: blocked — Notes: deployed the worker live, confirmed `.well-known/oauth-authorization-server` and the live `/mcp` OAuth challenge response, and verified Claude Code sees `plsreadme-live` as an auth-required HTTP MCP server. Final acceptance is still blocked on one real Clerk-backed browser approval because the available browser context is signed out and no reusable credentials/session were available to finish the supported-client login flow.
- [❌] `2026-04-04 20:15 UTC` — Agent: Codex — Status: blocked — Notes: fixed the live user-reported Clerk login stall by moving browser login onto first-party `/sign-in` and `/sign-up` pages, swapping to Clerk’s UI-capable frontend-API script bundle, and deploying Cloudflare version `22f84418-b7fb-40de-b23a-49dc0e1df105`. Targeted auth-page tests, `npm test`, `npx wrangler deploy --dry-run`, and live browser verification of the embedded sign-in form all passed. Phase 3 remains blocked only on the last acceptance step: one real supported MCP client must still complete login and create an owned doc end to end.
- [❌] `2026-04-04 20:46 UTC` — Agent: Codex — Status: blocked — Notes: fixed the live signup 404 by serving Clerk’s nested path-based auth routes (`/sign-in/*`, `/sign-up/*`) through the worker and asset config, then deployed Cloudflare version `6f8333a0-dd34-4695-a937-29383e2f0c1b`. `node --experimental-strip-types --test tests/auth-pages-ui.test.ts`, `npm test`, `npx wrangler deploy --dry-run`, and live browser verification of `https://plsreadme.com/sign-up/verify-email-address?...` all passed. Phase 3 is still blocked only on the original final acceptance step: one supported MCP client must finish login and create an owned doc end to end.
- [❌] `2026-04-04 20:52 UTC` — Agent: Codex — Status: blocked — Notes: used Claude Code itself as the supported client and confirmed it now surfaces `mcp__plsreadme-live__authenticate`, generates a valid OAuth authorization URL, and reaches the live signed-in approval screen. Approving the grant returns a real authorization code redirect to the client’s localhost callback URL, but the automated `claude -p` process exits before a localhost listener remains alive to receive it. This leaves Phase 3 blocked only on the last interactive-client proof: run the same auth flow in a real Claude Code session, keep that session open during browser approval, and then complete one owned `plsreadme_share_text` create.
- [✅] `2026-04-05 16:52 UTC` — Agent: Codex — Status: completed — Notes: recorded the user’s successful live `plsreadme-live` Claude Code run as the final acceptance proof for hosted remote browser login. The supported client stayed signed in, created a share without manual token copying, and returned a live URL from the MCP tool.

**Risks + Mitigations**
- Risk: dynamic client registration or remote auth support differs across clients.
  Mitigation: keep the login flow recommended only where verified and publish API-key fallback for the rest.
- Risk: remote auth errors feel opaque inside editors.
  Mitigation: add human-readable fallback instructions and website-based recovery paths.

### Phase 4: API Key Fallback + Local npm MCP UX ✅
**Context Scope (Required)**
- Primary code area(s) in scope:
  - `packages/mcp/src/index.ts`
  - `worker/routes/auth.ts`
  - `worker/auth.ts`
  - `public/my-links.html`
  - `public/my-links.js`
- Primary docs/specs in scope:
  - `packages/mcp/README.md`
  - `README.md`
  - `docs/auth-clerk.md`
- Out-of-scope areas for that phase:
  - remote interactive login transport details
  - anonymous website share UX

**Task Checklist**
- [✅] Add personal MCP API key issuance, revoke, and list UX in the signed-in website/account area.
- [✅] Add local npm MCP auth support with two documented setup methods: browser-assisted login and manual token/env configuration.
- [✅] Add remote MCP API key mode for clients that cannot complete interactive login.
- [✅] Keep anonymous local npm MCP behavior only as an explicit legacy fallback if retained, not the primary recommendation.
- [✅] Show ownership/auth state clearly in MCP tool responses so users know whether a new doc is owned or anonymous.
- [✅] Publish copy-paste-ready config examples for Cursor, Claude Code, Claude Desktop, VS Code, Windsurf, and raw remote endpoint users.

**Files to Modify**
- `packages/mcp/src/index.ts`
- `packages/mcp/README.md`
- `README.md`
- `docs/auth-clerk.md`
- `worker/routes/auth.ts`
- `worker/auth.ts`
- `public/my-links.html`
- `public/my-links.js`

**Acceptance Criteria**
- [✅] Unsupported-login clients can authenticate with an API key and create owned docs.
- [✅] Local npm MCP can authenticate with one website-issued credential and one config step.
- [✅] API key management UX exists and is revocable from the website.
- [✅] Local npm users understand whether they are running authenticated or anonymous mode.

**Build Notes (Decisions/Learnings)**
- `2026-04-05 16:52 UTC` — Starting Phase 4. Current hosted remote browser login is now proven live, but there is still no durable personal API key model in D1, no key management UI in the signed-in website area, no external-token bridge for `/mcp`, and the local npm MCP package still defaults to anonymous `/api/render` creates. Phase 4 will add one website-issued personal key model that works for unsupported remote clients and the local npm package, while making anonymous local use an explicit legacy mode instead of the main path.
- `2026-04-05 17:18 UTC` — Phase 4 completed with one shared personal-key model across hosted remote MCP and the local npm package. The signed-in `/my-links` UI can issue/list/revoke keys, hosted `/mcp` accepts a personal API key bearer header as a first-class fallback, local `plsreadme-mcp` now prefers `PLSREADME_API_KEY` and exposes `plsreadme_auth_status`, and docs/setup examples were updated across supported clients.
- `2026-04-05 17:18 UTC` — Live verification covered the full fallback lifecycle: Claude Code connected to `https://plsreadme.com/mcp` with a website-issued `Authorization: Bearer ...` header, created an owned share tagged `mcp_remote_api_key`, the website showed `last_used_source: mcp_remote_api_key`, revocation succeeded from `/my-links`, and the same client config immediately fell back to browser OAuth after revocation instead of continuing to create with the old key.

**Phase Run Log (UTC timestamps)**
- [ ] `2026-04-03 00:00 UTC` — Agent: coder — Status: planned — Notes: phase scaffold created.
- [✅] `2026-04-05 16:52 UTC` — Agent: Codex — Status: in progress — Notes: beginning API key fallback implementation across worker auth, hosted MCP external-token resolution, local npm MCP auth state, and signed-in website key management UX.
- [✅] `2026-04-05 17:18 UTC` — Agent: Codex — Status: completed — Notes: shipped D1-backed personal API keys, signed-in key management UI, remote MCP API-key fallback, local npm `PLSREADME_API_KEY` auth + explicit anonymous opt-in, and client-specific docs. Checks passed: targeted strip-types test suites, `npm test`, `npx wrangler deploy --dry-run`, live deploy `825f0035-1cb9-4b02-aac9-b39d26fa158d`, real Claude Code share via `mcp_remote_api_key`, and post-revoke fallback back to browser auth.

**Risks + Mitigations**
- Risk: API keys leak into repos or shell history.
  Mitigation: prefer browser-assisted login where possible, warn aggressively, store in safer local state, and support revocation.
- Risk: too many auth options make setup confusing.
  Mitigation: present login as best UX, API key as explicit compatibility fallback, and anonymous mode as legacy-only if retained.

### Phase 5: Backend Enforcement, Rate Limits, and Telemetry ✅
**Context Scope (Required)**
- Primary code area(s) in scope:
  - `worker/mcp-agent.ts`
  - `worker/routes/docs.ts`
  - `worker/routes/convert.ts`
  - `worker/security.ts`
  - `worker/types.ts`
  - `db/schema.sql`
  - `db/migrations/*`
- Primary docs/specs in scope:
  - `docs/runbooks/*`
  - `README.md`
- Out-of-scope areas for that phase:
  - marketing copy polish
  - new pricing or packaging changes

**Task Checklist**
- [✅] Require auth on hosted `/mcp` and `/sse` before tool execution.
- [✅] Move remote MCP and `/api/convert` protections to durable server-side rate limits and abuse logging.
- [✅] Unify the create pipeline so validation, ownership binding, attribution, and logging are consistent across website and MCP paths.
- [✅] Add stored metadata for `source`, `auth_mode`, `client_name`, and authenticated actor identity where applicable.
- [✅] Split usage tracking into raw hits vs human views so automated traffic does not distort product metrics.
- [✅] Add operational queries/dashboards/runbook steps for suspicious create bursts by source and auth mode.

**Files to Modify**
- `worker/mcp-agent.ts`
- `worker/routes/docs.ts`
- `worker/routes/convert.ts`
- `worker/security.ts`
- `worker/types.ts`
- `db/schema.sql`
- `db/migrations/*`
- `docs/runbooks/*`

**Acceptance Criteria**
- [✅] Hosted remote MCP can no longer create docs anonymously from the public internet.
- [✅] Every new doc is attributable to a concrete source and auth mode.
- [✅] Public AI and MCP surfaces use durable server-side rate limits.
- [✅] Product usage metrics distinguish raw traffic from likely-human engagement.

**Build Notes (Decisions/Learnings)**
- `2026-04-05 17:18 UTC` — Starting Phase 5. The missing backend pieces after Phases 3 and 4 were durable remote MCP create throttling, durable `/api/convert` throttling, unified attribution persistence across the website and MCP create paths, and separating raw render traffic from likely-human reads.
- `2026-04-05 17:34 UTC` — Phase 5 completed with a shared `createStoredDoc()` pipeline, D1 `doc_create_events`, additive `raw_view_count`, durable `mcp-create` and `/api/convert` rate limits, and a production runbook for suspicious auth-surface traffic. Website, local MCP, hosted remote login, and hosted remote API key creates now land in one attribution table with consistent R2 custom metadata and analytics shape.
- `2026-04-05 17:40 UTC` — Remote D1 rollout required a migration-history reconciliation step before the new telemetry schema could be applied safely. The live database already had the full `006_saved_links.sql` schema but was missing that row in `d1_migrations`, so `006` was recorded manually and `007_doc_attribution_telemetry.sql` was then applied normally through `wrangler d1 migrations apply --remote`. Final remote verification confirmed `docs.raw_view_count`, `doc_create_events`, its indexes, and `✅ No migrations to apply!`.

**Phase Run Log (UTC timestamps)**
- [ ] `2026-04-03 00:00 UTC` — Agent: coder — Status: planned — Notes: phase scaffold created.
- [✅] `2026-04-05 17:18 UTC` — Agent: Codex — Status: in progress — Notes: auditing the now-live auth surfaces to determine which backend enforcement, attribution metadata, rate-limit durability, and ops/runbook gaps still remain after Phases 3 and 4.
- [✅] `2026-04-05 17:34 UTC` — Agent: Codex — Status: completed — Notes: shipped durable `/api/convert` and hosted MCP create limits, unified the website/MCP create path through `worker/doc-pipeline.ts`, added `worker/doc-telemetry.ts` + migration `007_doc_attribution_telemetry.sql`, and documented the ops query set in `docs/runbooks/auth-surface-monitoring.md`. Checks passed: targeted strip-types suites, `npm test`, `npx wrangler deploy --dry-run`, and live deploy `0625c79a-b935-4a27-bf73-6e47cda68d76`.
- [✅] `2026-04-05 17:40 UTC` — Agent: Codex — Status: completed — Notes: reconciled the already-live `006_saved_links.sql` schema into remote `d1_migrations`, applied `007_doc_attribution_telemetry.sql` via Wrangler on the production D1 database, and verified the live schema now has `docs.raw_view_count`, `doc_create_events`, its indexes, and no remaining remote migrations.

**Risks + Mitigations**
- Risk: schema changes complicate rollout.
  Mitigation: use additive columns and backfill-friendly defaults.
- Risk: unified enforcement introduces regressions between web and MCP flows.
  Mitigation: add per-surface tests and preserve path-specific acceptance criteria.

### Phase 6: Rollout, Docs, Compatibility Matrix, and Migration ✅
**Context Scope (Required)**
- Primary code area(s) in scope:
  - `README.md`
  - `packages/mcp/README.md`
  - `docs/auth-clerk.md`
  - `docs/runbooks/*`
  - `public/index.html`
  - `public/mcp.html`
- Primary docs/specs in scope:
  - rollout checklist
  - migration guide
  - client compatibility guidance
- Out-of-scope areas for that phase:
  - non-auth feature work
  - unrelated frontend redesign

**Task Checklist**
- [✅] Update docs to recommend login first when supported and API key fallback when not.
- [✅] Update website copy to make the split obvious: `Try in browser` vs `Connect your editor`.
- [✅] Publish a compatibility matrix for each client: login supported, API key required, anonymous supported/legacy, known caveats.
- [✅] Add migration guidance for existing anonymous MCP users and existing anonymous docs.
- [✅] Add staged rollout flags and smoke-test checklist for containment, login flow, API key flow, and web demo flow.
- [✅] Run checks after each rollout increment (`npm test` and `npx wrangler deploy --dry-run`).

**Files to Modify**
- `README.md`
- `packages/mcp/README.md`
- `docs/auth-clerk.md`
- `docs/runbooks/*`
- `public/index.html`
- `public/mcp.html`

**Acceptance Criteria**
- [✅] A user can tell in under 30 seconds which path applies to them.
- [✅] Existing npm MCP users have a migration path that does not strand them.
- [✅] Rollout can pause or revert without killing the website demo path.
- [✅] Docs can serve as the single source of truth for supported auth methods by client.

**Build Notes (Decisions/Learnings)**
- `2026-04-05 17:34 UTC` — Phase 6 completed by tightening the public split between browser demo and editor setup, adding compatibility/migration guidance into the canonical docs, and codifying a rollout smoke checklist. The source-of-truth docs now live in `README.md`, `packages/mcp/README.md`, `docs/auth-clerk.md`, and `docs/runbooks/mcp-auth-rollout-checklist.md`, while the homepage/editor entrypoints now say `Try it now — no account needed` vs `Connect your editor`.

**Phase Run Log (UTC timestamps)**
- [ ] `2026-04-03 00:00 UTC` — Agent: coder — Status: planned — Notes: phase scaffold created.
- [✅] `2026-04-05 17:34 UTC` — Agent: Codex — Status: completed — Notes: added client compatibility + anonymous-MCP migration docs, published the rollout/smoke checklist, updated homepage/editor copy to emphasize browser demo vs editor setup, added docs coverage in `tests/mcp-rollout-docs.test.ts`, reran `npm test` and `npx wrangler deploy --dry-run`, deployed live as `0625c79a-b935-4a27-bf73-6e47cda68d76`, and spot-checked production `/?v=phase6` plus `/mcp-setup`.

**Risks + Mitigations**
- Risk: docs and implementation drift during rollout.
  Mitigation: maintain a canonical compatibility matrix and one auth setup doc.
- Risk: current anonymous users feel surprised by new auth requirements on MCP surfaces.
  Mitigation: keep website demo open, document migration clearly, and preserve API-key compatibility for editor flows.

## Notes
- Current production evidence strongly suggests recent suspicious doc creation is coming from the unauthenticated hosted remote MCP path rather than the website demo flow.
- This plan intentionally keeps the website as the easiest demo surface while moving programmable/editor automation behind explicit auth.
- Login is the preferred MCP UX where the client supports it well.
- API key auth is an official supported method because interactive login is not available everywhere.
