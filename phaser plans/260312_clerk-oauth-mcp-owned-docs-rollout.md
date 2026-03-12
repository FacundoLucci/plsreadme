# Clerk OAuth MCP Owned Docs Rollout — Phaser Plan

**Date:** 2026-03-12
**Status:** ⚪ Not Started

## Objective
- [x] Validate whether full OAuth MCP with Clerk is practical using existing Clerk + MCP guidance.
- [ ] Ship a pragmatic interim flow so MCP-created docs are owned at creation time.
- [ ] Design and implement a production-grade remote MCP OAuth flow with Clerk consent and dynamic client registration.
- [ ] Migrate docs/recommendations so OAuth-backed ownership is the default path.

## Scope
- In scope:
  - [x] Research and feasibility confirmation for Clerk + MCP OAuth path.
  - [ ] Interim ownership path for current stdio MCP package (API key or token-based owner binding).
  - [ ] Remote MCP endpoint design for OAuth 2.1 + Clerk consent integration.
  - [ ] Ownership mapping from authenticated identity to `owner_user_id` on create.
  - [ ] Docs and rollout guidance (client compatibility, migration, fallback behavior).
- Out of scope:
  - [ ] Replacing existing anonymous flow (must remain as fallback).
  - [ ] Full enterprise RBAC/organization-level permissions.
  - [ ] Non-Clerk auth provider support.

## Phases

### Phase 1 — Auth Product Decision + Contract (Interim + Long-term) ⚪
**Context Scope:** product/UX contract + auth/ownership API surface + docs plan.
**Out of Scope (for this phase):** implementing full OAuth transport and toolchain changes.
- [ ] Finalize interim auth UX for stdio MCP (`owned by default when auth configured; anonymous fallback`).
- [ ] Choose interim credential type (recommended: user-bound MCP API key) and lifecycle policy.
- [ ] Define server contract for “authenticated create” and explicit fallback semantics.
- [ ] Define ownership invariants (`owner_user_id` assignment, mutation guard behavior, claim-link behavior if anonymous).
- [ ] Define user-visible messaging contract for MCP responses (owned vs anonymous outcomes).
- [ ] Run checks after doc/spec updates.

**Files:**
- `README.md` — interim UX contract language and user flows.
- `docs/auth-clerk.md` — ownership rules and credential behavior.
- `docs/ai-iteration-versioning.md` — agent workflow implications with owned docs.
- `phaser plans/260312_clerk-oauth-mcp-owned-docs-rollout.md` — phase tracking.

**Acceptance Criteria:**
- [ ] Written decision record exists for interim credential strategy.
- [ ] Ownership contract is explicit for create/update/delete/restore.
- [ ] Anonymous fallback and claim-link path remain clearly documented.

**Build Notes (decisions/learning):**
- Pending.

**Phase Run Log:**
- [ ] `YYYY-MM-DD HH:MM UTC` — Agent: coder — Status: started — Notes:

### Phase 2 — Interim Owned Create for Current MCP (Pragmatic Ship) ⚪
**Context Scope:** current stdio MCP package (`packages/mcp`) + create endpoint auth handling in worker routes.
**Out of Scope (for this phase):** remote MCP OAuth handshake and DCR behavior.
- [ ] Add optional auth credential support to MCP create path (e.g., `PLSREADME_MCP_API_KEY` or equivalent configured secret).
- [ ] Send auth header on create when configured; preserve anonymous behavior when absent.
- [ ] Ensure backend resolves authenticated create to `owner_user_id` assignment.
- [ ] Add explicit response messaging in MCP output for owned vs anonymous create result.
- [ ] Add tests for: owned create success, missing/invalid credential fallback/error behavior, anonymous fallback compatibility.
- [ ] Run checks after implementation (`npm test`).

**Files:**
- `packages/mcp/src/index.ts` — create call auth plumbing + UX messaging.
- `packages/mcp/README.md` — setup instructions for ownership-enabled MCP usage.
- `worker/routes/links.ts` and/or auth helpers — authenticated create ownership binding.
- `tests/*` — coverage for ownership-on-create behavior.

**Acceptance Criteria:**
- [ ] Auth-configured MCP creates produce owned docs (`owner_user_id` set).
- [ ] Non-configured MCP clients still create anonymously without regression.
- [ ] User gets clear success output describing ownership state.
- [ ] Automated tests pass.

**Build Notes (decisions/learning):**
- Pending.

**Phase Run Log:**
- [ ] `YYYY-MM-DD HH:MM UTC` — Agent: coder — Status: started — Notes:

### Phase 3 — Remote MCP OAuth with Clerk (Full Flow) ⚪
**Context Scope:** remote MCP transport/auth integration (HTTP/SSE as applicable), OAuth metadata/discovery, Clerk consent flow, token verification.
**Out of Scope (for this phase):** broad non-MCP product refactors.
- [ ] Implement/verify remote MCP endpoint path and transport behavior compatible with MCP clients.
- [ ] Integrate Clerk OAuth for MCP auth (consent flow + token verification).
- [ ] Enable and validate Dynamic Client Registration requirements for target MCP clients.
- [ ] Map authenticated principal identity to tool execution context and ownership create operations.
- [ ] Validate core clients (at minimum: Claude Code + Cursor; optionally VS Code) with login + tool execution.
- [ ] Add guard rails for invalid token, revoked access, and owner mismatch behavior.
- [ ] Run checks after implementation.

**Files:**
- `worker/mcp-agent.ts` (or MCP server entrypoint) — remote MCP auth-aware server behavior.
- `worker/auth.ts` / related auth glue — token verification and identity extraction.
- `worker/routes/*` used by MCP create/update tools — owner-aware mutations.
- `docs/*` — OAuth connection/setup and troubleshooting.

**Acceptance Criteria:**
- [ ] A supported MCP client can connect via OAuth login + consent and execute tools.
- [ ] MCP-created docs through remote OAuth path are owned by authenticated user.
- [ ] Unauthorized/expired token scenarios fail safely with actionable errors.
- [ ] End-to-end tests or scripted validation steps are documented and pass.

**Build Notes (decisions/learning):**
- Pending.

**Phase Run Log:**
- [ ] `YYYY-MM-DD HH:MM UTC` — Agent: coder — Status: started — Notes:

### Phase 4 — Rollout, Migration, and Default UX Switch ⚪
**Context Scope:** release docs, migration communication, compatibility matrix, operational fallback strategy.
**Out of Scope (for this phase):** new auth providers or enterprise policy features.
- [ ] Publish user-facing setup docs that prioritize OAuth remote MCP where supported.
- [ ] Document fallback order: OAuth remote → interim authenticated stdio → anonymous + claim-link.
- [ ] Add compatibility matrix by client and required config (DCR, login behavior, known quirks).
- [ ] Add rollout checklist and smoke test runbook for auth + ownership verification.
- [ ] Confirm no regressions in anonymous/public sharing baseline.
- [ ] Run checks after final docs/changes.

**Files:**
- `README.md` — default recommendation and setup paths.
- `docs/auth-clerk.md` — canonical auth/ownership behavior.
- `docs/runbooks/*` — rollout + rollback checklist.
- `phaser plans/260312_clerk-oauth-mcp-owned-docs-rollout.md` — final status updates.

**Acceptance Criteria:**
- [ ] Docs reflect a clear default path for owned MCP docs.
- [ ] Fallback paths are explicit and tested.
- [ ] Rollout checklist exists and is actionable.
- [ ] Plan can be handed to `/loop` execution without ambiguity.

**Build Notes (decisions/learning):**
- Pending.

**Phase Run Log:**
- [ ] `YYYY-MM-DD HH:MM UTC` — Agent: coder — Status: started — Notes:

## Risks
- Risk: OAuth client support differences across MCP clients may cause uneven UX.
  Mitigation: maintain compatibility matrix + validated fallback path.
- Risk: Improper identity mapping could assign wrong owner on create.
  Mitigation: strict auth claim mapping tests and owner-guard regression tests.
- Risk: Token/credential complexity degrades adoption.
  Mitigation: ship pragmatic interim auth first, then progressive OAuth default.

## Notes
- Research indicates full Clerk + MCP OAuth is feasible with existing Clerk guidance, including DCR and consent screens.
- Implementation strategy intentionally stages value: ship ownership now (interim), then complete OAuth-native flow.
