import { Hono, type Context } from "hono";
import { nanoid } from "nanoid";
import { marked } from "marked";
import type { Env, DocRecord } from "../types";
import {
  WRITE_RATE_LIMITS,
  checkAndConsumeRateLimit,
  failureToErrorPayload,
  getClientIp,
  logAbuseAttempt,
  parseContentLength,
  resolveRateLimitActorKey,
  sha256,
  validateContentLength,
  validateMarkdown,
} from "../security.ts";
import { getRequestAuth } from "../auth.ts";
import { ensureOwnershipSchema } from "../ownership.ts";

const app = new Hono<{ Bindings: Env }>();

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

// Helper: Sanitize HTML (basic XSS prevention)
function sanitizeHtml(html: string): string {
  // Remove script tags and event handlers
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/on\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/on\w+\s*=\s*'[^']*'/gi, "")
    .replace(/javascript:/gi, "");
}

function wrapScrollableMarkdownTables(html: string): string {
  return html.replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, (tableMarkup) => {
    return `<div class="doc-table-scroll">${tableMarkup}</div>`;
  });
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

type DocVersionHistoryEntry = {
  version: number;
  is_current: boolean;
  raw_url: string;
};

function resolveDocVersion(doc: DocRecord): number {
  const parsed = Number(doc.doc_version ?? 1);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return 1;
  }
  return parsed;
}

function buildDocVersionHistory(baseUrl: string, doc: DocRecord): DocVersionHistoryEntry[] {
  const currentVersion = resolveDocVersion(doc);
  const versions: DocVersionHistoryEntry[] = [];

  for (let version = currentVersion; version >= 1; version -= 1) {
    versions.push({
      version,
      is_current: version === currentVersion,
      raw_url:
        version === currentVersion
          ? `${baseUrl}/v/${doc.id}/raw`
          : `${baseUrl}/v/${doc.id}/raw?version=${version}`,
    });
  }

  return versions;
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function generateVersionHistoryHtml(doc: DocRecord, versions: DocVersionHistoryEntry[]): string {
  const safeTitle = escapeHtmlText(doc.title || "Untitled Document");
  const safeCreatedAt = escapeHtmlText(doc.created_at || "unknown");
  const currentVersion = resolveDocVersion(doc);

  const listItems = versions
    .map((entry) => {
      const versionLabel = `v${entry.version}`;
      const contextLabel = entry.is_current ? "Latest readable link" : "Snapshot before an edit";
      const currentBadge = entry.is_current
        ? '<span class="version-current-chip">Current</span>'
        : '<span class="version-archived-chip">Archived</span>';
      const restoreAction = entry.is_current
        ? '<p class="restore-hint">Already the active version.</p>'
        : `<button type="button" class="restore-btn" data-restore-version="${entry.version}">Restore this version</button>`;

      return `<li>
        <div class="version-header">
          <strong>${versionLabel}</strong>
          ${currentBadge}
        </div>
        <p class="version-context">${contextLabel}</p>
        <div class="version-actions">
          <a href="${entry.raw_url}" target="_blank" rel="noopener">Open raw markdown</a>
          ${restoreAction}
        </div>
      </li>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeTitle} — Version History</title>
  <style>
    body { font-family: Inter, system-ui, sans-serif; background: #f8fafc; color: #0f172a; margin: 0; }
    main { max-width: 760px; margin: 0 auto; padding: 2rem 1rem 3rem; }
    h1 { margin-bottom: 0.4rem; }
    .meta { color: #475569; font-size: 0.92rem; margin-bottom: 1rem; }
    .actions { display: flex; gap: 0.65rem; margin-bottom: 1.25rem; flex-wrap: wrap; }
    .actions a { text-decoration: none; color: #1d4ed8; font-weight: 600; }
    .restore-panel { border: 1px solid #fed7aa; background: #fff7ed; border-radius: 10px; padding: 0.85rem 0.95rem; margin-bottom: 1rem; }
    .restore-panel p { margin: 0.35rem 0; }
    .restore-warning { color: #9a3412; font-weight: 600; font-size: 0.87rem; }
    .restore-token-field { margin-top: 0.55rem; display: grid; gap: 0.35rem; }
    .restore-token-field label { font-size: 0.8rem; color: #7c2d12; font-weight: 600; }
    .restore-token-field input { border: 1px solid #fdba74; border-radius: 8px; padding: 0.45rem 0.55rem; font-size: 0.86rem; }
    .restore-status { min-height: 1.2rem; margin-top: 0.55rem; font-size: 0.84rem; color: #1e3a8a; }
    .restore-status[data-state="error"] { color: #b91c1c; }
    .restore-status[data-state="success"] { color: #166534; }
    .restore-success { display: none; border: 1px solid #86efac; background: #f0fdf4; border-radius: 8px; padding: 0.65rem 0.75rem; margin-top: 0.55rem; font-size: 0.86rem; }
    .restore-success a { color: #166534; font-weight: 600; }
    ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 0.75rem; }
    li { border: 1px solid #dbe2ea; border-radius: 10px; background: white; padding: 0.8rem 0.9rem; }
    .version-header { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; margin-bottom: 0.2rem; }
    .version-current-chip,
    .version-archived-chip { font-size: 0.72rem; border-radius: 999px; padding: 0.16rem 0.5rem; font-weight: 700; }
    .version-current-chip { background: #dcfce7; color: #166534; }
    .version-archived-chip { background: #e2e8f0; color: #334155; }
    .version-context { color: #64748b; font-size: 0.84rem; margin: 0 0 0.45rem; }
    .version-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 0.6rem; }
    .version-actions a { color: #1d4ed8; font-weight: 600; text-decoration: none; }
    .restore-btn { border: 1px solid #f59e0b; border-radius: 8px; background: #fffbeb; color: #92400e; font-size: 0.78rem; font-weight: 700; padding: 0.32rem 0.58rem; cursor: pointer; }
    .restore-btn:hover { border-color: #d97706; background: #fef3c7; }
    .restore-btn[disabled] { opacity: 0.65; cursor: wait; }
    .restore-hint { color: #64748b; font-size: 0.78rem; margin: 0; }
  </style>
</head>
<body>
  <main>
    <h1>Version history</h1>
    <p class="meta">${safeTitle} · Created ${safeCreatedAt} · Current version v${currentVersion}</p>
    <div class="actions">
      <a href="/v/${doc.id}">← Back to readable doc</a>
      <a href="/v/${doc.id}/versions" target="_blank" rel="noopener">View JSON API</a>
    </div>

    <section class="restore-panel" aria-labelledby="restore-panel-heading">
      <h2 id="restore-panel-heading" style="margin:0; font-size:0.98rem;">Restore an older version</h2>
      <p class="restore-warning">⚠️ Restoring will create a new current version and can impact active review threads.</p>
      <p style="color:#7c2d12; font-size:0.84rem; margin-bottom:0;">Use your admin token and confirm intentionally. This action should only be used when you want to roll back visible content.</p>
      <div class="restore-token-field">
        <label for="restore-admin-token">Admin token (required for restore)</label>
        <input id="restore-admin-token" type="password" autocomplete="off" placeholder="sk_..." />
      </div>
      <p class="restore-status" id="restore-status" aria-live="polite"></p>
      <div class="restore-success" id="restore-success">
        Restore completed. <a id="restore-readable-link" href="/v/${doc.id}">Open readable doc</a> · <a id="restore-history-link" href="/v/${doc.id}/history">Refresh history</a>
      </div>
    </section>

    <ul>
      ${listItems}
    </ul>
  </main>
  <script>
    (function () {
      const tokenInput = document.getElementById("restore-admin-token");
      const statusEl = document.getElementById("restore-status");
      const successEl = document.getElementById("restore-success");
      const readableLink = document.getElementById("restore-readable-link");
      const historyLink = document.getElementById("restore-history-link");
      const restoreButtons = document.querySelectorAll("[data-restore-version]");

      function setStatus(message, state) {
        if (!statusEl) return;
        statusEl.textContent = message;
        statusEl.dataset.state = state || "";
      }

      async function restoreVersion(button) {
        const requestedVersion = Number(button.getAttribute("data-restore-version"));
        if (!Number.isInteger(requestedVersion) || requestedVersion < 1) {
          setStatus("Invalid restore target.", "error");
          return;
        }

        const token = (tokenInput && tokenInput.value ? tokenInput.value : "").trim();
        if (!token) {
          setStatus("Admin token is required before restoring.", "error");
          if (tokenInput) tokenInput.focus();
          return;
        }

        const confirmed = window.confirm("Restore v" + requestedVersion + "? This creates a new current version and may affect collaborators viewing the doc.");
        if (!confirmed) {
          return;
        }

        if (successEl) successEl.style.display = "none";
        button.disabled = true;
        const previousLabel = button.textContent;
        button.textContent = "Restoring…";
        setStatus("Restoring v" + requestedVersion + "…", "");

        try {
          const response = await fetch("/v/${doc.id}/restore", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: "Bearer " + token,
            },
            body: JSON.stringify({ version: requestedVersion }),
          });

          const payload = await response.json().catch(() => ({}));
          if (!response.ok) {
            const errorMessage = typeof payload.error === "string" ? payload.error : "Restore failed.";
            throw new Error(errorMessage);
          }

          const nextVersion = Number(payload.current_version);
          const versionLabel = Number.isInteger(nextVersion) ? "v" + nextVersion : "the latest version";
          setStatus("Restore complete. " + versionLabel + " is now current.", "success");

          if (readableLink && typeof payload.url === "string") {
            readableLink.href = payload.url;
          }
          if (historyLink && typeof payload.history_url === "string") {
            historyLink.href = payload.history_url;
          }
          if (successEl) {
            successEl.style.display = "block";
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "Restore failed.";
          setStatus(message, "error");
        } finally {
          button.disabled = false;
          button.textContent = previousLabel;
        }
      }

      restoreButtons.forEach((button) => {
        button.addEventListener("click", () => {
          void restoreVersion(button);
        });
      });
    })();
  </script>
</body>
</html>`;
}

// Helper: Generate HTML template for rendered doc
export function generateHtmlTemplate(
  title: string | null,
  htmlContent: string,
  docId: string,
  docVersion: number
): string {
  const pageTitle = title || "Untitled Document";
  const anchoredHtml = addStableAnchorIds(htmlContent);
  const sanitizedHtml = sanitizeHtml(anchoredHtml);
  const responsiveHtml = wrapScrollableMarkdownTables(sanitizedHtml);

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
  <link href="https://fonts.googleapis.com/css2?family=Lexend:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      color-scheme: light dark;
      --page-bg: #f6f5f2;
      --text-main: #1d1f24;
      --text-muted: #666b74;
      --surface: #fdfcf9;
      --surface-muted: #f2f0eb;
      --border: #e5e1d8;
      --header-bg: rgba(246, 245, 242, 0.96);
      --panel-shadow: 0 4px 12px rgba(17, 24, 39, 0.08);
      --tooltip-shadow: 0 2px 10px rgba(17, 24, 39, 0.08);
      --table-bg: #fffefb;
      --table-header-bg: #f5f2ea;
      --table-header-text: #20242d;
      --table-border: #ddd6c9;
      --table-row-alt: rgba(82, 92, 109, 0.04);
      --table-row-hover: rgba(59, 130, 246, 0.08);
      --table-shadow: 0 1px 3px rgba(15, 23, 42, 0.06);
      --control-radius: 999px;
    }
    html, body { margin: 0; padding: 0; background: var(--page-bg); }
    body { font-family: 'Lexend', 'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif; color: var(--text-main); }
    .viewer-header { position: sticky; top: 0; z-index: 30; border-bottom: 1px solid var(--border); background: var(--header-bg); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); }
    .viewer-header-inner { max-width: 1240px; margin: 0 auto; padding: 0.75rem 1.5rem; display: flex; align-items: center; justify-content: flex-start; gap: 0.85rem; }
    .viewer-brand { display: inline-flex; align-items: center; gap: 0.45rem; color: var(--text-main); text-decoration: none; font-weight: 700; font-size: 0.96rem; }
    .viewer-brand:hover { color: #2563eb; }
    .viewer-header-actions { margin-left: auto; min-width: 0; display: inline-flex; align-items: center; gap: 0.5rem; }
    .viewer-header-actions .preview-save-btn { padding: 0.32rem 0.74rem; font-size: 0.72rem; line-height: 1.2; white-space: nowrap; }
    .viewer-header-actions .preview-save-status { max-width: min(19rem, 36vw); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .doc-version-badge { border: 1px solid #bfdbfe; border-radius: var(--control-radius); background: #eff6ff; color: #1e3a8a; font-size: 0.72rem; font-weight: 700; padding: 0.26rem 0.56rem; white-space: nowrap; }
    .viewer-auth-shell { min-height: 34px; display: flex; align-items: center; }
    .preview-save-btn { border: 1px solid var(--border); border-radius: var(--control-radius); background: var(--surface); color: var(--text-main); padding: 0.44rem 0.92rem; font-size: 0.75rem; font-weight: 600; cursor: pointer; text-align: left; white-space: normal; overflow-wrap: anywhere; word-break: break-word; }
    .preview-save-btn:hover { border-color: #93c5fd; background: #eff6ff; }
    .preview-save-btn[data-state="saved"] { border-color: #f59e0b; color: #92400e; background: #fffbeb; }
    .preview-save-btn[data-state="created"] { border-color: #86efac; color: #166534; background: #f0fdf4; cursor: default; }
    .preview-save-status { font-size: 0.72rem; color: var(--text-muted); }
    .preview-save-status button { margin-left: 0.35rem; border: none; background: none; color: #2563eb; font-weight: 600; cursor: pointer; padding: 0; }
    .auth-shell-inner { display: flex; align-items: center; gap: 0.45rem; }
    .auth-link-button { border: 1px solid var(--border); border-radius: var(--control-radius); background: var(--surface); color: var(--text-main); padding: 0.38rem 0.78rem; font-size: 0.75rem; font-weight: 600; cursor: pointer; }
    .auth-link-button:hover { border-color: #93c5fd; background: #eff6ff; }
    .auth-link-button-secondary { background: transparent; color: var(--text-muted); }
    .auth-menu { position: relative; }
    .auth-menu-trigger { display: inline-flex; align-items: center; gap: 0.35rem; border: 1px solid #dbeafe; border-radius: var(--control-radius); background: #eff6ff; color: #1e3a8a; padding: 0.16rem 0.26rem 0.16rem 0.2rem; cursor: pointer; }
    .auth-menu-trigger:hover { border-color: #93c5fd; background: #dbeafe; }
    .auth-menu-caret { font-size: 0.68rem; color: #1d4ed8; }
    .auth-menu-dropdown { position: absolute; right: 0; top: calc(100% + 0.35rem); min-width: 150px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); box-shadow: var(--panel-shadow); display: none; padding: 0.22rem; z-index: 40; }
    .auth-menu.is-open .auth-menu-dropdown { display: block; }
    .auth-menu-item { display: block; width: 100%; border: none; border-radius: 6px; background: transparent; color: var(--text-main); text-decoration: none; text-align: left; font-size: 0.75rem; font-weight: 600; padding: 0.4rem 0.52rem; cursor: pointer; }
    .auth-menu-item:hover { background: var(--surface-muted); }
    .auth-menu-item-button { font-family: inherit; }
    .auth-avatar { width: 1.5rem; height: 1.5rem; border-radius: 999px; overflow: hidden; display: inline-flex; align-items: center; justify-content: center; border: 1px solid #bfdbfe; background: #dbeafe; color: #1e3a8a; flex: 0 0 auto; }
    .auth-avatar-img { width: 100%; height: 100%; object-fit: cover; }
    .auth-avatar-fallback { font-size: 0.72rem; font-weight: 700; }
    .auth-user-chip { display: inline-flex; align-items: center; padding: 0.28rem 0.56rem; border-radius: var(--control-radius); border: 1px solid #dbeafe; background: #eff6ff; color: #1e3a8a; font-size: 0.72rem; max-width: 180px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .auth-secondary-link { color: #2563eb; text-decoration: none; font-size: 0.75rem; font-weight: 600; }
    .auth-secondary-link:hover { text-decoration: underline; }
    .auth-status { color: var(--text-muted); font-size: 0.75rem; }
    .layout { max-width: 1320px; margin: 0 auto; padding: 2rem 2.25rem 6.2rem; display: grid; grid-template-columns: minmax(0, 820px) minmax(260px, 320px); justify-content: center; align-items: start; gap: 2rem; }
    .doc-content { background: transparent; border: none; border-radius: 0; padding: 2.4rem 0.75rem 3rem; max-width: 820px; width: 100%; line-height: 1.7; min-width: 0; overflow-wrap: anywhere; }
    .doc-content :is(h1,h2,h3,h4,h5,h6,p,li,blockquote) { overflow-wrap: anywhere; word-break: break-word; }
    .doc-content .doc-table-scroll {
      max-width: 100%;
      margin: 1.1rem 0;
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
      border: 1px solid var(--table-border);
      border-radius: 12px;
      background: var(--table-bg);
      box-shadow: var(--table-shadow);
    }
    .doc-content .doc-table-scroll > table {
      width: max-content;
      min-width: 100%;
      table-layout: auto;
      border-collapse: separate;
      border-spacing: 0;
      margin: 0;
      font-size: 0.95rem;
      line-height: 1.55;
    }
    .doc-content .doc-table-scroll :is(th,td) {
      min-width: 7ch;
      padding: 0.68rem 0.85rem;
      white-space: normal;
      overflow-wrap: break-word;
      word-break: normal;
      border-right: 1px solid var(--table-border);
      border-bottom: 1px solid var(--table-border);
      vertical-align: top;
      font-size: inherit;
      line-height: inherit;
      transition: background 0.16s ease;
    }
    .doc-content .doc-table-scroll th {
      background: var(--table-header-bg);
      color: var(--table-header-text);
      font-size: 0.84rem;
      line-height: 1.35;
      font-weight: 650;
      text-align: left;
      letter-spacing: 0.01em;
    }
    .doc-content .doc-table-scroll tbody td {
      font-size: 0.95rem;
      line-height: 1.55;
    }
    .doc-content .doc-table-scroll :is(td,th) :is(p,strong,em,code,a,ul,ol,li) {
      font-size: inherit;
      line-height: inherit;
    }
    .doc-content .doc-table-scroll :is(td,th) :is(p,ul,ol) { margin: 0; }
    .doc-content .doc-table-scroll :is(td,th) :is(ul,ol) { padding-left: 1.2rem; }
    .doc-content .doc-table-scroll :is(td,th) li + li { margin-top: 0.22rem; }
    .doc-content .doc-table-scroll :is(th,td):last-child { border-right: none; }
    .doc-content .doc-table-scroll tbody tr:last-child td { border-bottom: none; }
    .doc-content .doc-table-scroll tbody tr:nth-child(even) td { background: var(--table-row-alt); }
    .doc-content .doc-table-scroll tbody tr:hover td { background: var(--table-row-hover); }
    .doc-content .doc-table-scroll thead tr:first-child th:first-child { border-top-left-radius: 11px; }
    .doc-content .doc-table-scroll thead tr:first-child th:last-child { border-top-right-radius: 11px; }
    .doc-content .doc-table-scroll tbody tr:last-child td:first-child { border-bottom-left-radius: 11px; }
    .doc-content .doc-table-scroll tbody tr:last-child td:last-child { border-bottom-right-radius: 11px; }
    .doc-content pre { max-width: 100%; overflow-x: auto; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }
    .doc-content pre code { white-space: inherit; word-break: inherit; }
    .doc-content code { overflow-wrap: anywhere; word-break: break-word; }
    .doc-content :is(h1,h2,h3,h4,h5,h6,p,li,blockquote,pre)[id] { position: relative; cursor: pointer; }
    .doc-content :is(h1,h2,h3,h4,h5,h6,p,li,blockquote,pre)[id]:hover { background: rgba(59,130,246,0.08); }
    .doc-content .anchor-selected { background: rgba(59,130,246,0.16); border-radius: 6px; }
    .anchor-dot { position: absolute; left: -14px; top: 0.7em; width: 8px; height: 8px; border-radius: 50%; background: #2563eb; }
    .side-panel { position: sticky; top: 4.5rem; align-self: start; background: transparent; border: none; border-left: 1px solid var(--border); border-radius: 0; padding: 0.3rem 0 0.6rem 1.25rem; max-height: calc(100vh - 5.25rem); overflow: auto; }
    .panel-header { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
    .panel-title { margin: 0; font-size: 1rem; }
    .review-mode-controls { display: inline-flex; align-items: center; gap: 0.32rem; margin-top: 0.6rem; padding: 0.2rem; border: 1px solid var(--border); border-radius: 999px; background: var(--surface); }
    .review-mode-btn { border: none; border-radius: 999px; background: transparent; color: var(--text-muted); font-size: 0.72rem; font-weight: 600; padding: 0.3rem 0.6rem; cursor: pointer; }
    .review-mode-btn:hover { color: var(--text-main); background: var(--surface-muted); }
    .review-mode-btn.is-active { background: #dbeafe; color: #1e3a8a; }
    .review-mode-note { margin: 0.4rem 0 0; font-size: 0.72rem; color: var(--text-muted); }
    .anchor-context { font-size: 0.82rem; color: var(--text-muted); margin: 0.5rem 0 0.75rem; }
    .general-btn { border: 1px solid var(--border); background: var(--surface-muted); border-radius: 6px; font-size: 0.78rem; padding: 0.25rem 0.55rem; cursor: pointer; color: var(--text-main); }
    .comments-list { display: flex; flex-direction: column; gap: 0.75rem; margin-top: 0.5rem; }
    .comment-item { border-bottom: 1px solid var(--border); padding-bottom: 0.75rem; }
    .comment-item:last-child { border-bottom: none; }
    .comment-meta { font-size: 0.75rem; color: var(--text-muted); }
    .comment-author { font-weight: 600; color: var(--text-main); margin-right: 0.5rem; }
    .comment-body { margin: 0.3rem 0 0; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; font-size: 0.88rem; }
    .comment-error { display: none; color: #dc2626; font-size: 0.8rem; }
    .comments-empty { color: var(--text-muted); font-size: 0.85rem; }
    /* Inline comment box */
    #inline-comment-box { display: none; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 1rem; margin: 0.75rem 0; box-shadow: var(--panel-shadow); }
    #inline-comment-box .inline-form { display: flex; flex-direction: column; gap: 0.55rem; }
    #inline-comment-box input, #inline-comment-box textarea { width: 100%; box-sizing: border-box; padding: 0.55rem 0.65rem; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: inherit; font-family: inherit; font-size: 16px; }
    #inline-comment-box textarea { min-height: 80px; resize: vertical; }
    #inline-comment-box .inline-btn-row { display: flex; gap: 0.5rem; align-items: center; }
    #inline-comment-box .btn-post { background: #111827; color: #fff; border: none; border-radius: 6px; padding: 0.45rem 0.9rem; cursor: pointer; }
    #inline-comment-box .btn-cancel { background: transparent; color: var(--text-muted); border: 1px solid var(--border); border-radius: 6px; padding: 0.45rem 0.9rem; cursor: pointer; }
    #inline-comment-box .inline-error { display: none; color: #dc2626; font-size: 0.8rem; margin-top: 0.25rem; }
    #inline-comment-box .comment-auth-hint { font-size: 0.72rem; color: var(--text-muted); margin-top: 0.1rem; }
    #inline-comment-box .comment-login-cta { display: none; align-items: center; justify-content: space-between; gap: 0.45rem; border: 1px dashed var(--border); border-radius: 7px; background: var(--surface-muted); padding: 0.45rem 0.55rem; font-size: 0.74rem; color: var(--text-muted); }
    #inline-comment-box .comment-login-cta button { border: 1px solid var(--border); border-radius: 999px; background: var(--surface); color: var(--text-main); padding: 0.25rem 0.65rem; font-size: 0.72rem; font-weight: 600; cursor: pointer; }
    /* Sidebar grouped comments */
    .comment-group { margin-bottom: 1rem; }
    .comment-group-header { display: flex; align-items: center; gap: 0.4rem; padding: 0.4rem 0.5rem; background: transparent; border-radius: 6px; cursor: pointer; font-size: 0.82rem; color: var(--text-main); font-weight: 500; border: none; width: 100%; text-align: left; }
    .comment-group-header:hover { background: var(--surface-muted); }
    .comment-group-header .group-count { font-size: 0.7rem; color: var(--text-muted); margin-left: auto; white-space: nowrap; }
    .comment-group-comments { padding-left: 0.5rem; margin-top: 0.35rem; }
    .sidebar-comment { border-bottom: 1px solid var(--border); padding: 0.4rem 0; font-size: 0.82rem; }
    .sidebar-comment:last-child { border-bottom: none; }
    .sidebar-comment .sc-author { font-weight: 600; color: var(--text-main); }
    .sidebar-comment .sc-auth-badge { margin-left: 0.35rem; color: #1d4ed8; border: 1px solid #bfdbfe; background: #eff6ff; border-radius: 999px; padding: 0.02rem 0.35rem; font-size: 0.62rem; font-weight: 600; vertical-align: middle; }
    .sidebar-comment .sc-time { color: #949ba7; font-size: 0.72rem; margin-left: 0.3rem; }
    .sidebar-comment .sc-version { color: #949ba7; font-size: 0.68rem; margin-left: 0.3rem; border: 1px solid var(--border); border-radius: 999px; padding: 0.02rem 0.32rem; }
    .sidebar-comment .sc-body { margin: 0.15rem 0 0; color: #4f5663; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }
    .sidebar-comment-old { background: rgba(245, 158, 11, 0.08); border-radius: 6px; padding: 0.45rem 0.5rem; }
    .sidebar-comment .sc-note { margin: 0.2rem 0 0; color: #92400e; font-size: 0.7rem; }
    .sidebar-comment .sc-context-link { margin-left: 0.45rem; font-size: 0.68rem; color: #2563eb; text-decoration: none; }
    .sidebar-comment .sc-context-link:hover { text-decoration: underline; }
    .sidebar-empty { color: var(--text-muted); font-size: 0.85rem; padding: 1rem 0; }
    @keyframes flash-highlight { 0% { background: rgba(59,130,246,0.3); } 100% { background: transparent; } }
    .flash-highlight { animation: flash-highlight 1.2s ease-out; }
    .comment-badge { position: absolute; top: -6px; right: -6px; min-width: 18px; height: 18px; line-height: 18px; text-align: center; font-size: 0.7rem; font-weight: 600; color: #fff; background: #3b82f6; border-radius: 9px; padding: 0 5px; box-sizing: border-box; cursor: pointer; z-index: 2; user-select: none; box-shadow: 0 1px 3px rgba(0,0,0,0.15); }
    .doc-toolbar { position: fixed; left: 0.8rem; right: 0.8rem; bottom: 0.8rem; z-index: 35; width: calc(100vw - 1.6rem); max-width: 31rem; display: flex; flex-direction: column; align-items: flex-start; gap: 0.32rem; }
    .doc-toolbar-menu { position: relative; display: flex; flex-direction: column; align-items: flex-start; width: auto; max-width: 100%; align-self: flex-start; }
    .doc-toolbar-menu > summary { list-style: none; }
    .doc-toolbar-menu > summary::-webkit-details-marker { display: none; }
    .doc-toolbar-toggle { display: inline-flex; align-items: center; justify-content: center; gap: 0.3rem; font-weight: 600; user-select: none; min-height: 2.5rem; padding: 0.3rem 0.78rem; border-radius: 11px; line-height: 1.2; transition: transform 0.2s ease, border-color 0.2s ease, background 0.2s ease; }
    .doc-toolbar-toggle::after { content: '▾'; font-size: 0.68rem; line-height: 1; }
    .doc-toolbar-menu[open] .doc-toolbar-toggle::after { content: '▴'; }
    .doc-toolbar-menu[open] .doc-toolbar-toggle { transform: translateY(-0.18rem); border-color: #bfdbfe; background: #eff6ff; border-top-left-radius: 0; border-top-right-radius: 0; }
    .doc-toolbar-actions-panel { position: absolute; left: 0; bottom: calc(100% - 0.2rem); display: flex; flex-wrap: wrap; align-items: flex-start; gap: 0.42rem; width: min(calc(100vw - 1.6rem), 31rem); max-width: calc(100vw - 1.6rem); box-sizing: border-box; padding: 0.86rem 0.58rem 0.58rem; border: 1px solid var(--border); border-radius: 12px; border-bottom-left-radius: 0; background: rgba(253,252,249,0.98); box-shadow: var(--panel-shadow); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); opacity: 0; visibility: hidden; pointer-events: none; transform: translateY(0.32rem) scale(0.98); transform-origin: bottom left; transition: opacity 0.2s ease, transform 0.2s ease, visibility 0s linear 0.2s; }
    .doc-toolbar-menu[open] .doc-toolbar-actions-panel { opacity: 1; visibility: visible; pointer-events: auto; transform: translateY(0) scale(1); transition-delay: 0s; }
    .doc-toolbar-actions-panel > * { min-width: 0; flex: 0 0 auto; }
    .doc-toolbar-panel-close { position: absolute; top: 0.32rem; right: 0.32rem; width: 1.5rem; height: 1.5rem; display: inline-flex; align-items: center; justify-content: center; border: 1px solid transparent; border-radius: 8px; background: transparent; color: var(--text-muted); font-size: 1.06rem; line-height: 1; cursor: pointer; }
    .doc-toolbar-panel-close:hover { border-color: var(--border); background: var(--surface-muted); color: var(--text-main); }
    .doc-toolbar-item { display: inline-flex; align-items: center; justify-content: center; width: fit-content; max-width: 100%; box-sizing: border-box; border: 1px solid var(--border); border-radius: var(--control-radius); background: rgba(253,252,249,0.95); padding: 0.52rem 0.96rem; font-size: 0.75rem; color: var(--text-main); text-decoration: none; cursor: pointer; text-align: center; white-space: nowrap; line-height: 1.25; flex: 0 0 auto; }
    button.doc-toolbar-item { font-family: inherit; }
    .doc-toolbar-meta { display: inline-flex; align-items: center; justify-content: flex-start; align-self: flex-start; width: fit-content; max-width: 100%; gap: 0.55rem; border: 1px solid var(--border); border-radius: var(--control-radius); background: rgba(253,252,249,0.95); padding: 0.34rem 0.78rem; }
    .doc-toolbar-brand { display: inline-flex; align-items: center; gap: 0.18rem; color: var(--text-muted); font-size: 0.75rem; line-height: 1.25; min-width: 0; white-space: normal; overflow-wrap: anywhere; }
    .doc-toolbar-brand a { color: inherit; font-weight: 700; text-decoration: none; }
    .doc-toolbar-brand a:hover { text-decoration: underline; }
    .doc-toolbar-auth-floating { position: fixed; right: 0.8rem; bottom: 0.8rem; z-index: 45; pointer-events: auto; isolation: isolate; }
    .doc-toolbar-auth-shell { min-height: 0; display: flex; align-items: center; justify-content: flex-end; flex: 0 0 auto; pointer-events: auto; }
    .doc-toolbar-auth-shell .auth-shell-inner,
    .doc-toolbar-auth-shell .auth-shell-inner-read-link,
    .doc-toolbar-auth-shell .auth-shell-inner-read-link-signed-in { gap: 0; }
    .doc-toolbar-auth-shell .auth-menu { position: relative; z-index: 2; }
    .doc-toolbar-auth-shell .auth-menu-trigger { padding: 0.16rem; border-radius: var(--control-radius); min-width: 0; position: relative; z-index: 2; pointer-events: auto; }
    .doc-toolbar-auth-shell .auth-menu-dropdown { top: auto; bottom: calc(100% + 0.35rem); right: 0; max-width: min(17rem, calc(100vw - 1.2rem)); z-index: 80; pointer-events: auto; }
    .doc-toolbar-auth-shell .auth-user-chip,
    .doc-toolbar-auth-shell .auth-menu-caret { display: none; }
    .doc-toolbar-auth-shell .auth-link-button { padding: 0.26rem 0.65rem; font-size: 0.72rem; border-radius: var(--control-radius); }
    .doc-toolbar-version { border-color: #bfdbfe; background: #eff6ff; color: #1e3a8a; font-weight: 700; }
    .doc-toolbar-feature { border-color: #a78bfa; color: #7c3aed; }
    /* Onboarding tip */
    @keyframes fadeUp { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes fadeOut { from { opacity: 1; transform: translateY(0); } to { opacity: 0; transform: translateY(12px); } }
    .onboarding-tip { position: fixed; bottom: 5.2rem; left: 50%; transform: translateX(-50%); z-index: 50; background: rgba(253,252,249,0.92); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border: 1px solid var(--border); border-radius: 10px; padding: 0.55rem 1rem; font-size: 0.82rem; color: #3f4652; box-shadow: var(--tooltip-shadow); display: flex; align-items: center; gap: 0.75rem; animation: fadeUp 0.4s ease-out; white-space: nowrap; }
    .onboarding-tip.hiding { animation: fadeOut 0.35s ease-in forwards; }
    .onboarding-tip .tip-dismiss { background: none; border: none; color: #9ca3af; cursor: pointer; font-size: 1rem; padding: 0 0.15rem; line-height: 1; }
    .onboarding-tip .tip-dismiss:hover { color: #6b7280; }
    @media (max-width: 640px) { .onboarding-tip { left: 1rem; right: 1rem; transform: none; white-space: normal; } }
    @media (max-width: 980px) {
      .viewer-header-inner { padding: 0.7rem 1rem; }
      .viewer-header-actions .preview-save-status { display: none; }
      .layout { grid-template-columns: 1fr; padding: 1rem 1rem 8.2rem; gap: 1rem; }
      .doc-content { max-width: 100%; padding: 1.3rem 0.15rem 1.8rem; }
      .side-panel { position: static; max-height: none; border-left: none; border-top: 1px solid var(--border); padding: 0.9rem 0 0; }
      .anchor-dot { left: -10px; }
    }
    @media (min-width: 981px) {
      .doc-toolbar { left: 1rem; right: auto; width: min(31rem, calc(100vw - 2rem)); max-width: none; }
      .doc-toolbar-actions-panel { width: min(31rem, calc(100vw - 2rem)); max-width: calc(100vw - 2rem); }
      .doc-toolbar-auth-floating { right: 1rem; }
      .onboarding-tip { bottom: 4.2rem; }
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --page-bg: #13151a;
        --text-main: #e8ebf0;
        --text-muted: #a1a8b6;
        --surface: #1b1e25;
        --surface-muted: #242833;
        --border: #353a47;
        --header-bg: rgba(19, 21, 26, 0.92);
        --panel-shadow: 0 4px 14px rgba(0,0,0,0.35);
        --tooltip-shadow: 0 2px 10px rgba(0,0,0,0.3);
        --table-bg: #1a1e26;
        --table-header-bg: #232a38;
        --table-header-text: #edf1f8;
        --table-border: #3a4252;
        --table-row-alt: rgba(148, 163, 184, 0.06);
        --table-row-hover: rgba(96, 165, 250, 0.16);
        --table-shadow: 0 1px 2px rgba(0,0,0,0.34);
      }
      html, body { background: var(--page-bg); color: var(--text-main); }
      .viewer-header { border-color: var(--border); background: var(--header-bg); }
      .viewer-brand { color: #f2f4f8; }
      .viewer-brand:hover { color: #93c5fd; }
      .preview-save-btn { border-color: var(--border); background: var(--surface); color: var(--text-main); }
      .preview-save-btn:hover { border-color: #60a5fa; background: #222732; }
      .preview-save-btn[data-state="saved"] { border-color: #fbbf24; color: #fde68a; background: rgba(217, 119, 6, 0.2); }
      .preview-save-btn[data-state="created"] { border-color: #22c55e; color: #bbf7d0; background: rgba(22, 163, 74, 0.2); }
      .preview-save-status button { color: #93c5fd; }
      .auth-link-button { border-color: var(--border); background: var(--surface); color: var(--text-main); }
      .auth-link-button:hover { border-color: #60a5fa; background: #222732; }
      .auth-link-button-secondary { color: var(--text-muted); }
      .auth-menu-trigger { border-color: #1e40af; background: rgba(30, 64, 175, 0.25); color: #bfdbfe; }
      .auth-menu-trigger:hover { border-color: #2563eb; background: rgba(37, 99, 235, 0.32); }
      .auth-menu-caret { color: #93c5fd; }
      .auth-menu-dropdown { background: #151923; border-color: var(--border); }
      .auth-menu-item { color: var(--text-main); }
      .auth-menu-item:hover { background: #262d3a; }
      .auth-avatar { border-color: #1d4ed8; background: #1e3a8a; color: #dbeafe; }
      .auth-user-chip { border-color: #1e40af; background: rgba(30, 64, 175, 0.25); color: #bfdbfe; }
      .doc-version-badge { border-color: #1d4ed8; background: rgba(30,64,175,0.28); color: #bfdbfe; }
      .auth-secondary-link { color: #93c5fd; }
      .auth-status { color: var(--text-muted); }
      .doc-content { background: transparent; border: none; }
      .side-panel { background: transparent; border-color: var(--border); }
      .doc-content :is(p,li,blockquote) { color: #cfd4de; }
      .doc-content :is(h1,h2,h3,h4,h5,h6) { color: #edf1f8; }
      .doc-content :is(h1,h2,h3,h4,h5,h6,p,li,blockquote,pre)[id]:hover { background: rgba(96,165,250,0.15); }
      .doc-content .anchor-selected { background: rgba(96,165,250,0.22); }
      .general-btn,.doc-toolbar-item { background: #191d26; border-color: var(--border); color: var(--text-main); }
      .review-mode-controls { background: #191d26; border-color: var(--border); }
      .review-mode-btn { color: #a1a8b6; }
      .review-mode-btn:hover { color: #e8ebf0; background: #2b303c; }
      .review-mode-btn.is-active { background: rgba(30,64,175,0.32); color: #bfdbfe; }
      .review-mode-note { color: #a1a8b6; }
      .doc-toolbar-menu[open] .doc-toolbar-toggle { border-color: #1d4ed8; background: rgba(30,64,175,0.3); color: #bfdbfe; }
      .doc-toolbar-meta { background: #191d26; border-color: var(--border); }
      .doc-toolbar-actions-panel { background: rgba(21,25,35,0.96); border-color: var(--border); }
      .doc-toolbar-panel-close:hover { background: #262d3a; border-color: var(--border); }
      .doc-toolbar-brand { color: #a1a8b6; }
      .doc-toolbar-brand a { color: #dbe2ef; }
      .doc-toolbar-version { border-color: #1d4ed8; background: rgba(30,64,175,0.28); color: #bfdbfe; }
      .doc-toolbar-feature { border-color: #7c3aed; color: #a78bfa; }
      .comment-author { color: #f2f4f8; }
      #inline-comment-box { background: var(--surface); border-color: var(--border); }
      #inline-comment-box input, #inline-comment-box textarea { background: #181c24; border-color: var(--border); color: var(--text-main); }
      #inline-comment-box .btn-post { background: #f9fafb; color: #111827; }
      #inline-comment-box .btn-cancel { background: transparent; color: var(--text-muted); border-color: var(--border); }
      #inline-comment-box .comment-auth-hint { color: var(--text-muted); }
      #inline-comment-box .comment-login-cta { border-color: var(--border); background: #1a1f2a; }
      #inline-comment-box .comment-login-cta button { border-color: var(--border); background: #202634; color: var(--text-main); }
      .comment-badge { background: #60a5fa; box-shadow: 0 1px 3px rgba(0,0,0,0.3); }
      .comment-group-header { background: var(--surface-muted); color: var(--text-main); }
      .comment-group-header:hover { background: #2b303c; }
      .sidebar-comment { border-color: var(--border); }
      .sidebar-comment .sc-author { color: #f2f4f8; }
      .sidebar-comment .sc-auth-badge { color: #93c5fd; border-color: #1d4ed8; background: rgba(30,64,175,0.28); }
      .sidebar-comment .sc-version { color: var(--text-muted); border-color: var(--border); }
      .sidebar-comment .sc-body { color: #b4bbc8; }
      .sidebar-comment-old { background: rgba(251, 191, 36, 0.14); }
      .sidebar-comment .sc-note { color: #fbbf24; }
      .sidebar-comment .sc-context-link { color: #93c5fd; }
      @keyframes flash-highlight { 0% { background: rgba(96,165,250,0.35); } 100% { background: transparent; } }
      .onboarding-tip { background: rgba(27,30,37,0.92); border-color: var(--border); color: #cfd4de; box-shadow: var(--tooltip-shadow); }
      .onboarding-tip .tip-dismiss { color: #7f8795; }
      .onboarding-tip .tip-dismiss:hover { color: #a1a8b6; }
    }
    @media (prefers-reduced-motion: reduce) {
      .doc-toolbar-toggle,
      .doc-toolbar-actions-panel { transition: none; }
      .doc-toolbar-menu[open] .doc-toolbar-toggle { transform: none; }
      .doc-toolbar-actions-panel,
      .doc-toolbar-menu[open] .doc-toolbar-actions-panel { transform: none; }
    }
  </style>
</head>
<body>
  <header class="viewer-header">
    <div class="viewer-header-inner">
      <a href="/" class="viewer-brand">plsreadme</a>
      <div class="viewer-header-actions">
        <button type="button" class="preview-save-btn" id="preview-save-btn" data-state="idle">☆ Save to My Links</button>
        <span class="preview-save-status" id="preview-save-status" aria-live="polite"></span>
      </div>
    </div>
  </header>
  <div class="layout">
    <article class="doc-content" id="doc-content">${responsiveHtml}
      <div id="inline-comment-box">
        <div class="inline-form">
          <div class="comment-login-cta" id="comment-login-cta" style="display:none">
            <span>Sign in for account-linked comments. Guest comments still work.</span>
            <button type="button" id="comment-login-btn">Sign in</button>
          </div>
          <input type="text" id="comment-name" placeholder="Your name" required maxlength="50" />
          <div class="comment-auth-hint" id="comment-auth-hint" style="display:none"></div>
          <textarea id="comment-body" placeholder="Write a comment…" required maxlength="2000"></textarea>
          <div class="inline-error" id="comment-error"></div>
          <div class="inline-btn-row">
            <button type="button" class="btn-post" id="inline-post-btn">Post</button>
            <button type="button" class="btn-cancel" id="inline-cancel-btn">Cancel</button>
          </div>
        </div>
      </div>
    </article>
    <aside class="side-panel">
      <div class="panel-header">
        <h2 class="panel-title">Comments (<span id="comment-count">0</span>)</h2>
        <button id="general-btn" class="general-btn" type="button">General</button>
      </div>
      <div class="review-mode-controls" role="group" aria-label="Comment review mode">
        <button id="review-mode-current" class="review-mode-btn" type="button">Current draft</button>
        <button id="review-mode-timeline" class="review-mode-btn" type="button">Timeline</button>
      </div>
      <p id="review-mode-note" class="review-mode-note" aria-live="polite"></p>
      <div id="sidebar-groups"></div>
    </aside>
  </div>
  <div class="onboarding-tip" id="onboarding-tip" style="display:none"><span>\u{1F4AC} Click any paragraph to leave a comment</span><button class="tip-dismiss" id="tip-dismiss" aria-label="Dismiss">\u00D7</button></div>
  <div class="doc-toolbar" aria-label="Document actions toolbar">
    <details class="doc-toolbar-menu" id="doc-toolbar-menu" open>
      <summary class="doc-toolbar-item doc-toolbar-toggle" id="doc-toolbar-toggle" aria-haspopup="menu" aria-controls="doc-toolbar-actions-panel" aria-expanded="true">Actions</summary>
      <div class="doc-toolbar-actions-panel" id="doc-toolbar-actions-panel" aria-label="Document actions">
        <button type="button" class="doc-toolbar-panel-close" id="doc-toolbar-close" aria-label="Close actions panel">\u00D7</button>
        <a href="/v/${docId}/history" class="doc-toolbar-item doc-toolbar-version">Current v${docVersion}</a>
        <button type="button" class="doc-toolbar-item" id="toolbar-copy-link">Copy link</button>
        <a href="/v/${docId}/raw" class="doc-toolbar-item">Raw</a>
        <a href="https://github.com/FacundoLucci/plsreadme/issues/new?labels=feature-request&title=Feature+request:+&body=Describe+the+feature+you%27d+like+to+see" target="_blank" rel="noopener" class="doc-toolbar-item doc-toolbar-feature">\u{1F4A1} Feature Request</a>
      </div>
    </details>
    <div class="doc-toolbar-meta">
      <span class="doc-toolbar-brand">Made readable with <a href="/">plsreadme</a></span>
    </div>
  </div>
  <div class="doc-toolbar-auth-floating">
    <div class="viewer-auth-shell doc-toolbar-auth-shell" data-auth-root data-auth-variant="read-link"></div>
  </div>
  <script src="/clerk-auth-shell.js" defer></script>
  <script>
    function copyLink() {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        return navigator.clipboard.writeText(window.location.href);
      }

      return Promise.resolve();
    }

    (function() {
      var toolbarMenu = document.getElementById('doc-toolbar-menu');
      var toolbarToggle = document.getElementById('doc-toolbar-toggle');
      var toolbarCopyLinkBtn = document.getElementById('toolbar-copy-link');
      var toolbarCloseBtn = document.getElementById('doc-toolbar-close');
      var toolbarActionLinks = document.querySelectorAll('.doc-toolbar-actions-panel a');

      function syncToolbarAriaExpanded() {
        if (!toolbarMenu || !toolbarToggle) return;
        toolbarToggle.setAttribute('aria-expanded', toolbarMenu.open ? 'true' : 'false');
      }

      function closeToolbarMenu() {
        if (toolbarMenu && toolbarMenu.open) {
          toolbarMenu.open = false;
        }
      }

      if (toolbarMenu) {
        syncToolbarAriaExpanded();
        toolbarMenu.addEventListener('toggle', syncToolbarAriaExpanded);
      }

      if (toolbarCopyLinkBtn) {
        toolbarCopyLinkBtn.addEventListener('click', function() {
          copyLink();
          closeToolbarMenu();
        });
      }

      if (toolbarCloseBtn) {
        toolbarCloseBtn.addEventListener('click', function() {
          closeToolbarMenu();
          if (toolbarToggle && typeof toolbarToggle.focus === 'function') {
            toolbarToggle.focus();
          }
        });
      }

      toolbarActionLinks.forEach(function(linkEl) {
        linkEl.addEventListener('click', closeToolbarMenu);
      });

      document.addEventListener('click', function(event) {
        if (!toolbarMenu || !toolbarMenu.open) return;
        var target = event.target;
        if (target instanceof Node && !toolbarMenu.contains(target)) {
          closeToolbarMenu();
        }
      });

      document.addEventListener('keydown', function(event) {
        if (event.key === 'Escape' && toolbarMenu && toolbarMenu.open) {
          closeToolbarMenu();
          if (toolbarToggle && typeof toolbarToggle.focus === 'function') {
            toolbarToggle.focus();
          }
        }
      });

      var DOC_ID = '${docId}';
      var CURRENT_DOC_VERSION = ${docVersion};
      var currentDocVersion = CURRENT_DOC_VERSION;
      var HAS_MULTIPLE_VERSIONS = CURRENT_DOC_VERSION > 1;
      var REVIEW_MODE_CURRENT = 'current';
      var REVIEW_MODE_TIMELINE = 'timeline';
      var DOC_ROOT = 'doc-root';
      var selectedAnchor = DOC_ROOT;
      var selectedEl = null;
      var selectedDot = null;
      var allComments = [];
      var activeReviewMode = resolveInitialReviewMode();
      var latestCommentsRequestId = 0;
      var contentEl = document.getElementById('doc-content');
      var countEl = document.getElementById('comment-count');
      var nameInput = document.getElementById('comment-name');
      var authHintEl = document.getElementById('comment-auth-hint');
      var loginCtaEl = document.getElementById('comment-login-cta');
      var loginBtn = document.getElementById('comment-login-btn');
      var bodyInput = document.getElementById('comment-body');
      var errorEl = document.getElementById('comment-error');
      var saveBtn = document.getElementById('preview-save-btn');
      var saveStatusEl = document.getElementById('preview-save-status');
      var generalBtn = document.getElementById('general-btn');
      var reviewModeCurrentBtn = document.getElementById('review-mode-current');
      var reviewModeTimelineBtn = document.getElementById('review-mode-timeline');
      var reviewModeNoteEl = document.getElementById('review-mode-note');
      var sidebarGroupsEl = document.getElementById('sidebar-groups');
      var inlineBox = document.getElementById('inline-comment-box');
      var postBtn = document.getElementById('inline-post-btn');
      var cancelBtn = document.getElementById('inline-cancel-btn');
      var authState = (window && window.plsreadmeAuthState) || { authenticated: false };
      var saveState = { loading: false, saved: false, createdByUser: false };

      var saved = localStorage.getItem('plsreadme_author_name');
      if (saved) nameInput.value = saved;
      nameInput.addEventListener('input', function() {
        if (!authState || !authState.authenticated) {
          localStorage.setItem('plsreadme_author_name', this.value.trim());
        }
      });

      function relativeTime(dateStr) {
        var diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
        if (diff < 60) return 'just now';
        if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
        if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
        return Math.floor(diff / 86400) + 'd ago';
      }

      function displayNameFromAuth(state) {
        if (!state || !state.authenticated) return '';
        return (state.displayName || state.email || state.userId || 'Signed-in user') + '';
      }

      function normalizeReviewMode(value) {
        if (value === REVIEW_MODE_CURRENT) return REVIEW_MODE_CURRENT;
        if (value === REVIEW_MODE_TIMELINE || value === 'all') return REVIEW_MODE_TIMELINE;
        return null;
      }

      function defaultReviewMode() {
        return HAS_MULTIPLE_VERSIONS ? REVIEW_MODE_CURRENT : REVIEW_MODE_TIMELINE;
      }

      function resolveInitialReviewMode() {
        var queryMode = null;
        try {
          var params = new URLSearchParams(window.location.search || '');
          queryMode = normalizeReviewMode(params.get('view'));
        } catch (e) {
          queryMode = null;
        }

        return queryMode || defaultReviewMode();
      }

      function commentVersion(c) {
        var v = Number(c && c.doc_version);
        return Number.isFinite(v) && v > 0 ? v : 1;
      }

      function apiViewFromReviewMode(mode) {
        return mode === REVIEW_MODE_CURRENT ? 'current' : 'all';
      }

      function isCommentVisibleInActiveMode(comment) {
        if (activeReviewMode !== REVIEW_MODE_CURRENT) return true;
        return commentVersion(comment) === currentDocVersion;
      }

      function updateReviewModeUrl(mode) {
        try {
          var nextUrl = new URL(window.location.href);
          nextUrl.searchParams.set('view', mode);
          window.history.replaceState({}, '', nextUrl.pathname + nextUrl.search + nextUrl.hash);
        } catch (e) {}
      }

      function updateReviewModeControls() {
        if (reviewModeCurrentBtn) {
          reviewModeCurrentBtn.classList.toggle('is-active', activeReviewMode === REVIEW_MODE_CURRENT);
          reviewModeCurrentBtn.setAttribute('aria-pressed', activeReviewMode === REVIEW_MODE_CURRENT ? 'true' : 'false');
        }

        if (reviewModeTimelineBtn) {
          reviewModeTimelineBtn.classList.toggle('is-active', activeReviewMode === REVIEW_MODE_TIMELINE);
          reviewModeTimelineBtn.setAttribute('aria-pressed', activeReviewMode === REVIEW_MODE_TIMELINE ? 'true' : 'false');
        }

        if (reviewModeNoteEl) {
          if (activeReviewMode === REVIEW_MODE_CURRENT) {
            reviewModeNoteEl.textContent = 'Showing comments on current draft only.';
          } else {
            reviewModeNoteEl.textContent = 'Showing full comment timeline across versions.';
          }
        }
      }

      function setReviewMode(mode, options) {
        var normalized = normalizeReviewMode(mode) || defaultReviewMode();
        var opts = options || {};
        var changed = normalized !== activeReviewMode;
        activeReviewMode = normalized;

        updateReviewModeControls();

        if (opts.syncUrl !== false) {
          updateReviewModeUrl(activeReviewMode);
        }

        if (changed || opts.forceReload) {
          return loadComments();
        }

        return Promise.resolve();
      }

      function triggerSignInFlow() {
        var signInBtn = document.querySelector("[data-auth-action='sign-in']");
        if (signInBtn && typeof signInBtn.click === 'function') {
          signInBtn.click();
          return;
        }

        try {
          window.location.href = '/sign-in?redirect_url=' + encodeURIComponent(window.location.href);
        } catch (e) {
          window.location.href = '/sign-in';
        }
      }

      function setSaveStatus(message, canSignIn) {
        if (!saveStatusEl) return;
        if (!message) {
          saveStatusEl.textContent = '';
          return;
        }

        if (canSignIn) {
          saveStatusEl.innerHTML = 'Sign in to save this link. <button type="button" id="save-login-btn">Sign in</button>';
          var loginActionBtn = document.getElementById('save-login-btn');
          if (loginActionBtn) {
            loginActionBtn.addEventListener('click', triggerSignInFlow);
          }
          return;
        }

        saveStatusEl.textContent = message;
      }

      function renderSaveButton() {
        if (!saveBtn) return;

        if (saveState.loading) {
          saveBtn.disabled = true;
          saveBtn.textContent = 'Saving…';
          saveBtn.setAttribute('data-state', 'loading');
          return;
        }

        if (!authState || !authState.authenticated) {
          saveBtn.disabled = false;
          saveBtn.textContent = '☆ Save to My Links';
          saveBtn.setAttribute('data-state', 'signed-out');
          return;
        }

        if (saveState.createdByUser) {
          saveBtn.disabled = true;
          saveBtn.textContent = '✓ Created by you';
          saveBtn.setAttribute('data-state', 'created');
          return;
        }

        if (saveState.saved) {
          saveBtn.disabled = true;
          saveBtn.textContent = '★ Saved';
          saveBtn.setAttribute('data-state', 'saved');
          return;
        }

        saveBtn.disabled = false;
        saveBtn.textContent = '☆ Save to My Links';
        saveBtn.setAttribute('data-state', 'ready');
      }

      async function getAuthToken() {
        try {
          if (typeof window.plsreadmeGetAuthToken === 'function') {
            var token = await window.plsreadmeGetAuthToken();
            return typeof token === 'string' && token ? token : null;
          }
        } catch (e) {}
        return null;
      }

      async function refreshSaveState() {
        if (!authState || !authState.authenticated) {
          saveState = { loading: false, saved: false, createdByUser: false };
          renderSaveButton();
          return;
        }

        var token = await getAuthToken();
        if (!token) {
          saveState = { loading: false, saved: false, createdByUser: false };
          renderSaveButton();
          return;
        }

        try {
          var response = await fetch('/api/auth/save-link/' + DOC_ID, {
            method: 'GET',
            headers: {
              Accept: 'application/json',
              Authorization: 'Bearer ' + token
            }
          });

          if (!response.ok) {
            saveState = { loading: false, saved: false, createdByUser: false };
            renderSaveButton();
            return;
          }

          var data = await response.json();
          saveState = {
            loading: false,
            saved: !!data.saved,
            createdByUser: !!data.createdByUser
          };
          renderSaveButton();
        } catch (e) {
          saveState = { loading: false, saved: false, createdByUser: false };
          renderSaveButton();
        }
      }

      async function saveCurrentDoc() {
        if (!authState || !authState.authenticated) {
          setSaveStatus('Sign in to save this link.', true);
          return;
        }

        if (saveState.saved || saveState.createdByUser) {
          renderSaveButton();
          return;
        }

        var token = await getAuthToken();
        if (!token) {
          setSaveStatus('Sign in to save this link.', true);
          return;
        }

        saveState.loading = true;
        renderSaveButton();
        setSaveStatus('Saving…');

        try {
          var response = await fetch('/api/auth/save-link', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: 'Bearer ' + token
            },
            body: JSON.stringify({ id: DOC_ID })
          });

          var data = await response.json().catch(function() { return {}; });

          if (response.status === 401) {
            saveState = { loading: false, saved: false, createdByUser: false };
            renderSaveButton();
            setSaveStatus('Sign in to save this link.', true);
            return;
          }

          if (!response.ok) {
            throw new Error(data.error || 'Could not save link.');
          }

          saveState = {
            loading: false,
            saved: !!data.saved,
            createdByUser: !!data.createdByUser
          };
          renderSaveButton();
          if (saveState.createdByUser) {
            setSaveStatus('This link is already in your Created links section.');
          } else {
            setSaveStatus('Saved to My Links.');
          }
        } catch (err) {
          saveState = { loading: false, saved: false, createdByUser: false };
          renderSaveButton();
          setSaveStatus(err && err.message ? err.message : 'Could not save link.');
        }
      }

      function applyAuthState(nextState) {
        authState = nextState || { authenticated: false };

        if (authState.authenticated) {
          var identityLabel = displayNameFromAuth(authState);
          nameInput.value = identityLabel;
          nameInput.disabled = true;
          nameInput.required = false;
          nameInput.placeholder = 'Signed in';
          if (authHintEl) {
            authHintEl.style.display = 'block';
            authHintEl.textContent = 'Commenting as ' + identityLabel;
          }
          if (loginCtaEl) {
            loginCtaEl.style.display = 'none';
          }
          setSaveStatus('');
          void refreshSaveState();
          return;
        }

        nameInput.disabled = false;
        nameInput.required = true;
        nameInput.placeholder = 'Your name';
        if (saved) {
          nameInput.value = saved;
        }
        if (authHintEl) {
          authHintEl.style.display = 'none';
          authHintEl.textContent = '';
        }
        if (loginCtaEl) {
          loginCtaEl.style.display = 'flex';
        }
        saveState = { loading: false, saved: false, createdByUser: false };
        setSaveStatus('');
        renderSaveButton();
      }

      function resolveCommentAuthor(comment) {
        if (!comment) return 'Anonymous';
        if (typeof comment.author_display_name === 'string' && comment.author_display_name.trim()) {
          return comment.author_display_name.trim();
        }
        if (typeof comment.author_name === 'string' && comment.author_name.trim()) {
          return comment.author_name.trim();
        }
        if (typeof comment.author_email === 'string' && comment.author_email.trim()) {
          return comment.author_email.trim();
        }
        return 'Anonymous';
      }

      function scrollToAnchor(anchorId) {
        var el = anchorId === DOC_ROOT ? contentEl : document.getElementById(anchorId);
        if (!el) return;
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('flash-highlight');
        setTimeout(function() { el.classList.remove('flash-highlight'); }, 1200);
      }

      function renderSidebar() {
        sidebarGroupsEl.innerHTML = '';
        countEl.textContent = allComments.length;
        if (!allComments.length) {
          var emptyMessage = activeReviewMode === REVIEW_MODE_CURRENT
            ? 'No comments on the current draft yet.'
            : 'No comments yet.';
          sidebarGroupsEl.innerHTML = '<p class="sidebar-empty">' + emptyMessage + '</p>';
          return;
        }

        // Group by anchor_id, with orphan fallback to General
        var groups = {};
        var order = [];
        allComments.forEach(function(c) {
          var originalAid = c.anchor_id || DOC_ROOT;
          var hasAnchor = originalAid === DOC_ROOT || !!document.getElementById(originalAid);
          var isOrphan = originalAid !== DOC_ROOT && !hasAnchor;
          var aid = isOrphan ? DOC_ROOT : originalAid;
          if (!groups[aid]) { groups[aid] = []; order.push(aid); }
          groups[aid].push({
            comment: c,
            isOlder: commentVersion(c) < currentDocVersion,
            isOrphan: isOrphan,
            originalAnchor: originalAid,
            version: commentVersion(c)
          });
        });

        // Put General first
        order.sort(function(a, b) { return a === DOC_ROOT ? -1 : b === DOC_ROOT ? 1 : 0; });

        order.forEach(function(aid) {
          var entries = groups[aid];
          var section = document.createElement('div');
          section.className = 'comment-group';
          var header = document.createElement('button');
          header.className = 'comment-group-header';
          var label = 'General';
          if (aid !== DOC_ROOT) {
            var targetEl = document.getElementById(aid);
            label = targetEl ? (targetEl.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60) : aid;
          }
          var hasOlderInGroup = entries.some(function(e) { return e.isOlder; });
          var groupLabel = hasOlderInGroup ? (label + ' (from earlier version)') : label;
          header.innerHTML = '<span>' + groupLabel.replace(/</g, '&lt;') + '</span><span class="group-count">' + entries.length + '</span>';
          header.addEventListener('click', function() { scrollToAnchor(aid); });
          section.appendChild(header);

          var list = document.createElement('div');
          list.className = 'comment-group-comments';
          entries.forEach(function(entry) {
            var c = entry.comment;
            var item = document.createElement('div');
            item.className = 'sidebar-comment' + (entry.isOlder ? ' sidebar-comment-old' : '');
            item.innerHTML = '<div><span class="sc-author"></span><span class="sc-auth-badge" style="display:none">Signed in</span><span class="sc-time"></span><span class="sc-version" style="display:none"></span><a class="sc-context-link" style="display:none" target="_blank" rel="noopener">view original context</a></div><p class="sc-body"></p><p class="sc-note" style="display:none"></p>';
            item.querySelector('.sc-author').textContent = resolveCommentAuthor(c);
            if (c.author_user_id) {
              item.querySelector('.sc-auth-badge').style.display = 'inline-block';
            }
            item.querySelector('.sc-time').textContent = relativeTime(c.created_at);
            if (entry.isOlder) {
              var versionEl = item.querySelector('.sc-version');
              versionEl.style.display = 'inline-block';
              versionEl.textContent = 'v' + entry.version;

              var contextLinkEl = item.querySelector('.sc-context-link');
              contextLinkEl.style.display = 'inline';
              contextLinkEl.href = '/v/' + DOC_ID + '/raw?version=' + entry.version;
            }
            item.querySelector('.sc-body').textContent = c.body;
            if (entry.isOrphan) {
              var noteEl = item.querySelector('.sc-note');
              noteEl.style.display = 'block';
              noteEl.textContent = 'original paragraph was edited';
            }
            list.appendChild(item);
          });
          section.appendChild(list);
          sidebarGroupsEl.appendChild(section);
        });
      }

      function renderComments() { renderSidebar(); }

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

      function showInlineBox(el) {
        el.insertAdjacentElement('afterend', inlineBox);
        inlineBox.style.display = 'block';
        bodyInput.focus();
        // Scroll into view on mobile
        setTimeout(function() { inlineBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, 100);
      }

      function hideInlineBox() {
        inlineBox.style.display = 'none';
        errorEl.style.display = 'none';
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
        showInlineBox(el);
      }

      contentEl.addEventListener('click', function(e) {
        // Ignore clicks inside the inline comment box
        if (e.target.closest && e.target.closest('#inline-comment-box')) return;
        var target = e.target && e.target.closest ? e.target.closest('h1,h2,h3,h4,h5,h6,p,li,blockquote,pre') : null;
        if (!target || !target.id || !contentEl.contains(target)) return;
        selectAnchor(target);
      });

      generalBtn.addEventListener('click', function() {
        selectGeneral();
        hideInlineBox();
      });

      if (reviewModeCurrentBtn) {
        reviewModeCurrentBtn.addEventListener('click', function() {
          void setReviewMode(REVIEW_MODE_CURRENT);
        });
      }

      if (reviewModeTimelineBtn) {
        reviewModeTimelineBtn.addEventListener('click', function() {
          void setReviewMode(REVIEW_MODE_TIMELINE);
        });
      }

      cancelBtn.addEventListener('click', function() {
        hideInlineBox();
        clearSelection();
        selectedAnchor = DOC_ROOT;
        renderComments();
      });

      document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && inlineBox.style.display !== 'none') {
          hideInlineBox();
          clearSelection();
          selectedAnchor = DOC_ROOT;
          renderComments();
        }
      });

      var isMobile = window.innerWidth <= 980;

      function renderBadges() {
        // Remove existing badges
        contentEl.querySelectorAll('.comment-badge').forEach(function(b) { b.remove(); });
        // Group by anchor_id
        var counts = {};
        allComments.forEach(function(c) {
          var aid = c.anchor_id || DOC_ROOT;
          if (aid === DOC_ROOT) return;
          counts[aid] = (counts[aid] || 0) + 1;
        });
        Object.keys(counts).forEach(function(aid) {
          var el = document.getElementById(aid);
          if (!el || !contentEl.contains(el)) return;
          var badge = document.createElement('span');
          badge.className = 'comment-badge';
          badge.textContent = counts[aid];
          badge.setAttribute('data-anchor', aid);
          badge.addEventListener('click', function(e) {
            e.stopPropagation();
            if (isMobile) {
              selectAnchor(el);
            } else {
              selectAnchor(el);
              var panel = document.querySelector('.side-panel');
              if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
          });
          el.appendChild(badge);
        });
      }

      function loadComments() {
        var requestId = ++latestCommentsRequestId;
        var apiView = apiViewFromReviewMode(activeReviewMode);

        return fetch('/api/comments/' + DOC_ID + '?view=' + encodeURIComponent(apiView))
          .then(function(r) { return r.json(); })
          .then(function(data) {
            if (requestId !== latestCommentsRequestId) return;
            var comments = data && Array.isArray(data.comments) ? data.comments : [];
            var metaVersion = Number(data && data.meta && data.meta.current_doc_version);
            if (Number.isFinite(metaVersion) && metaVersion > 0) {
              currentDocVersion = metaVersion;
            }
            allComments = comments;
            renderComments();
            renderBadges();
          })
          .catch(function() {});
      }

      async function postComment() {
        errorEl.style.display = 'none';
        var name = nameInput.value.trim();
        var body = bodyInput.value.trim();
        var isSignedIn = !!(authState && authState.authenticated);

        if ((!isSignedIn && !name) || !body) {
          errorEl.textContent = isSignedIn ? 'Comment body is required.' : 'Name and comment are required.';
          errorEl.style.display = 'block';
          return;
        }

        postBtn.disabled = true;

        var token = await getAuthToken();
        var headers = { 'Content-Type': 'application/json' };
        if (token) {
          headers.Authorization = 'Bearer ' + token;
        }

        var payload = {
          author_name: name,
          author_display_name: isSignedIn ? displayNameFromAuth(authState) : null,
          body: body,
          anchor_id: selectedAnchor
        };

        fetch('/api/comments/' + DOC_ID, {
          method: 'POST',
          headers: headers,
          body: JSON.stringify(payload)
        })
          .then(function(r) {
            if (!r.ok) return r.json().then(function(d) { throw new Error(d.error || 'Failed'); });
            return r.json();
          })
          .then(function(data) {
            var nextComment = data && data.comment;
            if (nextComment && isCommentVisibleInActiveMode(nextComment)) {
              allComments.push(nextComment);
              renderComments();
              renderBadges();
            }
            bodyInput.value = '';
            if (!isSignedIn) {
              localStorage.setItem('plsreadme_author_name', name);
            }
            return loadComments();
          })
          .catch(function(err) {
            errorEl.textContent = err.message;
            errorEl.style.display = 'block';
          })
          .finally(function() { postBtn.disabled = false; });
      }

      postBtn.addEventListener('click', function() { void postComment(); });
      bodyInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void postComment();
      });

      if (loginBtn) {
        loginBtn.addEventListener('click', triggerSignInFlow);
      }

      if (saveBtn) {
        saveBtn.addEventListener('click', function() {
          void saveCurrentDoc();
        });
      }

      applyAuthState(authState);
      window.addEventListener('plsreadme:auth-state', function(event) {
        applyAuthState((event && event.detail) || { authenticated: false });
      });

      updateReviewModeControls();
      void setReviewMode(activeReviewMode, { forceReload: true });

      // Onboarding tip
      (function() {
        if (localStorage.getItem('plsreadme_tip_dismissed')) return;
        var tip = document.getElementById('onboarding-tip');
        if (!tip) return;
        tip.style.display = 'flex';
        function hideTip() {
          if (tip.classList.contains('hiding')) return;
          tip.classList.add('hiding');
          setTimeout(function() { tip.style.display = 'none'; }, 350);
          localStorage.setItem('plsreadme_tip_dismissed', '1');
        }
        document.getElementById('tip-dismiss').addEventListener('click', hideTip);
        setTimeout(hideTip, 8000);
      })();
    })();
  </script>
</body>
</html>`;
}

// POST /api/render - Create a new document
app.post("/", async (c) => {
  const endpoint = "/api/render";
  const clientIp = getClientIp(c.req);
  const ipHash = await sha256(clientIp);
  const contentLength = parseContentLength(c.req.header("content-length"));

  try {
    const contentLengthFailure = validateContentLength(contentLength);
    if (contentLengthFailure) {
      await logAbuseAttempt(c.env, {
        endpoint,
        ipHash,
        reason: contentLengthFailure.reason,
        contentLength,
      });
      return c.json(failureToErrorPayload(contentLengthFailure), contentLengthFailure.status);
    }

    const requestAuth = await getRequestAuth(c);
    const rateLimitActorKey = await resolveRateLimitActorKey({
      ipHash,
      userId: requestAuth.isAuthenticated ? requestAuth.userId : null,
    });

    const rateLimit = await checkAndConsumeRateLimit(
      c.env,
      rateLimitActorKey,
      WRITE_RATE_LIMITS.renderCreate
    );
    if (!rateLimit.allowed) {
      await logAbuseAttempt(c.env, {
        endpoint,
        ipHash,
        reason: "rate_limit_exceeded",
        contentLength,
      });

      return c.json(
        {
          error: `Rate limit exceeded. Maximum ${rateLimit.maxRequests} requests per hour.`,
          reason: "rate_limit_exceeded",
          limit: rateLimit.maxRequests,
          actual: rateLimit.count,
          retry_after_seconds: rateLimit.retryAfterSeconds ?? 3600,
        },
        429
      );
    }

    const contentType = c.req.header("content-type") || "";
    let markdown = "";

    // Parse input - either JSON or multipart form data
    if (contentType.includes("application/json")) {
      const body = await c.req
        .json<{ markdown?: unknown }>()
        .catch(() => null);

      if (!body || typeof body.markdown !== "string") {
        return c.json(
          { error: "Invalid JSON body. Expected { markdown: string }" },
          400
        );
      }

      markdown = body.markdown;
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

    const { metrics, failure } = validateMarkdown(markdown);
    if (failure) {
      await logAbuseAttempt(c.env, {
        endpoint,
        ipHash,
        reason: failure.reason,
        contentLength,
        payloadBytes: metrics.payloadBytes,
        totalChars: metrics.totalChars,
        maxLineChars: metrics.maxLineChars,
      });

      return c.json(failureToErrorPayload(failure), failure.status);
    }

    // Generate ID, admin token, and hash
    const id = nanoid(12);
    const adminToken = `sk_${nanoid(24)}`;
    const hash = await sha256(markdown);
    const r2Key = `md/${id}.md`;
    const title = extractTitle(markdown);
    const now = new Date().toISOString();

    await ensureOwnershipSchema(c.env);
    const ownerUserId = requestAuth.isAuthenticated ? requestAuth.userId : null;

    let isFirstSavedLink = false;
    if (ownerUserId) {
      const existingCount = await c.env.DB.prepare(
        "SELECT COUNT(*) as count FROM docs WHERE owner_user_id = ?"
      )
        .bind(ownerUserId)
        .first<{ count: number | string | null }>();
      isFirstSavedLink = (Number(existingCount?.count ?? 0) || 0) === 0;
    }

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
      "INSERT INTO docs (id, r2_key, content_type, bytes, created_at, sha256, title, admin_token, owner_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(
        id,
        r2Key,
        "text/markdown",
        metrics.payloadBytes,
        now,
        hash,
        title,
        adminToken,
        ownerUserId
      )
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
        bytes: metrics.payloadBytes,
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
        doubles: [metrics.payloadBytes],
        indexes: [clientIp],
      });

      if (ownerUserId && isFirstSavedLink) {
        await c.env.ANALYTICS.writeDataPoint({
          blobs: ["first_saved_link", ownerUserId, id],
          doubles: [Date.now()],
          indexes: [ownerUserId.slice(0, 32)],
        });
      }
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
      admin_token: adminToken,
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

// GET /v/:id/versions - Version timeline metadata
app.get("/:id/versions", async (c) => {
  try {
    const id = c.req.param("id");

    const doc = await c.env.DB.prepare("SELECT * FROM docs WHERE id = ?")
      .bind(id)
      .first<DocRecord>();

    if (!doc) {
      return c.json({ error: "Document not found" }, 404);
    }

    const baseUrl = new URL(c.req.url).origin;
    const versions = buildDocVersionHistory(baseUrl, doc);

    return c.json({
      id: doc.id,
      title: doc.title,
      created_at: doc.created_at,
      current_version: resolveDocVersion(doc),
      total_versions: versions.length,
      versions,
    });
  } catch (error) {
    console.error("Error fetching document versions:", error);
    return c.json({ error: "Failed to fetch document versions" }, 500);
  }
});

// GET /v/:id/history - Human-readable version history page
app.get("/:id/history", async (c) => {
  try {
    const id = c.req.param("id");

    const doc = await c.env.DB.prepare("SELECT * FROM docs WHERE id = ?")
      .bind(id)
      .first<DocRecord>();

    if (!doc) {
      return c.html("<h1>Document not found</h1>", 404);
    }

    const baseUrl = new URL(c.req.url).origin;
    const versions = buildDocVersionHistory(baseUrl, doc);
    return c.html(generateVersionHistoryHtml(doc, versions));
  } catch (error) {
    console.error("Error rendering version history:", error);
    return c.html("<h1>Error</h1><p>Failed to load version history.</p>", 500);
  }
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
    const html = generateHtmlTemplate(doc.title, htmlContent as string, id, doc.doc_version ?? 1);
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

// GET /v/:id/raw - Get raw markdown (latest by default, archived when version=n)
app.get("/:id/raw", async (c) => {
  try {
    const id = c.req.param("id");
    const versionParam = c.req.query("version");

    // Fetch metadata from D1
    const doc = await c.env.DB.prepare("SELECT * FROM docs WHERE id = ?")
      .bind(id)
      .first<DocRecord>();

    if (!doc) {
      return c.text("Document not found", 404);
    }

    let r2Key = doc.r2_key;
    if (versionParam !== undefined) {
      const version = Number(versionParam);
      if (!Number.isInteger(version) || version < 1) {
        return c.text("Invalid version query parameter", 400);
      }
      r2Key = `md/${id}_v${version}.md`;
    }

    // Fetch content from R2
    const object = await c.env.DOCS_BUCKET.get(r2Key);
    if (!object) {
      return c.text(versionParam !== undefined ? "Document version not found" : "Document content not found", 404);
    }

    const markdown = await object.text();

    // Return raw markdown
    return c.text(markdown, 200, {
      "Content-Type": "text/markdown",
      "Content-Disposition": `attachment; filename="${doc.title || id}${versionParam ? `_v${versionParam}` : ""}.md"`,
    });
  } catch (error) {
    console.error("Error fetching raw document:", error);
    return c.text("Failed to fetch document", 500);
  }
});

function extractAdminToken(c: Context<{ Bindings: Env }>): string {
  const customToken = c.req.header("x-admin-token")?.trim();
  if (customToken) return customToken;

  const authHeader = c.req.header("authorization") || "";
  return authHeader.replace(/^Bearer\s+/i, "").trim();
}

// Helper: validate admin token
async function validateAdminToken(env: Env, docId: string, token: string): Promise<DocRecord | null> {
  if (!token) return null;
  const doc = await env.DB.prepare("SELECT * FROM docs WHERE id = ? AND admin_token = ?")
    .bind(docId, token)
    .first<DocRecord>();
  return doc || null;
}

async function enforceOwnedDocMutationAuth(
  c: Context<{ Bindings: Env }>,
  doc: DocRecord
): Promise<Response | null> {
  if (!doc.owner_user_id) {
    return null;
  }

  const requestAuth = await getRequestAuth(c);
  if (!requestAuth.isAuthenticated || !requestAuth.userId) {
    return c.json(
      {
        error: "Owned documents require an authenticated owner session.",
        code: "owner_auth_required",
      },
      401
    );
  }

  if (requestAuth.userId !== doc.owner_user_id) {
    return c.json(
      {
        error: "You are not allowed to modify a document owned by another user.",
        code: "owner_mismatch",
      },
      403
    );
  }

  return null;
}

// POST /v/:id/restore - Restore document from a previous version
app.post("/:id/restore", async (c) => {
  const id = c.req.param("id");
  const endpoint = `/api/render/${id}/restore`;
  const clientIp = getClientIp(c.req);
  const ipHash = await sha256(clientIp);
  const contentLength = parseContentLength(c.req.header("content-length"));

  try {
    const contentLengthFailure = validateContentLength(contentLength);
    if (contentLengthFailure) {
      await logAbuseAttempt(c.env, {
        endpoint,
        ipHash,
        reason: contentLengthFailure.reason,
        contentLength,
      });
      return c.json(failureToErrorPayload(contentLengthFailure), contentLengthFailure.status);
    }

    const requestAuth = await getRequestAuth(c);
    const rateLimitActorKey = await resolveRateLimitActorKey({
      ipHash,
      userId: requestAuth.isAuthenticated ? requestAuth.userId : null,
    });

    const rateLimit = await checkAndConsumeRateLimit(
      c.env,
      rateLimitActorKey,
      WRITE_RATE_LIMITS.renderRestore
    );

    if (!rateLimit.allowed) {
      await logAbuseAttempt(c.env, {
        endpoint,
        ipHash,
        reason: "rate_limit_exceeded",
        contentLength,
      });

      return c.json(
        {
          error: `Rate limit exceeded. Maximum ${rateLimit.maxRequests} restores per hour.`,
          reason: "rate_limit_exceeded",
          limit: rateLimit.maxRequests,
          actual: rateLimit.count,
          retry_after_seconds: rateLimit.retryAfterSeconds ?? 3600,
        },
        429
      );
    }

    await ensureOwnershipSchema(c.env);

    const token = extractAdminToken(c);
    if (!token) {
      return c.json({ error: "Authorization required. Pass admin_token as Bearer token." }, 401);
    }

    const doc = await validateAdminToken(c.env, id, token);
    if (!doc) {
      return c.json({ error: "Invalid admin token or document not found." }, 403);
    }

    const ownerAuthError = await enforceOwnedDocMutationAuth(c, doc);
    if (ownerAuthError) {
      return ownerAuthError;
    }

    const body = await c.req
      .json<{ version?: unknown }>()
      .catch(() => null);

    if (!body || !Number.isInteger(body.version) || Number(body.version) < 1) {
      return c.json({ error: "Invalid JSON body. Expected { version: number }" }, 400);
    }

    const requestedVersion = Number(body.version);
    const currentVersion = resolveDocVersion(doc);

    const currentObject = await c.env.DOCS_BUCKET.get(doc.r2_key);
    if (!currentObject) {
      return c.json({ error: "Document content not found in storage." }, 500);
    }
    const currentMarkdown = await currentObject.text();

    let restoredMarkdown = currentMarkdown;
    if (requestedVersion !== currentVersion) {
      const archivedObject = await c.env.DOCS_BUCKET.get(`md/${id}_v${requestedVersion}.md`);
      if (!archivedObject) {
        return c.json({ error: `Document version v${requestedVersion} not found.` }, 404);
      }
      restoredMarkdown = await archivedObject.text();
    }

    const archivedAt = new Date().toISOString();
    await c.env.DOCS_BUCKET.put(`md/${id}_v${currentVersion}.md`, currentMarkdown, {
      httpMetadata: { contentType: "text/markdown" },
      customMetadata: {
        archived_at: archivedAt,
        doc_version: String(currentVersion),
      },
    });

    const restoredHash = await sha256(restoredMarkdown);
    const restoredTitle = extractTitle(restoredMarkdown);
    const restoredBytes = new TextEncoder().encode(restoredMarkdown).length;
    const nextVersion = currentVersion + 1;

    await c.env.DOCS_BUCKET.put(doc.r2_key, restoredMarkdown, {
      httpMetadata: { contentType: "text/markdown" },
      customMetadata: {
        updated_at: archivedAt,
        sha256: restoredHash,
        restored_from_version: String(requestedVersion),
      },
    });

    await c.env.DB.prepare("UPDATE docs SET bytes = ?, sha256 = ?, title = ?, doc_version = ? WHERE id = ?")
      .bind(restoredBytes, restoredHash, restoredTitle, nextVersion, id)
      .run();

    const baseUrl = new URL(c.req.url).origin;
    return c.json({
      id,
      restored: true,
      restored_from_version: requestedVersion,
      current_version: nextVersion,
      url: `${baseUrl}/v/${id}`,
      raw_url: `${baseUrl}/v/${id}/raw`,
      versions_url: `${baseUrl}/v/${id}/versions`,
      history_url: `${baseUrl}/v/${id}/history`,
    });
  } catch (error) {
    console.error("Error restoring document version:", error);
    return c.json({ error: "Failed to restore document version" }, 500);
  }
});

// PUT /v/:id - Update document content
app.put("/:id", async (c) => {
  const id = c.req.param("id");
  const endpoint = `/api/render/${id}`;
  const clientIp = getClientIp(c.req);
  const ipHash = await sha256(clientIp);
  const contentLength = parseContentLength(c.req.header("content-length"));

  try {
    const contentLengthFailure = validateContentLength(contentLength);
    if (contentLengthFailure) {
      await logAbuseAttempt(c.env, {
        endpoint,
        ipHash,
        reason: contentLengthFailure.reason,
        contentLength,
      });
      return c.json(failureToErrorPayload(contentLengthFailure), contentLengthFailure.status);
    }

    const requestAuth = await getRequestAuth(c);
    const rateLimitActorKey = await resolveRateLimitActorKey({
      ipHash,
      userId: requestAuth.isAuthenticated ? requestAuth.userId : null,
    });

    const rateLimit = await checkAndConsumeRateLimit(
      c.env,
      rateLimitActorKey,
      WRITE_RATE_LIMITS.renderUpdate
    );
    if (!rateLimit.allowed) {
      await logAbuseAttempt(c.env, {
        endpoint,
        ipHash,
        reason: "rate_limit_exceeded",
        contentLength,
      });

      return c.json(
        {
          error: `Rate limit exceeded. Maximum ${rateLimit.maxRequests} updates per hour.`,
          reason: "rate_limit_exceeded",
          limit: rateLimit.maxRequests,
          actual: rateLimit.count,
          retry_after_seconds: rateLimit.retryAfterSeconds ?? 3600,
        },
        429
      );
    }

    await ensureOwnershipSchema(c.env);

    const token = extractAdminToken(c);
    if (!token) {
      return c.json({ error: "Authorization required. Pass admin_token as Bearer token." }, 401);
    }

    const doc = await validateAdminToken(c.env, id, token);
    if (!doc) {
      return c.json({ error: "Invalid admin token or document not found." }, 403);
    }

    const ownerAuthError = await enforceOwnedDocMutationAuth(c, doc);
    if (ownerAuthError) {
      return ownerAuthError;
    }

    const body = await c.req
      .json<{ markdown?: unknown }>()
      .catch(() => null);

    if (!body || typeof body.markdown !== "string") {
      return c.json({ error: "Invalid JSON body. Expected { markdown: string }" }, 400);
    }

    const markdown = body.markdown;
    const { metrics, failure } = validateMarkdown(markdown);

    if (failure) {
      await logAbuseAttempt(c.env, {
        endpoint,
        ipHash,
        reason: failure.reason,
        contentLength,
        payloadBytes: metrics.payloadBytes,
        totalChars: metrics.totalChars,
        maxLineChars: metrics.maxLineChars,
      });
      return c.json(failureToErrorPayload(failure), failure.status);
    }

    const hash = await sha256(markdown);
    const title = extractTitle(markdown);
    const oldVersion = doc.doc_version ?? 1;

    // Preserve previous markdown before overwrite
    const currentObject = await c.env.DOCS_BUCKET.get(doc.r2_key);
    if (!currentObject) {
      return c.json({ error: "Document content not found in storage." }, 500);
    }
    const previousMarkdown = await currentObject.text();
    await c.env.DOCS_BUCKET.put(`md/${id}_v${oldVersion}.md`, previousMarkdown, {
      httpMetadata: { contentType: "text/markdown" },
      customMetadata: { archived_at: new Date().toISOString(), doc_version: String(oldVersion) },
    });

    // Update latest markdown in R2
    await c.env.DOCS_BUCKET.put(doc.r2_key, markdown, {
      httpMetadata: { contentType: "text/markdown" },
      customMetadata: { updated_at: new Date().toISOString(), sha256: hash },
    });

    const ownerAssignmentUserId =
      !doc.owner_user_id && requestAuth.isAuthenticated ? requestAuth.userId : null;

    // Update D1 metadata + increment doc version
    await c.env.DB.prepare(
      "UPDATE docs SET bytes = ?, sha256 = ?, title = ?, doc_version = ?, owner_user_id = COALESCE(owner_user_id, ?) WHERE id = ?"
    )
      .bind(metrics.payloadBytes, hash, title, oldVersion + 1, ownerAssignmentUserId, id)
      .run();

    const baseUrl = new URL(c.req.url).origin;
    return c.json({
      id,
      url: `${baseUrl}/v/${id}`,
      raw_url: `${baseUrl}/v/${id}/raw`,
      updated: true,
    });
  } catch (error) {
    console.error("Error updating document:", error);
    return c.json({ error: "Failed to update document" }, 500);
  }
});

// DELETE /v/:id - Delete document
app.delete("/:id", async (c) => {
  try {
    const id = c.req.param("id");

    await ensureOwnershipSchema(c.env);

    const token = extractAdminToken(c);
    if (!token) {
      return c.json({ error: "Authorization required. Pass admin_token as Bearer token." }, 401);
    }

    const doc = await validateAdminToken(c.env, id, token);
    if (!doc) {
      return c.json({ error: "Invalid admin token or document not found." }, 403);
    }

    const ownerAuthError = await enforceOwnedDocMutationAuth(c, doc);
    if (ownerAuthError) {
      return ownerAuthError;
    }

    // Delete from R2
    await c.env.DOCS_BUCKET.delete(doc.r2_key);

    // Delete comments
    await c.env.DB.prepare("DELETE FROM comments WHERE doc_id = ?").bind(id).run();

    // Delete from D1
    await c.env.DB.prepare("DELETE FROM docs WHERE id = ?").bind(id).run();

    return c.json({ id, deleted: true });
  } catch (error) {
    console.error("Error deleting document:", error);
    return c.json({ error: "Failed to delete document" }, 500);
  }
});

export { app as docsRoutes };
