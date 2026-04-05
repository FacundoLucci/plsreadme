import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test("rollout docs cover compatibility, migration, and smoke checks", async () => {
  const [readme, packageReadme, authDoc, rolloutRunbook] = await Promise.all([
    readFile(path.join(__dirname, "../README.md"), "utf8"),
    readFile(path.join(__dirname, "../packages/mcp/README.md"), "utf8"),
    readFile(path.join(__dirname, "../docs/auth-clerk.md"), "utf8"),
    readFile(path.join(__dirname, "../docs/runbooks/mcp-auth-rollout-checklist.md"), "utf8"),
  ]);

  assert.match(readme, /Client compatibility matrix/);
  assert.match(readme, /Migrating existing anonymous MCP setups/);
  assert.match(readme, /007_doc_attribution_telemetry\.sql/);

  assert.match(packageReadme, /Migration From Older Anonymous Local MCP Setups/);
  assert.match(packageReadme, /PLSREADME_ALLOW_ANONYMOUS=1/);

  assert.match(authDoc, /Backend telemetry \+ enforcement contract \(Phase 5\)/);
  assert.match(authDoc, /Client compatibility matrix/);
  assert.match(authDoc, /Migration guidance for older anonymous MCP users/);

  assert.match(rolloutRunbook, /Smoke checklist/);
  assert.match(rolloutRunbook, /Hosted remote API key fallback/);
  assert.match(rolloutRunbook, /PLSREADME_API_KEY/);
});
