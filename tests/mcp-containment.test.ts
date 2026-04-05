import assert from "node:assert/strict";
import test from "node:test";
import {
  buildHostedMcpContainmentPayload,
  createHostedMcpContainmentResponse,
  hostedMcpCopy,
} from "../worker/mcp-containment.ts";

test("hosted MCP containment payload points users to the supported fallbacks", () => {
  const payload = buildHostedMcpContainmentPayload("/mcp");

  assert.equal(payload.error, "hosted_mcp_contained");
  assert.equal(payload.endpoint, "/mcp");
  assert.equal(payload.nextRecommendedPath, "website_demo");
  assert.equal(payload.websiteDemoUrl, "https://plsreadme.com");
  assert.equal(payload.setupUrl, "https://plsreadme.com/mcp-setup");
  assert.equal(payload.localMcpCommand, "npx -y plsreadme-mcp");
});

test("hosted MCP containment returns JSON by default for programmatic callers", async () => {
  const response = createHostedMcpContainmentResponse(
    new Request("https://plsreadme.com/mcp")
  );

  assert.equal(response.status, 403);
  assert.equal(
    response.headers.get("content-type"),
    "application/json; charset=utf-8"
  );

  const payload = (await response.json()) as Record<string, string>;
  assert.equal(payload.error, hostedMcpCopy.error);
  assert.match(payload.message, /browser login/i);
});

test("hosted MCP containment returns text guidance for browser and SSE callers", async () => {
  const response = createHostedMcpContainmentResponse(
    new Request("https://plsreadme.com/sse", {
      headers: {
        Accept: "text/event-stream",
      },
    })
  );

  assert.equal(response.status, 403);
  assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");

  const body = await response.text();
  assert.match(body, /Hosted remote MCP is temporarily disabled\./);
  assert.match(body, /Website demo: https:\/\/plsreadme\.com/);
  assert.match(body, /Local MCP: npx -y plsreadme-mcp/);
});
