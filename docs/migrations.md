# D1 Migration Audit & Apply Guide

Use these commands to explicitly audit and apply D1 migrations. This makes migration status observable without relying only on runtime schema ensure logic.

## Preconditions

- `wrangler.jsonc` includes `migrations_dir: "db/migrations"` on the `DB` binding.
- Migration SQL files live under `db/migrations/`.

## Commands

```bash
# Show unapplied migrations (remote)
npm run db:migrations:list

# Show unapplied migrations (local)
npm run db:migrations:list:local

# Convenience: run both checks
npm run db:migrations:status

# Apply unapplied migrations (remote)
npm run db:migrations:apply

# Apply unapplied migrations (local)
npm run db:migrations:apply:local
```

## Notes

- Keep `ensureOwnershipSchema(...)` in runtime write paths as mixed-environment safety.
- Treat `db:migrations:list*` output as the audit trail for “what still needs applying”.
- Apply migrations in staging before production.

## Rollout Order (Auth + Ownership + Claim)

1. Set/verify auth env vars (`CLERK_PUBLISHABLE_KEY`, `CLERK_JWT_ISSUER`, optional `CLERK_JWT_AUDIENCE`).
2. Audit + apply DB migrations (`db/migrations/004_owner_user_id.sql`) in staging, then production.
3. Deploy worker code for My Links + legacy claim endpoint/UI.

Rollback guidance:
- Prefer code rollback first; keep additive nullable schema (`owner_user_id`) in place.
- Re-run smoke tests for anonymous create/read and authenticated My Links after rollback.
- Full rollout + KPI checklist lives in `docs/runbooks/legacy-link-claim-rollout.md`.
