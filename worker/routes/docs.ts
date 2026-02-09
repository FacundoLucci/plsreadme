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
function slugifyAnchorText(text: string): string {
  const stripped = text
    .toLowerCase()
    .replace(/&[a-z0-9#]+;/gi, " ")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return stripped || "node";
}

function addStableAnchorIds(html: string): string {
  const used = new Map<string, number>();
  const eligible = /<(h[1-6]|p|li|blockquote|pre)(\s[^>]*)?>([\s\S]*?)<\/\1>/gi;

  return html.replace(eligible, (full, tag, attrs = "", inner) => {
    if (/\sid\s*=\s*["'][^"']+["']/i.test(attrs)) {
      return full;
    }

    const text = inner
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);

    const base = slugifyAnchorText(text || tag);
    const count = (used.get(base) || 0) + 1;
    used.set(base, count);
    const id = count === 1 ? base : `${base}-${count}`;

    return `<${tag}${attrs} id="${id}">${inner}</${tag}>`;
  });
}

// Helper: Generate HTML template for rendered doc
function generateHtmlTemplate(
  title: string | null,
  htmlContent: string,
  docId: string
): string {
  const pageTitle = title || "Untitled Document";
  const anchoredHtml = addStableAnchorIds(htmlContent);
  const sanitizedHtml = sanitizeHtml(anchoredHtml);

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
  <style>
    :root { color-scheme: light dark; }
    html, body { margin: 0; padding: 0; background: #fafafa; }
    body { font-family: 'Instrument Sans', sans-serif; color: #1f2937; }
    .layout { max-width: 1240px; margin: 0 auto; padding: 1.5rem; display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 1rem; }
    .doc-content { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 2.2rem; line-height: 1.7; }
    .doc-content :is(h1,h2,h3,h4,h5,h6,p,li,blockquote,pre)[id] { position: relative; cursor: pointer; }
    .doc-content :is(h1,h2,h3,h4,h5,h6,p,li,blockquote,pre)[id]:hover { background: rgba(59,130,246,0.08); }
    .doc-content .anchor-selected { background: rgba(59,130,246,0.16); border-radius: 6px; }
    .anchor-dot { position: absolute; left: -14px; top: 0.7em; width: 8px; height: 8px; border-radius: 50%; background: #2563eb; }
    .side-panel { position: sticky; top: 1rem; align-self: start; background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 1rem; max-height: calc(100vh - 2rem); overflow: auto; }
    .panel-header { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
    .panel-title { margin: 0; font-size: 1rem; }
    .anchor-context { font-size: 0.82rem; color: #6b7280; margin: 0.5rem 0 0.75rem; }
    .general-btn { border: 1px solid #d1d5db; background: #f9fafb; border-radius: 6px; font-size: 0.78rem; padding: 0.25rem 0.55rem; cursor: pointer; }
    .comments-list { display: flex; flex-direction: column; gap: 0.75rem; margin-top: 0.5rem; }
    .comment-item { border-bottom: 1px solid #f3f4f6; padding-bottom: 0.75rem; }
    .comment-item:last-child { border-bottom: none; }
    .comment-meta { font-size: 0.75rem; color: #6b7280; }
    .comment-author { font-weight: 600; color: #111827; margin-right: 0.5rem; }
    .comment-body { margin: 0.3rem 0 0; white-space: pre-wrap; font-size: 0.88rem; }
    .comment-form { display: flex; flex-direction: column; gap: 0.55rem; margin-top: 0.9rem; }
    .comment-form input,.comment-form textarea { width: 100%; box-sizing: border-box; padding: 0.55rem 0.65rem; border: 1px solid #d1d5db; border-radius: 6px; background: #fff; color: inherit; font-family: inherit; }
    .comment-form textarea { min-height: 80px; resize: vertical; }
    .comment-form button { align-self: flex-start; background: #111827; color: #fff; border: none; border-radius: 6px; padding: 0.45rem 0.9rem; cursor: pointer; }
    .comment-error { display: none; color: #dc2626; font-size: 0.8rem; }
    .comments-empty { color: #6b7280; font-size: 0.85rem; }
    .doc-toolbar { position: fixed; left: 1rem; bottom: 1rem; display: flex; gap: 0.5rem; }
    .doc-toolbar-item { border: 1px solid #d1d5db; border-radius: 6px; background: rgba(255,255,255,0.95); padding: 0.45rem 0.7rem; font-size: 0.75rem; color: #111827; text-decoration: none; }
    @media (max-width: 980px) { .layout { grid-template-columns: 1fr; } .side-panel { position: static; max-height: none; } .anchor-dot { left: -10px; } }
    @media (prefers-color-scheme: dark) {
      html, body { background: #111827; color: #e5e7eb; }
      .doc-content,.side-panel { background: #1f2937; border-color: #374151; }
      .doc-content :is(p,li,blockquote) { color: #d1d5db; }
      .doc-content :is(h1,h2,h3,h4,h5,h6) { color: #f9fafb; }
      .doc-content :is(h1,h2,h3,h4,h5,h6,p,li,blockquote,pre)[id]:hover { background: rgba(96,165,250,0.15); }
      .doc-content .anchor-selected { background: rgba(96,165,250,0.22); }
      .general-btn,.comment-form input,.comment-form textarea,.doc-toolbar-item { background: #111827; border-color: #4b5563; color: #e5e7eb; }
      .comment-author { color: #f9fafb; }
    }
  </style>
</head>
<body>
  <div class="layout">
    <article class="doc-content" id="doc-content">${sanitizedHtml}</article>
    <aside class="side-panel">
      <div class="panel-header">
        <h2 class="panel-title">Comments (<span id="comment-count">0</span>)</h2>
        <button id="general-btn" class="general-btn" type="button">General</button>
      </div>
      <p class="anchor-context" id="anchor-context">Commenting on: General</p>
      <div class="comments-list" id="comments-list"><p class="comments-empty" id="comments-empty">No comments for this anchor yet.</p></div>
      <form class="comment-form" id="comment-form">
        <input type="text" id="comment-name" placeholder="Your name" required maxlength="50" />
        <textarea id="comment-body" placeholder="Write a comment…" required maxlength="2000"></textarea>
        <div class="comment-error" id="comment-error"></div>
        <button type="submit">Post comment</button>
      </form>
    </aside>
  </div>
  <div class="doc-toolbar">
    <span class="doc-toolbar-item">Made readable with <a href="/">plsreadme</a></span>
    <button class="doc-toolbar-item" onclick="copyLink()">Copy link</button>
    <a href="/v/${docId}/raw" class="doc-toolbar-item">Raw</a>
  </div>
  <script>
    function copyLink() { navigator.clipboard.writeText(window.location.href); }
    (function() {
      var DOC_ID = '${docId}';
      var DOC_ROOT = 'doc-root';
      var selectedAnchor = DOC_ROOT;
      var selectedEl = null;
      var selectedDot = null;
      var allComments = [];
      var contentEl = document.getElementById('doc-content');
      var listEl = document.getElementById('comments-list');
      var emptyEl = document.getElementById('comments-empty');
      var countEl = document.getElementById('comment-count');
      var form = document.getElementById('comment-form');
      var nameInput = document.getElementById('comment-name');
      var bodyInput = document.getElementById('comment-body');
      var errorEl = document.getElementById('comment-error');
      var contextEl = document.getElementById('anchor-context');
      var generalBtn = document.getElementById('general-btn');

      var saved = localStorage.getItem('plsreadme_author_name');
      if (saved) nameInput.value = saved;
      nameInput.addEventListener('input', function() { localStorage.setItem('plsreadme_author_name', this.value.trim()); });

      function relativeTime(dateStr) {
        var diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
        if (diff < 60) return 'just now';
        if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
        if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
        return Math.floor(diff / 86400) + 'd ago';
      }

      function contextText() {
        if (selectedAnchor === DOC_ROOT) return 'Commenting on: General';
        var snippet = selectedEl ? (selectedEl.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) : selectedAnchor;
        return 'Comment on: ' + snippet;
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

      function renderComments() {
        listEl.innerHTML = '';
        var filtered = allComments.filter(function(c) { return (c.anchor_id || DOC_ROOT) === selectedAnchor; });
        countEl.textContent = filtered.length;
        contextEl.textContent = contextText();
        if (!filtered.length) {
          emptyEl.style.display = '';
          listEl.appendChild(emptyEl);
          return;
        }
        emptyEl.style.display = 'none';
        filtered.forEach(function(c) { listEl.appendChild(renderComment(c)); });
      }

      function clearSelection() {
        if (selectedEl) selectedEl.classList.remove('anchor-selected');
        if (selectedDot && selectedDot.parentNode) selectedDot.parentNode.removeChild(selectedDot);
        selectedEl = null;
        selectedDot = null;
      }

      function selectGeneral() {
        selectedAnchor = DOC_ROOT;
        clearSelection();
        renderComments();
      }

      function selectAnchor(el) {
        clearSelection();
        selectedEl = el;
        selectedAnchor = el.id || DOC_ROOT;
        el.classList.add('anchor-selected');
        selectedDot = document.createElement('span');
        selectedDot.className = 'anchor-dot';
        el.appendChild(selectedDot);
        renderComments();
      }

      contentEl.addEventListener('click', function(e) {
        var target = e.target && e.target.closest ? e.target.closest('h1,h2,h3,h4,h5,h6,p,li,blockquote,pre') : null;
        if (!target || !target.id || !contentEl.contains(target)) return;
        selectAnchor(target);
      });

      generalBtn.addEventListener('click', selectGeneral);

      function loadComments() {
        fetch('/api/comments/' + DOC_ID)
          .then(function(r) { return r.json(); })
          .then(function(data) { allComments = data.comments || []; renderComments(); })
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
          body: JSON.stringify({ author_name: nameInput.value.trim(), body: bodyInput.value.trim(), anchor_id: selectedAnchor })
        })
          .then(function(r) {
            if (!r.ok) return r.json().then(function(d) { throw new Error(d.error || 'Failed'); });
            return r.json();
          })
          .then(function(data) {
            allComments.push(data.comment);
            bodyInput.value = '';
            localStorage.setItem('plsreadme_author_name', nameInput.value.trim());
            renderComments();
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
