import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function readPublicFile(filename: string): Promise<string> {
  return readFile(path.join(__dirname, "../public", filename), "utf8");
}

test("sign-in page mounts the dedicated Clerk auth page shell", async () => {
  const html = await readPublicFile("sign-in.html");

  assert.match(html, /data-clerk-auth-page="sign-in"/);
  assert.match(html, /data-clerk-component-root/);
  assert.match(html, /<script src="\/clerk-auth-page\.js" defer><\/script>/);
  assert.match(html, />Create account</);
});

test("sign-up page mounts the dedicated Clerk auth page shell", async () => {
  const html = await readPublicFile("sign-up.html");

  assert.match(html, /data-clerk-auth-page="sign-up"/);
  assert.match(html, /data-clerk-component-root/);
  assert.match(html, /<script src="\/clerk-auth-page\.js" defer><\/script>/);
  assert.match(html, />Already have an account\?</);
});

test("auth page script mounts Clerk components and preserves same-origin redirects", async () => {
  const script = await readPublicFile("clerk-auth-page.js");

  assert.match(script, /target\.origin !== window\.location\.origin/);
  assert.match(script, /url\.searchParams\.set\("redirect_url", absoluteTarget\)/);
  assert.match(script, /\/npm\/@clerk\/clerk-js@5\/dist\/clerk\.browser\.js/);
  assert.match(script, /clerk\.mountSignIn\(mountNode,/);
  assert.match(script, /clerk\.mountSignUp\(mountNode,/);
  assert.match(script, /window\.location\.replace\(redirectTarget\)/);
});

test("worker exposes first-party sign-in and sign-up asset routes", async () => {
  const source = await readFile(path.join(__dirname, "../worker/index.ts"), "utf8");
  const wranglerConfig = await readFile(path.join(__dirname, "../wrangler.jsonc"), "utf8");

  assert.match(source, /app\.get\('\/sign-in'/);
  assert.match(source, /serveHtmlAsset\(c, '\/sign-in\.html'\)/);
  assert.match(source, /app\.get\('\/sign-in\/\*'/);
  assert.match(source, /app\.get\('\/sign-up'/);
  assert.match(source, /serveHtmlAsset\(c, '\/sign-up\.html'\)/);
  assert.match(source, /app\.get\('\/sign-up\/\*'/);
  assert.match(wranglerConfig, /"\/sign-in\/\*"/);
  assert.match(wranglerConfig, /"\/sign-up\/\*"/);
});
