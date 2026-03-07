# Legacy Link Claim Rollout Runbook (Phase 4)

## Scope
Ship legacy anonymous-link claiming with rollout hardening, without breaking anonymous create or owner protections.

---

## Preflight Checklist (before deploy)

- [ ] Branch includes Phase 4 claim endpoint + tests + My Links claim UX.
- [ ] `npm test` passes.
- [ ] `npx wrangler deploy --dry-run` passes.
- [ ] Clerk auth env is already active in target environment (`CLERK_PUBLISHABLE_KEY`, `CLERK_JWT_ISSUER`).
- [ ] DB migration `004_owner_user_id.sql` already applied in target env.
- [ ] Support team has claim triage notes (see **Support Notes** below).

---

## Required Env / Secret Order

Order matters for safe rollout:

1. **Auth vars first**
   - `CLERK_PUBLISHABLE_KEY`
   - `CLERK_JWT_ISSUER`
   - optional `CLERK_JWT_AUDIENCE`
2. **Migration second**
   - Apply D1 migration `004_owner_user_id.sql` in staging, then production.
3. **Deploy third**
   - Deploy worker containing `/api/auth/claim-link` and My Links claim UI.

Reason: claim endpoint and owner guards depend on `owner_user_id` existing and auth being operational.

---

## Staging Validation Checklist

- [ ] Anonymous create still works from `/` and `/app.html`.
- [ ] Signed-in create still auto-assigns owner.
- [ ] `/api/auth/my-links` shows only caller-owned links.
- [ ] `/api/auth/claim-link` success case:
  - unowned doc + valid `admin_token` + signed-in user → `200`, `claimed: true`.
- [ ] `/api/auth/claim-link` guard cases:
  - invalid token → `403 invalid_claim_proof`
  - already owned by another user → `403 owner_mismatch`
  - missing auth → `401 auth_required`
- [ ] Existing owner protection still blocks cross-account `PUT /v/:id` and `DELETE /v/:id`.

---

## Production Rollout Steps

1. Confirm migration status:
   - `npm run db:migrations:list`
2. If needed, apply migrations:
   - `npm run db:migrations:apply`
3. Deploy:
   - `npx wrangler deploy`
4. Smoke test:
   - `/api/auth/session`
   - `/my-links`
   - one legacy-link claim using known test token

---

## Rollback Notes

If claim flow causes issues:

### Fast rollback (code-only)
1. Re-deploy previous worker version.
2. Keep migration in place (`owner_user_id` is additive and nullable).
3. Validate anonymous create + `/v/:id` read paths.

### Why DB rollback is not required
- `owner_user_id` is additive and nullable.
- Existing docs continue functioning even if claim UI/API is removed.
- Owner guard semantics remain compatible with null owners.

### Data integrity check after rollback
Run sample checks:
- count of docs with null owner
- count of docs with non-null owner
- verify no doc changed `id`/URL format

---

## Support Notes (for migration helper + triage)

When users ask “where did my old links go?”

1. Send them to `/my-links` and the **Claim a legacy link** panel.
2. Ask for:
   - link URL (or doc ID)
   - original edit/admin token (`sk_...`)
3. If token exists, claiming is immediate and URL stays unchanged.
4. If token is missing, explain:
   - link remains publicly viewable
   - ownership transfer needs proof; escalate only with stronger evidence.

Suggested response macro:
> Your link URL won’t change. If you still have the original edit token (`sk_...`), you can claim it in My Links instantly. If you lost the token, we can review manually, but we need ownership proof before reassignment.

---

## First-Week Launch KPIs & Checklist

### KPI targets (week 1)
- Claim success rate (`claimed` / claim attempts) ≥ **70%**
- Invalid proof rate (`invalid_claim_proof`) ≤ **20%**
- Owner mismatch rate (`owner_mismatch`) ≤ **5%**
- “Can’t find my link” support tickets down by **50%+** vs previous baseline
- Authenticated creators revisiting `/my-links` within 24h ≥ **30%**

### KPI instrumentation points
- `legacy_link_claimed` analytics datapoint (already emitted)
- API status-code breakdown on `/api/auth/claim-link`
- Support ticket tagging: `lost-link`, `claim-proof-missing`, `owner-mismatch`

### First-week operating checklist
- [ ] Daily check claim endpoint error-rate.
- [ ] Daily check support tickets tagged `lost-link`.
- [ ] Verify no increase in unauthorized mutation attempts.
- [ ] Collect top 3 claim failure reasons and update helper copy if needed.
- [ ] End of week: review KPI target hit/miss and decide iteration priorities.
