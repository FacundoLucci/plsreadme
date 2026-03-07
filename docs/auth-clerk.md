# Clerk Auth Setup (Phase 1 Foundation)

This project now includes a **Clerk auth foundation** with:
- frontend sign-in/sign-up wiring (GitHub + Google, plus Clerk-hosted email fallback)
- backend JWT verification for protected worker endpoints
- safe unauthenticated handling for public routes

## What is protected vs public

### Public (unchanged)
- `POST /api/create-link`
- `POST /api/render`
- `PUT /v/:id` and `DELETE /v/:id` still use `admin_token` bearer auth (unchanged)
- all existing anonymous create flows remain available

### Authenticated web route
- `GET /my-links` — signed-in dashboard for owner-scoped links/docs (shows sign-in prompt when unauthenticated)

### Auth endpoints
- `GET /api/auth/config` — returns frontend auth config (`enabled`, publishable key, sign-in/up URLs)
- `GET /api/auth/session` — optional auth status (`authenticated: true/false`)
- `GET /api/auth/me` — **protected**, returns authenticated user identity
- `GET /api/auth/my-links` — **protected**, owner-scoped list endpoint with pagination/sort/search (`title`/slug/id)
- `POST /api/auth/claim-link` — **protected**, claim a legacy anonymous link by proving control of that link’s existing `admin_token`

## Required environment variables (auth)

### Minimum required for Clerk auth to be enabled
- `CLERK_PUBLISHABLE_KEY`
- `CLERK_JWT_ISSUER`

### Optional but recommended
- `CLERK_JWT_AUDIENCE` (set if your Clerk JWT template includes `aud`)
- `CLERK_SIGN_IN_URL` (default: `/sign-in`)
- `CLERK_SIGN_UP_URL` (default: `/sign-up`)
- `CLERK_SECRET_KEY` (reserved for future server-side use)

## Local development checklist

1. Create local env vars (for example in `.dev.vars` for Wrangler) based on `.env.example`.
2. In Clerk Dashboard, configure login methods:
   - GitHub (optional during initial rollout)
   - Google (optional during initial rollout)
   - Email (recommended fallback so auth works immediately)
3. Set your Clerk instance issuer in `CLERK_JWT_ISSUER`.
4. Run locally:
   ```bash
   npm run dev
   ```
5. Open `/` or `/app.html` and use the header auth controls.

## OAuth not configured yet? Use email fallback now

If GitHub/Google OAuth credentials are still pending, users can still sign in immediately:

1. Click **Sign in** (or **Use email instead**) in the site header.
2. The client redirects to the **Clerk-hosted sign-in flow**.
3. Choose email sign-in/sign-up (password or magic-link based on your Clerk settings).
4. After auth, Clerk returns users back to the current page.

This keeps auth usable from day one while social OAuth is being finalized.

## Legacy link claim flow (Phase 4)

Use this when a user has an older anonymous link and still has the edit/admin token.

```http
POST /api/auth/claim-link
Authorization: Bearer <clerk-session-jwt>
Content-Type: application/json

{
  "id": "<doc-id>",
  "adminToken": "sk_..."
}
```

Notes:
- Claiming **does not change** the link URL (`/v/:id` stays the same).
- Claim is allowed only when token proof matches the same doc id.
- Already-owned links remain protected by owner checks (`owner_mismatch` on other accounts).
- The endpoint is rate-limited and abuse-attempts are logged.

Support triage guidance:
- If user has URL + token → use claim flow.
- If user has URL but lost token → link still works publicly, but ownership cannot be reassigned without valid proof.
- If claim returns `owner_mismatch` → verify user is signed into the correct account and escalate only with clear ownership evidence.

## Production checklist

1. Set vars/secrets in Cloudflare:
   - publishable key (var)
   - issuer (+ optional audience)
2. Confirm Clerk app has production GitHub/Google OAuth credentials configured (email fallback can stay enabled for resilience).
3. Deploy and verify:
   - `/api/auth/config` returns `enabled: true`
   - signed-in session returns authenticated data on `/api/auth/session`
   - `/api/auth/me` returns `401` when unauthenticated and `200` when authenticated
   - `/api/auth/claim-link` returns:
     - `200` for valid token proof on unowned/owned-by-self docs
     - `403` for invalid proof or owner mismatch

## Security notes

- Worker verifies Clerk session JWTs against Clerk JWKS (`/.well-known/jwks.json`).
- Expired, invalid, misissued, or mismatched audience tokens are treated as unauthenticated.
- Public creation routes are intentionally not forced to require auth in Phase 1.
- Claim endpoint requires both authenticated session + legacy token proof (defense-in-depth).
