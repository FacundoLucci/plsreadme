import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { generateHtmlTemplate } from "../worker/routes/docs.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function loadAuthShellScript(): Promise<string> {
  return readFile(path.join(__dirname, "../public/clerk-auth-shell.js"), "utf8");
}

test("preview/read html template wires auth shell in read-link variant", () => {
  const html = generateHtmlTemplate("Preview", "<p>Hello</p>", "doc_preview", 1);

  assert.match(html, /data-auth-root\s+data-auth-variant="read-link"/);
  assert.match(html, /<script src="\/clerk-auth-shell\.js" defer><\/script>/);
});

test("signed-out read-link auth UI exposes a single Sign in CTA", async () => {
  const script = await loadAuthShellScript();
  const fnBlock = script.match(/function renderSignedOut\(variant\) \{([\s\S]*?)\n  \}\n\n  function renderSignedIn/);
  assert.ok(fnBlock, "could not locate renderSignedOut function");

  const readLinkBranch = fnBlock[1].match(/if \(variant === "read-link"\) \{\s*return `([\s\S]*?)`;\s*\}/);
  assert.ok(readLinkBranch, "could not locate read-link signed-out branch");

  const template = readLinkBranch[1];
  assert.equal((template.match(/data-auth-action=/g) || []).length, 1);
  assert.match(template, /data-auth-action="sign-in"/);
  assert.match(template, />Sign in</);
  assert.doesNotMatch(template, /sign-up|email-fallback/);
});

test("signed-in read-link auth UI uses dropdown with dashboard + logout actions", async () => {
  const script = await loadAuthShellScript();
  const fnBlock = script.match(/function renderSignedIn\(variant, displayName, avatarUrl, email\) \{([\s\S]*?)\n  \}\n\n  async function boot/);
  assert.ok(fnBlock, "could not locate renderSignedIn function");

  const readLinkBranch = fnBlock[1].match(/return `([\s\S]*?)`;/);
  assert.ok(readLinkBranch, "could not locate signed-in template");

  const template = readLinkBranch[1];
  assert.match(template, /class="auth-menu"/);
  assert.match(template, /data-auth-action="toggle-menu"/);
  assert.match(template, /class="auth-avatar"/);
  assert.match(template, /class="auth-user-chip"/);
  assert.match(template, /href="\/my-links" class="auth-menu-item"[^>]*>My dashboard</);
  assert.match(template, /data-auth-action="sign-out"[^>]*>Logout</);
});

test("preview template keeps save action inside Actions panel and preserves logged-out comment CTA", () => {
  const html = generateHtmlTemplate("Preview", "<p>Hello</p>", "doc_preview", 1);

  assert.match(html, /id="doc-toolbar-actions-panel"[\s\S]*id="preview-save-btn"[\s\S]*Save to My Links/);
  assert.doesNotMatch(html, /class="viewer-header-actions"/);
  assert.match(html, /id="preview-save-status"/);
  assert.match(html, /id="comment-login-cta"/);
  assert.match(html, /Sign in for account-linked comments/);
  assert.match(html, /<div class="doc-toolbar-meta">\s*<span class="doc-toolbar-brand">Made readable with <a href="\/">plsreadme<\/a><\/span>\s*<\/div>/);
  assert.match(html, /<div class="doc-toolbar-auth-floating">\s*<div class="viewer-auth-shell doc-toolbar-auth-shell" data-auth-root data-auth-variant="read-link"><\/div>\s*<\/div>/);
  assert.match(html, /doc-toolbar-toggle \{[^}]*min-height: 2\.5rem;[^}]*padding: 0\.3rem 0\.78rem;/);
  assert.match(html, /doc-toolbar-menu\[open\] \.doc-toolbar-toggle \{[^}]*border-color: #bfdbfe;[^}]*background: #eff6ff;[^}]*border-top-left-radius: 0;[^}]*border-top-right-radius: 0;/);
  assert.match(html, /doc-toolbar-actions-panel \{[^}]*bottom: calc\(100% - 1px\);[^}]*border-bottom-left-radius: 0;/);
  assert.match(html, /doc-toolbar-auth-floating \{[^}]*z-index: 45;[^}]*pointer-events: auto;/);
  assert.match(html, /doc-toolbar-auth-shell \.auth-menu-dropdown \{[^}]*z-index: 80;[^}]*pointer-events: auto;/);
  assert.match(html, /\/api\/auth\/save-link/);
});

test("auth dropdown close handler preserves keyboard accessibility", async () => {
  const script = await loadAuthShellScript();

  assert.match(script, /function closeAllAuthMenus\(options\)/);
  assert.match(script, /const shouldFocusTrigger = !!\(options && options\.focusTrigger\);/);
  assert.match(script, /if \(event\.key === "Escape"\) \{\s*closeAllAuthMenus\(\{ focusTrigger: true \}\);\s*\}/);
});

test("auth redirects preserve returnBackUrl from preview actions", async () => {
  const script = await loadAuthShellScript();

  assert.match(script, /redirectToSignIn\(\{\s*returnBackUrl: window\.location\.href,/);
  assert.match(script, /redirectToSignUp\(\{\s*returnBackUrl: window\.location\.href,/);
  assert.match(script, /searchParams\.set\("redirect_url", returnTo\)/);
});
