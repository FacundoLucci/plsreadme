# Task: Add Comments UI to document viewer

Edit `worker/routes/docs.ts` — specifically the `generateHtmlTemplate` function.

## What to add

After the closing `</article>` tag, add a comments section `<section class="comments-section">` with:

### 1. Comments list
- Heading: "Comments" with a count in parentheses, e.g. "Comments (3)"
- Each comment: author name (bold), relative time (e.g. "2m ago", "1h ago", "3d ago"), and body text
- Comments fetched via `GET /api/comments/${docId}` on page load
- The API returns `{ comments: [{ id, doc_id, author_name, body, created_at }] }`

### 2. Comment form
- Name input — pre-filled from `localStorage.getItem('plsreadme_author_name')`, saved on change
- Textarea for body
- Submit button
- POST to `/api/comments/${docId}` with JSON `{ author_name, body }`
- On success, append the new comment to the list, clear textarea, update count
- Show errors inline in a `.comment-error` div

### 3. CSS (add to existing `<style>` block)
- `.comments-section` — same max-width, matching card style as `.doc-content`
- Light AND dark mode (use the existing `@media (prefers-color-scheme: dark)` block)
- Each comment separated by subtle border-bottom
- Mobile responsive
- Same font family (Instrument Sans)
- Form inputs styled consistently

### 4. JS (add to existing `<script>` block)
- Use `const DOC_ID = '${docId}';` template literal to pass docId
- `relativeTime(dateStr)` helper
- `loadComments()` called on DOMContentLoaded
- Form submit handler

### Important
- The docId is available as the `docId` parameter in the template function
- Keep all existing HTML/CSS/JS intact
- Only ADD the comments section, CSS, and JS
- Do NOT create new files — everything goes in the template string in `generateHtmlTemplate`

After making changes:
```bash
cd /home/node/outframer && git add -A && git commit -m "feat: add comments UI to document viewer"
```
