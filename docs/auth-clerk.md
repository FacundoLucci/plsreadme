# Clerk Auth Setup (Phase 1 Foundation)

This project now includes a **Clerk auth foundation** with:
- frontend sign-in/sign-up wiring (GitHub + Google via Clerk UI)
- backend JWT verification for protected worker endpoints
- safe unauthenticated handling for public routes

## What is protected vs public

### Public (unchanged)
- `POST /api/create-link`
- `POST /api/render`
- `PUT /v/:id` and `DELETE /v/:id` still use `admin_token` bearer auth (unchanged)
- all existing anonymous create flows remain available

### Auth endpoints
- `GET /api/auth/config` — returns frontend auth config (`enabled`, publishable key, sign-in/up URLs)
- `GET /api/auth/session` — optional auth status (`authenticated: true/false`)
- `GET /api/auth/me` — **protected**, returns authenticated user identity

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
2. In Clerk Dashboard, enable social providers:
   - GitHub
   - Google
3. Set your Clerk instance issuer in `CLERK_JWT_ISSUER`.
4. Run locally:
   ```bash
   npm run dev
   ```
5. Open `/` or `/app.html` and use the header auth controls.

## Production checklist

1. Set vars/secrets in Cloudflare:
   - publishable key (var)
   - issuer (+ optional audience)
2. Confirm Clerk app has production GitHub/Google OAuth credentials configured.
3. Deploy and verify:
   - `/api/auth/config` returns `enabled: true`
   - signed-in session returns authenticated data on `/api/auth/session`
   - `/api/auth/me` returns `401` when unauthenticated and `200` when authenticated

## Security notes

- Worker verifies Clerk session JWTs against Clerk JWKS (`/.well-known/jwks.json`).
- Expired, invalid, misissued, or mismatched audience tokens are treated as unauthenticated.
- Public creation routes are intentionally not forced to require auth in Phase 1.
