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
export function generateHtmlTemplate(
  title: string | null,
  htmlContent: string,
  docId: string,
  docVersion: number
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
    }
    html, body { margin: 0; padding: 0; background: var(--page-bg); }
    body { font-family: 'Instrument Sans', sans-serif; color: var(--text-main); }
    .viewer-header { position: sticky; top: 0; z-index: 30; border-bottom: 1px solid var(--border); background: var(--header-bg); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); }
    .viewer-header-inner { max-width: 1240px; margin: 0 auto; padding: 0.75rem 1.5rem; display: flex; align-items: center; justify-content: space-between; gap: 0.85rem; }
    .viewer-brand { display: inline-flex; align-items: center; gap: 0.45rem; color: var(--text-main); text-decoration: none; font-weight: 700; font-size: 0.96rem; }
    .viewer-brand:hover { color: #2563eb; }
    .viewer-auth-shell { min-height: 34px; display: flex; align-items: center; }
    .auth-shell-inner { display: flex; align-items: center; gap: 0.45rem; }
    .auth-link-button { border: 1px solid var(--border); border-radius: 999px; background: var(--surface); color: var(--text-main); padding: 0.38rem 0.78rem; font-size: 0.75rem; font-weight: 600; cursor: pointer; }
    .auth-link-button:hover { border-color: #93c5fd; background: #eff6ff; }
    .auth-link-button-secondary { background: transparent; color: var(--text-muted); }
    .auth-avatar { width: 1.5rem; height: 1.5rem; border-radius: 999px; overflow: hidden; display: inline-flex; align-items: center; justify-content: center; border: 1px solid #bfdbfe; background: #dbeafe; color: #1e3a8a; flex: 0 0 auto; }
    .auth-avatar-img { width: 100%; height: 100%; object-fit: cover; }
    .auth-avatar-fallback { font-size: 0.72rem; font-weight: 700; }
    .auth-user-chip { display: inline-flex; align-items: center; padding: 0.28rem 0.56rem; border-radius: 999px; border: 1px solid #dbeafe; background: #eff6ff; color: #1e3a8a; font-size: 0.72rem; max-width: 180px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .auth-secondary-link { color: #2563eb; text-decoration: none; font-size: 0.75rem; font-weight: 600; }
    .auth-secondary-link:hover { text-decoration: underline; }
    .auth-status { color: var(--text-muted); font-size: 0.75rem; }
    .layout { max-width: 1240px; margin: 0 auto; padding: 1.5rem; display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 1rem; }
    .doc-content { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 2.2rem; line-height: 1.7; min-width: 0; overflow-wrap: anywhere; }
    .doc-content :is(h1,h2,h3,h4,h5,h6,p,li,blockquote,td,th) { overflow-wrap: anywhere; word-break: break-word; }
    .doc-content pre { max-width: 100%; overflow-x: auto; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }
    .doc-content pre code { white-space: inherit; word-break: inherit; }
    .doc-content code { overflow-wrap: anywhere; word-break: break-word; }
    .doc-content :is(h1,h2,h3,h4,h5,h6,p,li,blockquote,pre)[id] { position: relative; cursor: pointer; }
    .doc-content :is(h1,h2,h3,h4,h5,h6,p,li,blockquote,pre)[id]:hover { background: rgba(59,130,246,0.08); }
    .doc-content .anchor-selected { background: rgba(59,130,246,0.16); border-radius: 6px; }
    .anchor-dot { position: absolute; left: -14px; top: 0.7em; width: 8px; height: 8px; border-radius: 50%; background: #2563eb; }
    .side-panel { position: sticky; top: 1rem; align-self: start; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 1rem; max-height: calc(100vh - 2rem); overflow: auto; }
    .panel-header { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
    .panel-title { margin: 0; font-size: 1rem; }
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
    #inline-comment-box input, #inline-comment-box textarea { width: 100%; box-sizing: border-box; padding: 0.55rem 0.65rem; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: inherit; font-family: inherit; }
    #inline-comment-box textarea { min-height: 80px; resize: vertical; }
    #inline-comment-box .inline-btn-row { display: flex; gap: 0.5rem; align-items: center; }
    #inline-comment-box .btn-post { background: #111827; color: #fff; border: none; border-radius: 6px; padding: 0.45rem 0.9rem; cursor: pointer; }
    #inline-comment-box .btn-cancel { background: transparent; color: var(--text-muted); border: 1px solid var(--border); border-radius: 6px; padding: 0.45rem 0.9rem; cursor: pointer; }
    #inline-comment-box .inline-error { display: none; color: #dc2626; font-size: 0.8rem; margin-top: 0.25rem; }
    #inline-comment-box .comment-auth-hint { font-size: 0.72rem; color: var(--text-muted); margin-top: 0.1rem; }
    /* Sidebar grouped comments */
    .comment-group { margin-bottom: 1rem; }
    .comment-group-header { display: flex; align-items: center; gap: 0.4rem; padding: 0.45rem 0.6rem; background: var(--surface-muted); border-radius: 6px; cursor: pointer; font-size: 0.82rem; color: var(--text-main); font-weight: 500; border: none; width: 100%; text-align: left; }
    .comment-group-header:hover { background: #ebe8e1; }
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
    .doc-toolbar { position: fixed; left: 1rem; bottom: 1rem; display: flex; gap: 0.5rem; }
    .doc-toolbar-item { border: 1px solid var(--border); border-radius: 6px; background: rgba(253,252,249,0.95); padding: 0.45rem 0.7rem; font-size: 0.75rem; color: var(--text-main); text-decoration: none; cursor: pointer; }
    .doc-toolbar-feature { border-color: #a78bfa; color: #7c3aed; }
    /* Onboarding tip */
    @keyframes fadeUp { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes fadeOut { from { opacity: 1; transform: translateY(0); } to { opacity: 0; transform: translateY(12px); } }
    .onboarding-tip { position: fixed; bottom: 3.5rem; left: 50%; transform: translateX(-50%); z-index: 50; background: rgba(253,252,249,0.92); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border: 1px solid var(--border); border-radius: 10px; padding: 0.55rem 1rem; font-size: 0.82rem; color: #3f4652; box-shadow: var(--tooltip-shadow); display: flex; align-items: center; gap: 0.75rem; animation: fadeUp 0.4s ease-out; white-space: nowrap; }
    .onboarding-tip.hiding { animation: fadeOut 0.35s ease-in forwards; }
    .onboarding-tip .tip-dismiss { background: none; border: none; color: #9ca3af; cursor: pointer; font-size: 1rem; padding: 0 0.15rem; line-height: 1; }
    .onboarding-tip .tip-dismiss:hover { color: #6b7280; }
    @media (max-width: 640px) { .onboarding-tip { left: 1rem; right: 1rem; transform: none; white-space: normal; } }
    @media (max-width: 980px) { .viewer-header-inner { flex-wrap: wrap; padding: 0.7rem 1rem; } .layout { grid-template-columns: 1fr; } .side-panel { position: static; max-height: none; } .anchor-dot { left: -10px; } }
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
      }
      html, body { background: var(--page-bg); color: var(--text-main); }
      .viewer-header { border-color: var(--border); background: var(--header-bg); }
      .viewer-brand { color: #f2f4f8; }
      .viewer-brand:hover { color: #93c5fd; }
      .auth-link-button { border-color: var(--border); background: var(--surface); color: var(--text-main); }
      .auth-link-button:hover { border-color: #60a5fa; background: #222732; }
      .auth-link-button-secondary { color: var(--text-muted); }
      .auth-avatar { border-color: #1d4ed8; background: #1e3a8a; color: #dbeafe; }
      .auth-user-chip { border-color: #1e40af; background: rgba(30, 64, 175, 0.25); color: #bfdbfe; }
      .auth-secondary-link { color: #93c5fd; }
      .auth-status { color: var(--text-muted); }
      .doc-content,.side-panel { background: var(--surface); border-color: var(--border); }
      .doc-content :is(p,li,blockquote) { color: #cfd4de; }
      .doc-content :is(h1,h2,h3,h4,h5,h6) { color: #edf1f8; }
      .doc-content :is(h1,h2,h3,h4,h5,h6,p,li,blockquote,pre)[id]:hover { background: rgba(96,165,250,0.15); }
      .doc-content .anchor-selected { background: rgba(96,165,250,0.22); }
      .general-btn,.doc-toolbar-item { background: #191d26; border-color: var(--border); color: var(--text-main); }
      .doc-toolbar-feature { border-color: #7c3aed; color: #a78bfa; }
      .comment-author { color: #f2f4f8; }
      #inline-comment-box { background: var(--surface); border-color: var(--border); }
      #inline-comment-box input, #inline-comment-box textarea { background: #181c24; border-color: var(--border); color: var(--text-main); }
      #inline-comment-box .btn-post { background: #f9fafb; color: #111827; }
      #inline-comment-box .btn-cancel { background: transparent; color: var(--text-muted); border-color: var(--border); }
      #inline-comment-box .comment-auth-hint { color: var(--text-muted); }
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
  </style>
</head>
<body>
  <header class="viewer-header">
    <div class="viewer-header-inner">
      <a href="/" class="viewer-brand">plsreadme</a>
      <div class="viewer-auth-shell" data-auth-root data-auth-variant="read-link"></div>
    </div>
  </header>
  <div class="layout">
    <article class="doc-content" id="doc-content">${sanitizedHtml}
      <div id="inline-comment-box">
        <div class="inline-form">
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
      <div id="sidebar-groups"></div>
    </aside>
  </div>
  <div class="onboarding-tip" id="onboarding-tip" style="display:none"><span>\u{1F4AC} Click any paragraph to leave a comment</span><button class="tip-dismiss" id="tip-dismiss" aria-label="Dismiss">\u00D7</button></div>
  <div class="doc-toolbar">
    <span class="doc-toolbar-item">Made readable with <a href="/">plsreadme</a></span>
    <button class="doc-toolbar-item" onclick="copyLink()">Copy link</button>
    <a href="/v/${docId}/raw" class="doc-toolbar-item">Raw</a>
    <a href="https://github.com/FacundoLucci/plsreadme/issues/new?labels=feature-request&title=Feature+request:+&body=Describe+the+feature+you%27d+like+to+see" target="_blank" rel="noopener" class="doc-toolbar-item doc-toolbar-feature">\u{1F4A1} Feature Request</a>
  </div>
  <script src="/clerk-auth-shell.js" defer></script>
  <script>
    function copyLink() { navigator.clipboard.writeText(window.location.href); }
    (function() {
      var DOC_ID = '${docId}';
      var CURRENT_DOC_VERSION = ${docVersion};
      var DOC_ROOT = 'doc-root';
      var selectedAnchor = DOC_ROOT;
      var selectedEl = null;
      var selectedDot = null;
      var allComments = [];
      var contentEl = document.getElementById('doc-content');
      var countEl = document.getElementById('comment-count');
      var nameInput = document.getElementById('comment-name');
      var authHintEl = document.getElementById('comment-auth-hint');
      var bodyInput = document.getElementById('comment-body');
      var errorEl = document.getElementById('comment-error');
      var generalBtn = document.getElementById('general-btn');
      var sidebarGroupsEl = document.getElementById('sidebar-groups');
      var inlineBox = document.getElementById('inline-comment-box');
      var postBtn = document.getElementById('inline-post-btn');
      var cancelBtn = document.getElementById('inline-cancel-btn');
      var authState = (window && window.plsreadmeAuthState) || { authenticated: false };

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
          sidebarGroupsEl.innerHTML = '<p class="sidebar-empty">No comments yet.</p>';
          return;
        }

        function commentVersion(c) {
          var v = Number(c && c.doc_version);
          return Number.isFinite(v) && v > 0 ? v : 1;
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
            isOlder: commentVersion(c) < CURRENT_DOC_VERSION,
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
        fetch('/api/comments/' + DOC_ID)
          .then(function(r) { return r.json(); })
          .then(function(data) { allComments = data.comments || []; renderComments(); renderBadges(); })
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
            allComments.push(data.comment);
            bodyInput.value = '';
            if (!isSignedIn) {
              localStorage.setItem('plsreadme_author_name', name);
            }
            renderComments();
            renderBadges();
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

      applyAuthState(authState);
      window.addEventListener('plsreadme:auth-state', function(event) {
        applyAuthState((event && event.detail) || { authenticated: false });
      });

      loadComments();

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
