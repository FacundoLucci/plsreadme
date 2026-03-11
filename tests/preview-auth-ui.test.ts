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

test("signed-in read-link auth UI uses dropdown with My Links + Sign out", async () => {
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
  assert.match(template, /href="\/my-links" class="auth-menu-item"/);
  assert.match(template, /data-auth-action="sign-out"/);
});

test("preview template includes save button and logged-out comment login CTA", () => {
  const html = generateHtmlTemplate("Preview", "<p>Hello</p>", "doc_preview", 1);

  assert.match(html, /id="preview-save-btn"/);
  assert.match(html, /id="comment-login-cta"/);
  assert.match(html, /Sign in for account-linked comments/);
  assert.match(html, /\/api\/auth\/save-link/);
});

test("auth redirects preserve returnBackUrl from preview actions", async () => {
  const script = await loadAuthShellScript();

  assert.match(script, /redirectToSignIn\(\{\s*returnBackUrl: window\.location\.href,/);
  assert.match(script, /redirectToSignUp\(\{\s*returnBackUrl: window\.location\.href,/);
  assert.match(script, /searchParams\.set\("redirect_url", returnTo\)/);
});
