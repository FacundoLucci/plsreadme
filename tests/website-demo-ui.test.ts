import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function readPublicFile(name: string) {
  return readFile(path.join(__dirname, "../public", name), "utf8");
}

test("app and homepage post-create UIs expose save/account and editor follow-up actions", async () => {
  const [appHtml, appJs, indexHtml] = await Promise.all([
    readPublicFile("app.html"),
    readPublicFile("app.js"),
    readPublicFile("index.html"),
  ]);

  assert.match(appHtml, /id="save-to-account-action"/);
  assert.match(appHtml, /id="connect-editor-action"/);
  assert.match(appHtml, /id="result-meta"/);
  assert.match(appJs, /\/api\/auth\/demo-grant/);
  assert.match(appJs, /\/api\/auth\/save-link/);
  assert.match(indexHtml, /id="inline-save-to-account"/);
  assert.match(indexHtml, /id="inline-connect-editor"/);
});
