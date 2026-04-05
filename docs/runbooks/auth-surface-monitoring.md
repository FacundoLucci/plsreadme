# Auth Surface Monitoring

This runbook covers the auth-sensitive create surfaces introduced for website demos, hosted remote MCP, and local/npm MCP fallback flows.

## What lives where

- `docs.view_count` now tracks likely-human document views.
- `docs.raw_view_count` tracks every render hit, including bots and previews.
- `doc_create_events` is the canonical D1 table for create attribution:
  - `source`
  - `auth_mode`
  - `client_name`
  - `client_id`
  - `actor_user_id`
  - `actor_email`
  - `actor_session_id`
  - `api_key_id`
  - `api_key_name`
- `request_rate_limits` stores durable per-endpoint rate-limit events.
- `abuse_audit_log` stores rejected payloads and rate-limit abuse attempts.

## Core checks

### Create bursts by source and auth mode

```sql
SELECT
  source,
  auth_mode,
  COUNT(*) AS creates,
  COUNT(DISTINCT actor_user_id) AS unique_users,
  MIN(created_at) AS first_seen,
  MAX(created_at) AS last_seen
FROM doc_create_events
WHERE created_at >= datetime('now', '-24 hours')
GROUP BY source, auth_mode
ORDER BY creates DESC;
```

### Suspicious single-actor create bursts

```sql
SELECT
  actor_user_id,
  source,
  auth_mode,
  client_name,
  COUNT(*) AS creates,
  MIN(created_at) AS first_seen,
  MAX(created_at) AS last_seen
FROM doc_create_events
WHERE created_at >= datetime('now', '-1 hour')
GROUP BY actor_user_id, source, auth_mode, client_name
HAVING COUNT(*) >= 10
ORDER BY creates DESC;
```

### API key activity

```sql
SELECT
  api_key_id,
  api_key_name,
  source,
  COUNT(*) AS creates,
  MAX(created_at) AS last_seen
FROM doc_create_events
WHERE api_key_id IS NOT NULL
GROUP BY api_key_id, api_key_name, source
ORDER BY last_seen DESC;
```

### Durable rate-limit pressure

```sql
SELECT
  endpoint,
  COUNT(*) AS hits,
  MIN(created_at) AS first_seen,
  MAX(created_at) AS last_seen
FROM request_rate_limits
WHERE created_at >= datetime('now', '-1 hour')
GROUP BY endpoint
ORDER BY hits DESC;
```

### Rejected abuse attempts

```sql
SELECT
  endpoint,
  reason,
  COUNT(*) AS rejects,
  MIN(created_at) AS first_seen,
  MAX(created_at) AS last_seen
FROM abuse_audit_log
WHERE created_at >= datetime('now', '-24 hours')
GROUP BY endpoint, reason
ORDER BY rejects DESC;
```

### Raw hits vs likely-human reads

```sql
SELECT
  id,
  title,
  raw_view_count,
  view_count,
  raw_view_count - view_count AS automated_or_preview_gap
FROM docs
ORDER BY raw_view_count DESC
LIMIT 50;
```

## Interpretation

- A spike in `mcp_remote_api_key` with one `api_key_id` usually means one automation is overactive. Revoke the key first.
- A spike in `mcp_remote_login` with many `client_name` values suggests normal editor usage unless one actor dominates.
- A large `raw_view_count - view_count` gap usually means previews, bots, or unfurls are inflating traffic.
- `/api/convert` and `/mcp` should show up in `request_rate_limits`; if they do not, rate limiting is not being exercised in production.

## Immediate response steps

1. Identify the hot `source`, `auth_mode`, and actor in `doc_create_events`.
2. Check whether the same actor is also tripping `request_rate_limits` or `abuse_audit_log`.
3. If the actor is tied to a personal API key, revoke it from `/my-links` or `DELETE /api/auth/mcp-api-keys/:id`.
4. If the actor is a hosted editor grant, revoke it from `DELETE /api/auth/mcp-grants/:grantId`.
5. Re-run the queries above for the last 15 minutes to confirm the spike stops.
