import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function readRepoFile(relativePath: string) {
  return readFile(path.join(__dirname, "..", relativePath), "utf8");
}

test("my-links account page exposes personal MCP API key management UI", async () => {
  const [html, script] = await Promise.all([
    readRepoFile("public/my-links.html"),
    readRepoFile("public/my-links.js"),
  ]);

  assert.match(html, /MCP API keys/);
  assert.match(html, /id="mcp-api-key-form"/);
  assert.match(html, /id="mcp-api-key-token"/);
  assert.match(html, /PLSREADME_API_KEY/);
  assert.match(html, /PLSREADME_ALLOW_ANONYMOUS=1/);

  assert.match(script, /\/api\/auth\/mcp-api-keys/);
  assert.match(script, /function renderApiKeys/);
  assert.match(script, /function createApiKey/);
  assert.match(script, /function revokeApiKey/);
});

test("docs and setup page publish explicit API key and legacy-anonymous guidance", async () => {
  const [setupHtml, packageReadme, rootReadme] = await Promise.all([
    readRepoFile("public/mcp-setup.html"),
    readRepoFile("packages/mcp/README.md"),
    readRepoFile("README.md"),
  ]);

  assert.match(setupHtml, /Remote API key fallback/);
  assert.match(setupHtml, /PLSREADME_API_KEY/);
  assert.match(setupHtml, /\/my-links/);
  assert.match(setupHtml, /PLSREADME_ALLOW_ANONYMOUS=1/);

  assert.match(packageReadme, /Hosted Remote API Key fallback/);
  assert.match(packageReadme, /plsreadme_auth_status/);
  assert.match(packageReadme, /PLSREADME_ALLOW_ANONYMOUS=1/);

  assert.match(rootReadme, /Hosted remote MCP with API key \| Available now/);
  assert.match(rootReadme, /PLSREADME_API_KEY/);
  assert.match(rootReadme, /PLSREADME_ALLOW_ANONYMOUS=1/);
});
