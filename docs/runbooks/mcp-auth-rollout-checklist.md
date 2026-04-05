# MCP Auth Rollout Checklist

Use this when rolling forward or pausing auth-related MCP changes without breaking the website demo path.

## Rollout order

1. Keep anonymous website demo healthy.
2. Verify hosted remote browser login.
3. Verify personal API key fallback.
4. Verify local stdio with `PLSREADME_API_KEY`.
5. Only then enforce or tighten rate limits further.

## Required migration state

- `004_owner_user_id.sql` applied where ownership filters matter.
- `007_doc_attribution_telemetry.sql` applied where `doc_create_events` and `raw_view_count` are expected.
- `OAUTH_KV` bound in the target Worker environment.

## Smoke checklist

### Website demo

- Load `/`.
- Create a link anonymously.
- Confirm the result page offers:
  - `Save to my account`
  - `Connect your editor`
  - `Copy link`

### Hosted remote browser login

- Add `https://plsreadme.com/mcp` in a supported client.
- Confirm the first authenticated use opens browser login.
- Complete approval.
- Create one doc and confirm it is tagged `mcp_remote_login`.

### Hosted remote API key fallback

- Create a personal API key from `/my-links`.
- Add the same `/mcp` endpoint with `Authorization: Bearer ...`.
- Create one doc and confirm it is tagged `mcp_remote_api_key`.
- Revoke the key and confirm the same client falls back to browser auth or fails closed.

### Local stdio MCP

- Configure `PLSREADME_API_KEY`.
- Run `plsreadme_auth_status`.
- Create one doc and confirm it is owned and tagged `mcp_local_api_key`.
- If you test legacy mode, set `PLSREADME_ALLOW_ANONYMOUS=1` explicitly and confirm the status tool says anonymous.

## Pause / rollback rules

- Do not close the website demo path during editor-auth rollout problems.
- If hosted remote login regresses, keep `/mcp` available with API key headers and the local stdio package path.
- If API key issuance regresses, leave hosted remote login and website demo active while fixing `/my-links`.
- Keep additive schema migrations in place; prefer code rollback over schema rollback.

## Evidence to capture

- `npm test`
- `npx wrangler deploy --dry-run`
- one live hosted remote login create
- one live hosted remote API key create + revoke check
- one live local stdio auth-status check
