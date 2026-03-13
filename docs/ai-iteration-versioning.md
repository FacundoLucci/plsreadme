# AI Iteration Playbook: Version Timeline + Safe Restore

This guide explains how to use plsreadme versioning endpoints in human + agent workflows.

## Why this exists

AI editing loops are fast, but easy to destabilize:
- A good draft can regress after a later prompt.
- Reviewers can lose track of which revision they are commenting on.
- Automation can accidentally compare the wrong content.

plsreadme exposes explicit version metadata and a safe restore path to keep iteration deterministic.

## Endpoints

### `GET /v/:id/versions`
Returns timeline metadata in descending order (latest first).

Response shape:
- `id`
- `current_version`
- `total_versions`
- `versions[]` with:
  - `version`
  - `is_current`
  - `raw_url`

Use this endpoint as the canonical machine-readable source for revision state.

### `GET /v/:id/history`
Human-readable version history page. Includes:
- current version badge
- links to raw snapshots
- guarded restore actions for archived versions

### `POST /v/:id/restore`
Restores a previous version by creating a **new** current version.

Request body:
```json
{ "version": 4 }
```

Auth requirements:
- `Authorization: Bearer <admin_token>`
- For owned docs: authenticated owner session must match `owner_user_id`

Safety behavior:
- Archive-first write (`md/<id>_v<current>.md`) before updating canonical object
- Monotonic `doc_version` increment
- Restore is rate-limited similarly to updates (currently 60/hour per actor key)

### `GET /api/comments/:docId?view=current|all`
Comment review mode endpoint for version-aware feedback triage.

Query options:
- `view=current` → returns only comments on the latest doc version (actionable now)
- `view=all` → returns the full timeline (default API behavior)

Viewer mapping:
- `?view=current` in the viewer URL maps to API `view=current`
- `?view=timeline` in the viewer URL maps to API `view=all`

## Recommended workflow: Current draft first, Timeline on demand

Use this sequence for both human and AI-assisted review loops:

1. Open the doc in **Current draft** mode first (`?view=current`) to focus on unresolved feedback for the latest revision.
2. Address or re-evaluate only comments that still apply to the active draft.
3. Switch to **Timeline** mode (`?view=timeline`) when you need historical context, audit trails, or regression forensics.
4. Keep iteration decisions anchored to `current_version` from `/v/:id/versions`.
5. If a draft regresses, restore with `POST /v/:id/restore` and continue forward from that new current version.

## Suggested human workflow

1. Share initial draft (`POST /api/render`).
2. Iterate with updates (`PUT /v/:id`).
3. Use `/v/:id/history` to inspect snapshots and context.
4. Restore only when a revision is clearly better than current.
5. Continue forward from the restored state (never destructive rollback).

## Suggested MCP/agent workflow (auto-review loop)

Use `/versions` instead of scraping rendered pages:

1. Persist `docId` + `lastReviewedVersion`.
2. Call `GET /v/:id/versions`.
3. If `current_version === lastReviewedVersion`, no-op.
4. If newer:
   - fetch `versions[0].raw_url`
   - fetch `/api/comments/:docId?view=current` for latest-draft-only feedback
   - run your lint/review/check logic
   - escalate to `view=all` only when historical context is required
   - post findings to your review channel
   - set `lastReviewedVersion = current_version`
5. If checks fail hard, escalate to human or restore a known-good version.

Pseudo-loop:

```ts
const timeline = await fetch(`/v/${docId}/versions`).then((r) => r.json());

if (timeline.current_version > lastReviewedVersion) {
  const latest = timeline.versions.find((v) => v.is_current) ?? timeline.versions[0];
  const markdown = await fetch(latest.raw_url).then((r) => r.text());

  const report = await runQualityChecks(markdown);
  await publishReview(report, { docId, version: timeline.current_version });

  if (report.blockingRegression) {
    await requestHumanApprovalForRestore({ docId, targetVersion: lastReviewedVersion });
  }

  lastReviewedVersion = timeline.current_version;
}
```

## Operational notes

- Keep `admin_token` private; do not commit it to source control.
- Prefer owner-authenticated docs for stronger mutation controls.
- Treat restore as a guarded recovery mechanism, not normal editing.
- For unattended loops, honor `429` responses and back off using `retry_after_seconds`.
