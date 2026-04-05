# Clerk Auth Setup + Auth Product Contract

## Product contract (Phase 1)

### Official journeys

1. **Anonymous website demo**: fastest first-use path, no MCP setup required.
2. **Hosted remote MCP with browser login**: preferred editor UX when the client supports interactive auth well.
3. **MCP with personal API key auth**: explicit fallback for clients that cannot complete browser login.

### Recommendation order in docs and UI

1. `Try in browser`
2. `Connect your editor`
3. `Use API key fallback`

### Hosted remote MCP login contract (Phase 3)

- Hosted remote MCP routes `/mcp`, `/sse`, and `/sse/message` are now wrapped by Cloudflare's OAuth provider flow.
- Authorization UI lives at `/authorize`, with token exchange at `/oauth/token` and dynamic registration at `/oauth/register`.
- Clerk remains the identity layer for the browser approval screen.
- Hosted remote creates are owned immediately and tagged `mcp_remote_login`.
- Reconnecting the same client replaces the older grant (`revokeExistingGrants: true`).

Remote session lifecycle:

- Access token TTL: `3600` seconds (`1 hour`)
- Refresh token TTL: `2592000` seconds (`30 days`)
- Reconnect behavior: the newest grant for the same user/client pair replaces the older one
- Logout semantics: signing out of the website ends the Clerk browser session, but does not revoke an already-issued editor grant
- Revocation surface:
  - `GET /api/auth/mcp-grants`
  - `DELETE /api/auth/mcp-grants/:grantId`

Production rollout state:

- Cloudflare Workers KV binding named `OAUTH_KV` is required by `@cloudflare/workers-oauth-provider` for token/grant storage.
- This repo is wired with dedicated `OAUTH_KV` namespace IDs in `wrangler.jsonc`.
- Hosted remote MCP browser login is now verified live from a supported client end to end.

### Personal MCP API key contract (Phase 4)

- Signed-in users can now issue personal MCP API keys from the website account area.
- Key management endpoints:
  - `GET /api/auth/mcp-api-keys`
  - `POST /api/auth/mcp-api-keys`
  - `DELETE /api/auth/mcp-api-keys/:keyId`
- Hosted remote MCP accepts a valid personal API key as an external bearer token and tags those creates as `mcp_remote_api_key`.
- Local npm MCP accepts the same website-issued key via `PLSREADME_API_KEY` and tags those creates as `mcp_local_api_key`.
- Local npm anonymous mode is no longer the default path. It remains available only with explicit `PLSREADME_ALLOW_ANONYMOUS=1`.

### Backend telemetry + enforcement contract (Phase 5)

- Hosted remote MCP create operations now use a durable server-side rate limit (`mcp-create`) before any doc write.
- `/api/convert` now uses the same durable `request_rate_limits` table and `abuse_audit_log` as the other public AI/create surfaces.
- Every new doc now writes a `doc_create_events` row with:
  - `source`
  - `auth_mode`
  - `client_id`
  - `client_name`
  - authenticated actor fields when available
- `docs.raw_view_count` tracks all render hits, while `docs.view_count` is reserved for likely-human reads.

### Website demo proof contract (Phase 2)

- Anonymous website creates on `/api/create-link` require a short-lived browser demo grant.
- The grant is issued from `GET /api/auth/demo-grant`, stored as an HttpOnly cookie, bound to IP + user agent, and consumed on the next anonymous website create.
- Signed-in website creates do not need the demo grant and continue to auto-bind ownership when auth is valid.
- Anonymous website rate limits and authenticated website rate limits are now separate.

Blocked/suspicious-traffic UX contract:

- Missing browser proof: `Browser verification required before creating an anonymous demo link.`
- Expired or mismatched proof: `Your browser verification expired or no longer matches this session.`
- Recovery path: `Refresh browser verification and try again, or sign in to keep sharing from your account.`
- Post-create actions: `Save to my account`, `Connect your editor`, and `Copy link`.

### Ownership contract

| Journey | Initial owner binding | Follow-up rules |
| --- | --- | --- |
| Anonymous website demo (`web_demo`) | `owner_user_id = NULL` | can later be saved/claimed into an account without changing the link |
| Signed-in website create (`web_signed_in`) | `owner_user_id = Clerk user id` at create time | destructive mutations still require the existing edit/admin proof plus matching owner auth |
| Hosted remote MCP login (`mcp_remote_login`) | `owner_user_id = Clerk user id` from remote session | same owner-scoped mutation rules as signed-in website docs |
| Hosted remote MCP API key (`mcp_remote_api_key`) | `owner_user_id = API key owner` at create time | mutations are attributable to the same key owner |
| Local npm MCP API key (`mcp_local_api_key`) | `owner_user_id = API key owner` at create time | tool responses should clearly show authenticated ownership |
| Local npm MCP anonymous fallback (`mcp_local_anonymous`) | `owner_user_id = NULL` | legacy-only path; tool responses should say the doc is anonymous |

Mutation rules:

- Anonymous docs keep working with `admin_token` alone.
- Owned docs require both edit proof (`admin_token` or the future equivalent) and the matching owner identity.
- Claim-link remains the bridge from anonymous docs to owned docs when the user proves the original admin token.

### Source attribution contract

Every create path must stamp one of these values:

- `web_demo`
- `web_signed_in`
- `mcp_remote_login`
- `mcp_remote_api_key`
- `mcp_local_api_key`
- `mcp_local_anonymous`

### Client compatibility matrix

| Client | Browser login | API key fallback | Recommended path |
| --- | --- | --- | --- |
| Claude Code | verified live | yes | hosted remote login first |
| Cursor | supported in current docs/builds, verify locally | yes | hosted remote login first, headers if OAuth prompt is missing |
| VS Code | configuration exists, rollout varies by build | yes | hosted remote if available, otherwise API key |
| Windsurf | documented remote support | yes | hosted remote if available, otherwise API key |
| Claude Desktop | no verified remote login flow here | yes | local npm MCP with `PLSREADME_API_KEY` |
| raw HTTP/scripts | no | yes | remote header fallback |

### Migration guidance for older anonymous MCP users

1. Create a personal API key from `/my-links`.
2. Replace anonymous local config with `PLSREADME_API_KEY`.
3. Keep `PLSREADME_ALLOW_ANONYMOUS=1` only for explicit legacy workflows.
4. Claim older anonymous docs with `/api/auth/claim-link` when you still have the original `admin_token`.

### User-facing auth and fallback copy

- Hosted remote expired login: `Your hosted MCP login expired or was revoked. Reconnect the editor to sign in again, or switch to a personal plsreadme API key.`
- Hosted remote unsupported flow: `This MCP client could not finish the browser login flow. Open the setup guide and use the supported remote instructions or the local npm fallback.`
- Unsupported client: `This client does not support browser sign-in yet. Use a personal plsreadme API key instead.`
- Expired auth: `Your plsreadme session expired. Sign in again or switch to a personal API key.`
- Anonymous ownership reminder: `This doc was created anonymously. Sign in and save it to your account if you want it to show up in My Links.`

This project now includes a **Clerk auth foundation** with:
- frontend sign-in/sign-up wiring (GitHub + Google, plus Clerk-hosted email fallback)
- backend JWT verification for protected worker endpoints
- safe unauthenticated handling for public routes

## What is protected vs public

### Public website/demo routes
- `POST /api/create-link`
- `POST /api/render` (public for raw create traffic, but now also accepts personal MCP API keys for owned local creates)
- `PUT /v/:id` and `DELETE /v/:id` still use `admin_token` bearer auth (unchanged)
- anonymous website create flows remain available

### OAuth-protected hosted remote MCP routes
- `GET|POST /mcp`
- `GET /sse`
- `POST /sse/message`

These now rely on the OAuth provider wrapper for access-token checks and pass authenticated grant props into the MCP Durable Object.

### Authenticated web route
- `GET /my-links` — signed-in dashboard for owner-scoped links/docs (shows sign-in prompt when unauthenticated)

### Auth endpoints
- `GET /api/auth/config` — returns frontend auth config (`enabled`, publishable key, sign-in/up URLs)
- `GET /api/auth/session` — optional auth status (`authenticated: true/false`)
- `GET /api/auth/me` — **protected**, returns authenticated user identity
- `GET /api/auth/mcp-grants` — **protected**, list current hosted remote MCP grants plus lifecycle metadata
- `DELETE /api/auth/mcp-grants/:grantId` — **protected**, revoke one hosted remote MCP grant
- `GET /api/auth/mcp-api-keys` — **protected**, list personal MCP API keys
- `POST /api/auth/mcp-api-keys` — **protected**, create a new personal MCP API key (returned once)
- `DELETE /api/auth/mcp-api-keys/:keyId` — **protected**, revoke one personal MCP API key
- `GET /api/auth/my-links` — **protected**, owner-scoped list endpoint with pagination/sort/search (`title`/slug/id)
- `POST /api/auth/claim-link` — **protected**, claim a legacy anonymous link by proving control of that link’s existing `admin_token`

## Frontend auth architecture

- `/app.html` and `/my-links` now load `public/clerk-auth-shell.js` (instead of `public/auth.js`).
- The shell uses Clerk Browser SDK directly (`window.Clerk.load(...)`) and renders:
  - signed-out controls (sign in / sign up / email fallback)
  - signed-in user chip + `My links` shortcut + sign out
- The shell publishes auth state via `window.plsreadmeAuthState` and `plsreadme:auth-state` events.
- API calls that need auth (for example `/api/auth/my-links` and `/api/auth/claim-link`) should keep using `window.plsreadmeGetAuthToken()` to fetch the current Clerk bearer token.

`public/auth.js` is left in place for legacy entrypoints while migration continues, but app/my-links auth UI is now Clerk-native shell first.

## Required environment variables (auth)

### Minimum required for Clerk auth to be enabled
- `CLERK_PUBLISHABLE_KEY`
- `CLERK_JWT_ISSUER`
- `OAUTH_KV` binding in the deployed Worker environment if hosted remote MCP login is enabled

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
   - `OAUTH_KV` Workers KV binding for hosted remote MCP OAuth state/tokens
2. Confirm Clerk app has production GitHub/Google OAuth credentials configured (email fallback can stay enabled for resilience).
3. Deploy and verify:
   - `/api/auth/config` returns `enabled: true`
   - signed-in session returns authenticated data on `/api/auth/session`
   - `/api/auth/me` returns `401` when unauthenticated and `200` when authenticated
   - `/api/auth/mcp-grants` returns current hosted editor grants for the signed-in user when the OAuth provider is configured
   - `/api/auth/mcp-api-keys` can create, list, and revoke a personal key
   - `doc_create_events` records new creates with the expected `source` / `auth_mode`
   - `docs.raw_view_count >= docs.view_count` on live traffic
   - `/api/auth/claim-link` returns:
     - `200` for valid token proof on unowned/owned-by-self docs
     - `403` for invalid proof or owner mismatch

## Security notes

- Worker verifies Clerk session JWTs against Clerk JWKS (`/.well-known/jwks.json`).
- Expired, invalid, misissued, or mismatched audience tokens are treated as unauthenticated.
- Public creation routes are intentionally not forced to require auth in Phase 1.
- Claim endpoint requires both authenticated session + legacy token proof (defense-in-depth).
