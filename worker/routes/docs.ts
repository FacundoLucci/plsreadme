import { Hono } from "hono";
import { nanoid } from "nanoid";
import { marked } from "marked";
import type { Env, DocRecord } from "../types";

const app = new Hono<{ Bindings: Env }>();

// Constants
const MAX_FILE_SIZE = 200 * 1024; // 200 KB
const RATE_LIMIT_PER_HOUR = 30;

// Send Discord notification (link/doc creation)
async function sendDiscordLinkCreatedNotification(
  webhookUrl: string,
  payload: {
    id: string;
    title: string | null;
    url: string;
    rawUrl: string;
    bytes: number;
  }
): Promise<void> {
  try {
    if (!webhookUrl || webhookUrl.trim() === "") return;

    const safeTitle = (payload.title || "Untitled").slice(0, 256);
    const embed = {
      title: "🔗 New link generated",
      color: 0x10b981, // emerald
      fields: [
        { name: "Title", value: safeTitle, inline: false },
        { name: "Doc ID", value: payload.id, inline: true },
        { name: "Size", value: `${payload.bytes} bytes`, inline: true },
        { name: "View", value: payload.url, inline: false },
        { name: "Raw", value: payload.rawUrl, inline: false },
        { name: "Time", value: new Date().toISOString(), inline: true },
      ],
      timestamp: new Date().toISOString(),
    };

    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error("Discord link notification failed:", {
        status: res.status,
        statusText: res.statusText,
        body: text.slice(0, 500),
      });
    }
  } catch (error) {
    console.error(
      "Discord link notification error:",
      error instanceof Error ? error.message : String(error)
    );
  }
}

// Configure marked for better security and formatting
marked.setOptions({
  gfm: true,
  breaks: true,
});

// Helper: Simple SHA-256 hash
async function sha256(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Helper: Extract title from markdown
function extractTitle(markdown: string): string | null {
  const lines = markdown.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("# ")) {
      return trimmed.substring(2).trim();
    }
  }
  return null;
}

// Helper: Check rate limit (simple IP-based)
async function checkRateLimit(env: Env, ip: string): Promise<boolean> {
  const ipHash = await sha256(ip);
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const result = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM docs WHERE sha256 = ? AND created_at > ?"
  )
    .bind(ipHash, hourAgo)
    .first<{ count: number }>();

  return (result?.count || 0) < RATE_LIMIT_PER_HOUR;
}

// Helper: Sanitize HTML (basic XSS prevention)
function sanitizeHtml(html: string): string {
  // Remove script tags and event handlers
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/on\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/on\w+\s*=\s*'[^']*'/gi, "")
    .replace(/javascript:/gi, "");
}

// Helper: Generate HTML template for rendered doc
function generateHtmlTemplate(
  title: string | null,
  htmlContent: string,
  docId: string
): string {
  const pageTitle = title || "Untitled Document";
  const sanitizedHtml = sanitizeHtml(htmlContent);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${pageTitle} – plsreadme</title>
  <meta property="og:title" content="${pageTitle}">
  <meta property="og:description" content="View this document on plsreadme">
  <meta property="og:url" content="https://plsreadme.com/v/${docId}">
  <meta property="og:type" content="article">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://use.hugeicons.com/font/icons.css">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🙏</text></svg>">
  <style>
    html, body {
      margin: 0;
      padding: 0;
      min-height: 100%;
      background: #fafafa;
    }
    body {
      font-family: 'Instrument Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      color: #1a1a1a;
    }
    .doc-container {
      max-width: 780px;
      margin: 2rem auto;
      padding: 0 2rem 4rem;
    }
    .doc-content {
      background: #fff;
      border: 1px solid #e5e5e5;
      border-radius: 8px;
      padding: 3rem;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
    }
    .doc-content h1 {
      margin-top: 0;
      margin-bottom: 1.5rem;
      font-size: 2.5rem;
      font-weight: 700;
      line-height: 1.2;
      color: #1a1a1a;
    }
    .doc-content h2 {
      margin-top: 2.5rem;
      margin-bottom: 1rem;
      font-size: 1.875rem;
      font-weight: 600;
      line-height: 1.3;
      color: #1a1a1a;
    }
    .doc-content h3 {
      margin-top: 2rem;
      margin-bottom: 0.75rem;
      font-size: 1.5rem;
      font-weight: 600;
      line-height: 1.4;
      color: #1a1a1a;
    }
    .doc-content p {
      margin: 1rem 0;
      line-height: 1.7;
      color: #404040;
    }
    .doc-content ul, .doc-content ol {
      margin: 1rem 0;
      padding-left: 1.5rem;
      line-height: 1.7;
    }
    .doc-content li {
      margin: 0.5rem 0;
      color: #404040;
    }
    .doc-content code {
      font-family: monospace;
      background: #f5f5f5;
      padding: 0.125rem 0.375rem;
      border-radius: 4px;
      font-size: 0.875em;
      color: #d73a49;
    }
    .doc-content pre {
      background: #1a1a1a;
      color: #f5f5f5;
      padding: 1.5rem;
      border-radius: 6px;
      overflow-x: auto;
      margin: 1.5rem 0;
      line-height: 1.3;
    }
    .doc-content pre code {
      background: transparent;
      color: inherit;
      padding: 0;
      font-size: 0.875rem;
      line-height: 1.3;
    }
    .doc-content blockquote {
      margin: 1.5rem 0;
      padding-left: 1.5rem;
      border-left: 4px solid #e5e5e5;
      color: #666;
      font-style: italic;
    }
    .doc-content a {
      color: #0066cc;
      text-decoration: none;
      border-bottom: 1px solid transparent;
      transition: border-color 0.2s;
    }
    .doc-content a:hover {
      border-bottom-color: #0066cc;
    }
    .doc-content img {
      max-width: 100%;
      height: auto;
      border-radius: 6px;
      margin: 1.5rem 0;
    }
    .doc-content hr {
      margin: 2rem 0;
      border: none;
      border-top: 1px solid #e5e5e5;
    }
    .doc-content table {
      width: 100%;
      border-collapse: collapse;
      margin: 1.5rem 0;
    }
    .doc-content th, .doc-content td {
      padding: 0.75rem;
      border: 1px solid #e5e5e5;
      text-align: left;
    }
    .doc-content th {
      background: #f9f9f9;
      font-weight: 600;
    }
    .doc-toolbar {
      position: fixed;
      bottom: 1rem;
      left: 1rem;
      display: flex;
      gap: 0.5rem;
      z-index: 100;
    }
    .doc-toolbar-item {
      background: rgba(255, 255, 255, 0.95);
      backdrop-filter: blur(8px);
      border: 1px solid #e5e5e5;
      border-radius: 6px;
      padding: 0.5rem 0.75rem;
      font-size: 0.75rem;
      color: #666;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
      text-decoration: none;
      font-family: inherit;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
      transition: all 0.2s;
    }
    .doc-toolbar-item:hover {
      border-color: #d4d4d4;
      background: rgba(249, 249, 249, 0.95);
    }
    .doc-toolbar-item a {
      color: #1a1a1a;
      text-decoration: none;
      font-weight: 600;
    }
    .doc-toolbar-item a:hover {
      text-decoration: underline;
    }
    @media (max-width: 768px) {
      .doc-container {
        padding: 0 1rem 2rem;
      }
      .doc-content {
        padding: 1.5rem;
      }
      .doc-content h1 {
        font-size: 2rem;
      }
      .doc-content h2 {
        font-size: 1.5rem;
      }
    }
    /* Comments section */
    .comments-section {
      margin-top: 1.5rem;
      background: #fff;
      border: 1px solid #e5e5e5;
      border-radius: 8px;
      padding: 2rem 3rem;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
    }
    .comments-heading {
      margin: 0 0 1.5rem;
      font-size: 1.25rem;
      font-weight: 600;
      color: #1a1a1a;
    }
    .comments-list {
      display: flex;
      flex-direction: column;
    }
    .comment-item {
      padding: 1rem 0;
      border-bottom: 1px solid #f0f0f0;
    }
    .comment-item:last-child {
      border-bottom: none;
    }
    .comment-meta {
      display: flex;
      align-items: baseline;
      gap: 0.5rem;
      margin-bottom: 0.25rem;
    }
    .comment-author {
      font-weight: 600;
      color: #1a1a1a;
      font-size: 0.875rem;
    }
    .comment-time {
      font-size: 0.75rem;
      color: #999;
    }
    .comment-body {
      color: #404040;
      font-size: 0.9rem;
      line-height: 1.6;
      margin: 0;
      white-space: pre-wrap;
    }
    .comment-form {
      margin-top: 1.5rem;
      padding-top: 1.5rem;
      border-top: 1px solid #e5e5e5;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }
    .comment-form input,
    .comment-form textarea {
      font-family: inherit;
      font-size: 0.875rem;
      padding: 0.625rem 0.75rem;
      border: 1px solid #e5e5e5;
      border-radius: 6px;
      background: #fafafa;
      color: #1a1a1a;
      outline: none;
      transition: border-color 0.2s;
    }
    .comment-form input:focus,
    .comment-form textarea:focus {
      border-color: #0066cc;
    }
    .comment-form textarea {
      min-height: 80px;
      resize: vertical;
    }
    .comment-form button {
      align-self: flex-start;
      font-family: inherit;
      font-size: 0.875rem;
      font-weight: 500;
      padding: 0.5rem 1.25rem;
      background: #1a1a1a;
      color: #fff;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      transition: background 0.2s;
    }
    .comment-form button:hover {
      background: #333;
    }
    .comment-form button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .comment-error {
      color: #dc2626;
      font-size: 0.8rem;
      display: none;
    }
    .comments-empty {
      color: #999;
      font-size: 0.875rem;
      padding: 1rem 0;
    }
    @media (max-width: 768px) {
      .comments-section {
        padding: 1.5rem;
      }
    }
    @media (prefers-color-scheme: dark) {
      html, body {
        background: #1a1a1a;
      }
      body {
        color: #f5f5f5;
      }
      .doc-content {
        background: #262626;
        border-color: #404040;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
      }
      .doc-content h1,
      .doc-content h2,
      .doc-content h3 {
        color: #f5f5f5;
      }
      .doc-content p,
      .doc-content li {
        color: #d4d4d4;
      }
      .doc-content code {
        background: #404040;
        color: #f97583;
      }
      .doc-content pre {
        background: #0d0d0d;
      }
      .doc-content blockquote {
        border-left-color: #404040;
        color: #a3a3a3;
      }
      .doc-content a {
        color: #58a6ff;
      }
      .doc-content a:hover {
        border-bottom-color: #58a6ff;
      }
      .doc-content hr {
        border-top-color: #404040;
      }
      .doc-content th,
      .doc-content td {
        border-color: #404040;
      }
      .doc-content th {
        background: #333;
      }
      .doc-toolbar-item {
        background: rgba(38, 38, 38, 0.95);
        border-color: #404040;
        color: #a3a3a3;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
      }
      .doc-toolbar-item:hover {
        border-color: #525252;
        background: rgba(51, 51, 51, 0.95);
      }
      .doc-toolbar-item a {
        color: #f5f5f5;
      }
      .comments-section {
        background: #262626;
        border-color: #404040;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
      }
      .comments-heading {
        color: #f5f5f5;
      }
      .comment-item {
        border-bottom-color: #333;
      }
      .comment-author {
        color: #f5f5f5;
      }
      .comment-time {
        color: #777;
      }
      .comment-body {
        color: #d4d4d4;
      }
      .comment-form {
        border-top-color: #404040;
      }
      .comment-form input,
      .comment-form textarea {
        background: #1a1a1a;
        border-color: #404040;
        color: #f5f5f5;
      }
      .comment-form input:focus,
      .comment-form textarea:focus {
        border-color: #58a6ff;
      }
      .comment-form button {
        background: #f5f5f5;
        color: #1a1a1a;
      }
      .comment-form button:hover {
        background: #d4d4d4;
      }
      .comments-empty {
        color: #777;
      }
    }
  </style>
</head>
<body>
  <div class="doc-container">
    <article class="doc-content">
      ${sanitizedHtml}
    </article>
    <section class="comments-section">
      <h2 class="comments-heading">Comments (<span id="comment-count">0</span>)</h2>
      <div class="comments-list" id="comments-list">
        <p class="comments-empty" id="comments-empty">No comments yet. Be the first!</p>
      </div>
      <form class="comment-form" id="comment-form">
        <input type="text" id="comment-name" placeholder="Your name" required maxlength="100" />
        <textarea id="comment-body" placeholder="Write a comment…" required maxlength="2000"></textarea>
        <div class="comment-error" id="comment-error"></div>
        <button type="submit">Post comment</button>
      </form>
    </section>
  </div>
  <div class="doc-toolbar">
    <span class="doc-toolbar-item">Made readable with <a href="/">plsreadme</a></span>
    <button class="doc-toolbar-item" onclick="copyLink()">
      <i class="hgi-stroke hgi-link-01"></i>
      Copy link
    </button>
    <a href="/v/${docId}/raw" class="doc-toolbar-item">
      <i class="hgi-stroke hgi-download-01"></i>
      Raw
    </a>
  </div>
  <script>
    function copyLink() {
      navigator.clipboard.writeText(window.location.href).then(() => {
        const btn = event.target.closest('.doc-toolbar-item');
        const originalText = btn.innerHTML;
        btn.innerHTML = '<i class="hgi-stroke hgi-checkmark-01"></i> Copied!';
        setTimeout(() => {
          btn.innerHTML = originalText;
        }, 2000);
      });
    }

    (function() {
      const DOC_ID = '${docId}';
      const listEl = document.getElementById('comments-list');
      const emptyEl = document.getElementById('comments-empty');
      const countEl = document.getElementById('comment-count');
      const form = document.getElementById('comment-form');
      const nameInput = document.getElementById('comment-name');
      const bodyInput = document.getElementById('comment-body');
      const errorEl = document.getElementById('comment-error');

      // Restore saved name
      const saved = localStorage.getItem('plsreadme_author_name');
      if (saved) nameInput.value = saved;
      nameInput.addEventListener('change', function() {
        localStorage.setItem('plsreadme_author_name', this.value);
      });

      function relativeTime(dateStr) {
        var diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
        if (diff < 60) return 'just now';
        if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
        if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
        if (diff < 2592000) return Math.floor(diff / 86400) + 'd ago';
        return new Date(dateStr).toLocaleDateString();
      }

      function renderComment(c) {
        var div = document.createElement('div');
        div.className = 'comment-item';
        div.innerHTML = '<div class="comment-meta"><span class="comment-author"></span><span class="comment-time"></span></div><p class="comment-body"></p>';
        div.querySelector('.comment-author').textContent = c.author_name;
        div.querySelector('.comment-time').textContent = relativeTime(c.created_at);
        div.querySelector('.comment-body').textContent = c.body;
        return div;
      }

      function loadComments() {
        fetch('/api/comments/' + DOC_ID)
          .then(function(r) { return r.json(); })
          .then(function(data) {
            var comments = data.comments || [];
            countEl.textContent = comments.length;
            if (comments.length === 0) {
              emptyEl.style.display = '';
              return;
            }
            emptyEl.style.display = 'none';
            comments.forEach(function(c) {
              listEl.appendChild(renderComment(c));
            });
          })
          .catch(function() {});
      }

      form.addEventListener('submit', function(e) {
        e.preventDefault();
        errorEl.style.display = 'none';
        var btn = form.querySelector('button');
        btn.disabled = true;
        fetch('/api/comments/' + DOC_ID, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ author_name: nameInput.value.trim(), body: bodyInput.value.trim() })
        })
          .then(function(r) {
            if (!r.ok) return r.json().then(function(d) { throw new Error(d.error || 'Failed'); });
            return r.json();
          })
          .then(function(data) {
            var c = data.comment;
            emptyEl.style.display = 'none';
            listEl.appendChild(renderComment(c));
            var n = parseInt(countEl.textContent) + 1;
            countEl.textContent = n;
            bodyInput.value = '';
            localStorage.setItem('plsreadme_author_name', nameInput.value.trim());
          })
          .catch(function(err) {
            errorEl.textContent = err.message;
            errorEl.style.display = '';
          })
          .finally(function() { btn.disabled = false; });
      });

      loadComments();
    })();
  </script>
</body>
</html>`;
}

// POST /api/render - Create a new document
app.post("/", async (c) => {
  try {
    const contentType = c.req.header("content-type") || "";
    let markdown = "";
    let clientIp = c.req.header("cf-connecting-ip") || "unknown";

    // Parse input - either JSON or multipart form data
    if (contentType.includes("application/json")) {
      const body = await c.req.json();
      markdown = body.markdown || "";
    } else if (contentType.includes("multipart/form-data")) {
      const formData = await c.req.formData();
      const file = formData.get("file");

      if (file && typeof file !== "string") {
        // Cloudflare Workers typings (with lib ES2022) don't include DOM `File`,
        // so we read the blob via Response to avoid `never` typing.
        markdown = await new Response(file as any).text();
      } else {
        markdown = (formData.get("markdown") as string) || "";
      }
    } else {
      // Try to read as text
      markdown = await c.req.text();
    }

    // Validate input
    if (!markdown || markdown.trim().length === 0) {
      return c.json({ error: "No markdown content provided" }, 400);
    }

    if (markdown.length > MAX_FILE_SIZE) {
      return c.json(
        { error: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024} KB` },
        400
      );
    }

    // Rate limiting
    const allowed = await checkRateLimit(c.env, clientIp);
    if (!allowed) {
      return c.json(
        { error: "Rate limit exceeded. Maximum 30 uploads per hour." },
        429
      );
    }

    // Generate ID and hash
    const id = nanoid(10);
    const hash = await sha256(markdown);
    const r2Key = `md/${id}.md`;
    const title = extractTitle(markdown);
    const now = new Date().toISOString();

    // Store in R2
    await c.env.DOCS_BUCKET.put(r2Key, markdown, {
      httpMetadata: {
        contentType: "text/markdown",
      },
      customMetadata: {
        created_at: now,
        sha256: hash,
      },
    });

    // Store metadata in D1
    await c.env.DB.prepare(
      "INSERT INTO docs (id, r2_key, content_type, bytes, created_at, sha256, title) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(id, r2Key, "text/markdown", markdown.length, now, hash, title)
      .run();

    // Send Discord notification (optional, best-effort)
    const linkWebhookUrl = c.env.DISCORD_LINK_WEBHOOK_URL;
    if (linkWebhookUrl) {
      const baseUrl = new URL(c.req.url).origin;
      const notifyPromise = sendDiscordLinkCreatedNotification(linkWebhookUrl, {
        id,
        title,
        url: `${baseUrl}/v/${id}`,
        rawUrl: `${baseUrl}/v/${id}/raw`,
        bytes: markdown.length,
      });

      const execCtx = (c as any).executionCtx as ExecutionContext | undefined;
      if (execCtx && typeof execCtx.waitUntil === "function") {
        execCtx.waitUntil(notifyPromise);
      } else {
        // Fallback (still best-effort)
        notifyPromise.catch(() => {});
      }
    }

    // Track analytics event
    try {
      await c.env.ANALYTICS.writeDataPoint({
        blobs: ["doc_create", id],
        doubles: [markdown.length],
        indexes: [clientIp],
      });
    } catch (e) {
      // Silent fail on analytics
      console.error("Analytics error:", e);
    }

    // Return success
    const baseUrl = new URL(c.req.url).origin;
    return c.json({
      id,
      url: `${baseUrl}/v/${id}`,
      raw_url: `${baseUrl}/v/${id}/raw`,
    });
  } catch (error) {
    console.error("Error creating document:", error);
    return c.json({ error: "Failed to create document" }, 500);
  }
});

// GET /api/render/test-discord - Test link generation Discord notification
app.get("/test-discord", async (c) => {
  if (!c.env.DISCORD_LINK_WEBHOOK_URL) {
    return c.json({ error: "DISCORD_LINK_WEBHOOK_URL not set" }, 400);
  }

  const baseUrl = new URL(c.req.url).origin;
  const id = "test-doc";
  await sendDiscordLinkCreatedNotification(c.env.DISCORD_LINK_WEBHOOK_URL, {
    id,
    title: "Test link notification",
    url: `${baseUrl}/v/${id}`,
    rawUrl: `${baseUrl}/v/${id}/raw`,
    bytes: 1234,
  });

  return c.json({
    success: true,
    message: "Sent test Discord link notification",
  });
});

// GET /v/:id - Render the document as HTML
app.get("/:id", async (c) => {
  try {
    const id = c.req.param("id");

    // Fetch metadata from D1
    const doc = await c.env.DB.prepare("SELECT * FROM docs WHERE id = ?")
      .bind(id)
      .first<DocRecord>();

    if (!doc) {
      return c.html(
        `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Document Not Found</title>
          <link rel="stylesheet" href="/styles.css">
        </head>
        <body style="display: flex; align-items: center; justify-content: center; min-height: 100vh; text-align: center;">
          <div>
            <h1>Document Not Found</h1>
            <p>The document you're looking for doesn't exist.</p>
            <a href="/" style="color: #0066cc;">Return to homepage</a>
          </div>
        </body>
        </html>
      `,
        404
      );
    }

    // Increment view_count
    await c.env.DB.prepare(
      "UPDATE docs SET view_count = view_count + 1 WHERE id = ?"
    )
      .bind(id)
      .run();

    // Fetch content from R2
    const object = await c.env.DOCS_BUCKET.get(doc.r2_key);
    if (!object) {
      return c.html(
        "<h1>Error</h1><p>Document content not found in storage.</p>",
        500
      );
    }

    const markdown = await object.text();

    // Convert markdown to HTML
    const htmlContent = marked(markdown);

    // Generate and return the full HTML page
    const html = generateHtmlTemplate(doc.title, htmlContent as string, id);
    return c.html(html);
  } catch (error) {
    console.error("Error rendering document:", error);
    return c.html("<h1>Error</h1><p>Failed to render document.</p>", 500);
  }
});

// GET /api/render/count - Get docs count for social proof
app.get("/count", async (c) => {
  try {
    const result = await c.env.DB.prepare(
      "SELECT COUNT(*) as count FROM docs"
    ).first<{ count: number }>();

    const count = result?.count || 0;

    // Apply social proof rules
    let display: string | null = null;
    if (count >= 100) {
      display = `${Math.floor(count / 100) * 100}+`;
    } else if (count >= 10) {
      display = count.toString();
    }
    // < 10: null (hide)

    return c.json({ count, display });
  } catch (error) {
    console.error("Count error:", error);
    return c.json({ count: 0, display: null });
  }
});

// GET /v/:id/raw - Get raw markdown
app.get("/:id/raw", async (c) => {
  try {
    const id = c.req.param("id");

    // Fetch metadata from D1
    const doc = await c.env.DB.prepare("SELECT * FROM docs WHERE id = ?")
      .bind(id)
      .first<DocRecord>();

    if (!doc) {
      return c.text("Document not found", 404);
    }

    // Fetch content from R2
    const object = await c.env.DOCS_BUCKET.get(doc.r2_key);
    if (!object) {
      return c.text("Document content not found", 500);
    }

    const markdown = await object.text();

    // Return raw markdown
    return c.text(markdown, 200, {
      "Content-Type": "text/markdown",
      "Content-Disposition": `attachment; filename="${doc.title || id}.md"`,
    });
  } catch (error) {
    console.error("Error fetching raw document:", error);
    return c.text("Failed to fetch document", 500);
  }
});

export { app as docsRoutes };
