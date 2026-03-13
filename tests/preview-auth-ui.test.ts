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
  assert.match(template, /auth-link-button-icon/);
  assert.match(template, /authIcon\("signIn"\)/);
  assert.match(template, />\s*<span>Sign in<\/span>\s*</);
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
  assert.match(template, /class="auth-menu-caret"[\s\S]*authIcon\("chevronDown"\)/);
  assert.match(template, /href="\/my-links" class="auth-menu-item"[\s\S]*authIcon\("dashboard"\)[\s\S]*My dashboard/);
  assert.match(template, /data-auth-action="sign-out"[\s\S]*authIcon\("signOut"\)[\s\S]*Logout/);
});

test("preview template keeps save action in header and updated toolbar interactions", () => {
  const html = generateHtmlTemplate("Preview", "<p>Hello</p>", "doc_preview", 1);

  assert.match(html, /class="viewer-header-actions"[\s\S]*id="preview-save-btn"[\s\S]*Save to My Links/);
  assert.match(html, /class="viewer-header-actions"[\s\S]*id="preview-save-status"/);
  assert.doesNotMatch(html, /id="doc-toolbar-actions-panel"[\s\S]*id="preview-save-btn"/);
  assert.doesNotMatch(html, /<details class="doc-toolbar-menu"/);
  assert.match(html, /id="doc-toolbar-toggle"[^>]*aria-expanded="false"[\s\S]*Current v1/);
  assert.match(html, /id="doc-toolbar-actions-panel"[\s\S]*id="doc-toolbar-close"[\s\S]*doc-toolbar-history[\s\S]*History[\s\S]*id="toolbar-copy-link"[\s\S]*Copy link[\s\S]*Raw markdown/);
  assert.match(html, /doc-toolbar-action-entry" id="toolbar-copy-link" style="--cascade-up: 2; --cascade-down: 1;/);
  assert.match(html, /id="comment-login-cta"/);
  assert.match(html, /Sign in for account-linked comments/);
  assert.match(html, /<div class="doc-toolbar-meta">\s*<span class="doc-toolbar-brand">Made readable with <a href="\/">plsreadme<\/a><\/span>\s*<\/div>/);
  assert.match(html, /doc-toolbar-meta \{[^}]*display: inline-flex;[^}]*align-self: flex-start;[^}]*width: fit-content;/);
  assert.match(html, /doc-toolbar-toggle \{[^}]*justify-content: space-between;[^}]*min-height: 2\.34rem;/);
  assert.match(html, /doc-toolbar-menu\.is-open \.doc-toolbar-toggle-chevron \{[^}]*transform: rotate\(180deg\);/);
  assert.match(html, /doc-toolbar-actions-panel \{[^}]*flex-direction: column;/);
  assert.match(html, /doc-toolbar-actions-panel \{[^}]*transform: translate\(-0\.42rem, 0\.34rem\);/);
  assert.match(html, /doc-toolbar-actions-panel \{[^}]*opacity: 0;/);
  assert.match(html, /doc-toolbar-actions-panel \{[^}]*visibility: hidden;/);
  assert.match(html, /doc-toolbar-action-entry \{[^}]*transition-delay: calc\(var\(--cascade-down, 0\) \* 30ms\);/);
  assert.match(html, /doc-toolbar-menu\.is-open \.doc-toolbar-action-entry \{[^}]*transition-delay: calc\(var\(--cascade-up, 0\) \* 34ms\);/);
  assert.match(html, /doc-toolbar-auth-floating \{[^}]*z-index: 45;[^}]*pointer-events: auto;/);
  assert.match(html, /doc-toolbar-auth-shell \.auth-menu-dropdown \{[^}]*top: auto;[^}]*bottom: calc\(100% \+ 0\.35rem\);[^}]*z-index: 80;/);
  assert.match(html, /class="lucide-icon"/);
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
