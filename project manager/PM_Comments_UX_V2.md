# PM: Comments UX V2 — Inline Input, Node Indicators, Sidebar & Onboarding Tip

## Overview
Upgrade the anchored comments UX from a static sidebar panel to a polished, intuitive commenting experience inspired by Google Docs. Four key improvements:

1. **Floating inline input** — appears directly beneath the tapped/clicked node
2. **Comment count indicators** — badges next to nodes that have comments, visible in the doc padding/margin
3. **Desktop sidebar with comment list** — shows all comments; clicking one scrolls to the referenced node
4. **Dismissible onboarding tip** — floating tip above the toolbar: "Tap/click any paragraph to comment"

---

## ✅ Phase 1: Floating Inline Comment Input (0e0eb0f)

### What
When user taps/clicks a commentable node (h1-h6, p, li, blockquote, pre), a floating input box appears **directly below that node** (not in a sidebar). Contains:
- Name input (pre-filled from localStorage)
- Textarea
- "Post" button + Cancel button
- Error display

Clicking another node moves the input. Clicking Cancel or pressing Escape dismisses it. After posting, the input stays open (for rapid commenting) and the new comment appears.

### Why
Current UX requires looking at a separate panel. Inline input feels natural — you comment right where you're reading.

### Technical
- Create a single floating `<div id="inline-comment-box">` (absolutely positioned)
- On node click: position it below the clicked element using `getBoundingClientRect()` + scroll offset
- On submit: POST to `/api/comments/:docId` with anchor_id
- On cancel/escape: hide the box
- Mobile: ensure box doesn't overflow viewport; scroll into view if needed

### Files
- `worker/routes/docs.ts` — CSS + HTML + JS changes in template

### Acceptance
- Tapping a node shows floating input directly below it
- Posting a comment works and comment appears
- Cancel/Escape dismisses
- Works on mobile and desktop
- Name persists in localStorage

---

## ✅ Phase 2: Comment Count Indicators on Nodes (7287248)

### What
After comments load, show a small **comment count badge** next to each node that has comments. Badge appears in the left margin/padding of the doc container (like Google Docs comment indicators).

Design:
- Small pill/circle with count (e.g., "3") in brand blue
- Positioned absolutely in the left or right margin of `.doc-content`
- Clicking the badge: on mobile opens inline view of those comments below the node; on desktop scrolls sidebar to those comments

### Why
Users need to see at a glance which parts of the document have discussion.

### Technical
- After `loadComments()`, group comments by `anchor_id`
- For each anchor with comments, find the DOM element by id and inject/position a badge
- Badge is a small `<span class="comment-badge">N</span>` absolutely positioned relative to the node
- On window resize, reposition badges
- Clicking badge: scroll sidebar to that anchor's comments (desktop) or expand inline (mobile)

### Files
- `worker/routes/docs.ts` — CSS + JS changes

### Acceptance
- Nodes with comments show count badge in margin
- Badge updates after posting a new comment
- Clicking badge navigates to those comments
- Responsive: works on mobile and desktop
- Light and dark mode

---

## Phase 3: Desktop Sidebar Comment List with Scroll-to-Node

### What
On desktop (>768px), show a **right sidebar** listing all comments grouped by anchor. Each group shows:
- A snippet of the referenced text (first 60 chars)
- Comments underneath (author, time, body)
- Clicking the group header **scrolls the document to that node** and highlights it briefly

On mobile, the sidebar is hidden; users interact via inline input + badges only.

### Why
Desktop has screen real estate for a persistent comment overview. Clicking a comment to jump to context is core Google Docs UX.

### Technical
- Reuse/refactor existing `<aside class="side-panel">` into a proper grouped comment list
- Group `allComments` by `anchor_id`
- Each group: clickable header with text snippet → `document.getElementById(anchorId).scrollIntoView({ behavior: 'smooth' })` + flash highlight
- "General" (doc-root) comments group at top or bottom
- Sidebar scrolls independently from doc content
- Hide sidebar on mobile via media query

### Files
- `worker/routes/docs.ts` — CSS + HTML + JS refactor

### Acceptance
- Desktop: sidebar shows grouped comments with snippets
- Clicking group scrolls to node and highlights
- Sidebar scrolls independently
- Mobile: sidebar hidden, comments accessible via badges + inline
- Light and dark mode

---

## Phase 4: Dismissible Onboarding Tip

### What
A small floating tip/banner appears **above the toolbar** (bottom of screen) on first visit:
> "💬 Click any paragraph to leave a comment"

- Has a small "×" dismiss button
- Once dismissed, stores `plsreadme_tip_dismissed` in localStorage
- Never shows again after dismissal
- Auto-hides after 8 seconds if not dismissed
- Subtle entrance animation (fade up)

### Why
New users won't know they can click content nodes to comment. A one-time tip teaches the interaction.

### Technical
- Render tip div in template HTML
- On DOMContentLoaded: check `localStorage.getItem('plsreadme_tip_dismissed')`
- If not dismissed: show tip with fade-in, set 8s auto-hide timeout
- On dismiss click: hide + set localStorage flag
- Position: fixed, bottom, above toolbar, centered

### Files
- `worker/routes/docs.ts` — CSS + HTML + JS

### Acceptance
- Tip shows on first visit
- Dismiss button works and persists
- Does not show on subsequent visits
- Auto-hides after 8s
- Looks good on mobile + desktop, light + dark mode

---

## Implementation Notes

- All changes are in `worker/routes/docs.ts` (inline template)
- No API changes needed (Phase 1 reuses existing POST endpoint)
- No DB changes needed
- Build validation: `npx wrangler deploy --dry-run`
- Commit to `preview` branch only; do NOT push `main`
