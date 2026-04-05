const WEBSITE_DEMO_URL = "https://plsreadme.com";
const MCP_SETUP_URL = "https://plsreadme.com/mcp-setup";
const LOCAL_MCP_COMMAND = "npx -y plsreadme-mcp";

export const hostedMcpCopy = {
  error: "hosted_mcp_contained",
  title: "Hosted remote MCP is temporarily disabled.",
  message:
    "Browser login and personal API key auth are being rolled out for hosted remote MCP.",
  recommendation:
    "Use the website for a quick demo, or run the local MCP package today while remote auth ships.",
  unsupportedClient:
    "This client does not support browser sign-in yet. Use a personal plsreadme API key instead.",
  authExpired:
    "Your plsreadme session expired. Sign in again or switch to a personal API key.",
} as const;

function prefersTextResponse(request: Request): boolean {
  const accept = (request.headers.get("accept") || "").toLowerCase();
  if (!accept) return false;

  return (
    accept.includes("text/html") ||
    accept.includes("text/plain") ||
    accept.includes("text/event-stream")
  );
}

export function buildHostedMcpContainmentPayload(pathname: string) {
  return {
    error: hostedMcpCopy.error,
    title: hostedMcpCopy.title,
    message: hostedMcpCopy.message,
    recommendation: hostedMcpCopy.recommendation,
    endpoint: pathname,
    nextRecommendedPath: "website_demo",
    websiteDemoUrl: WEBSITE_DEMO_URL,
    setupUrl: MCP_SETUP_URL,
    localMcpCommand: LOCAL_MCP_COMMAND,
  };
}

export function createHostedMcpContainmentResponse(request: Request): Response {
  const payload = buildHostedMcpContainmentPayload(new URL(request.url).pathname);

  if (prefersTextResponse(request)) {
    return new Response(
      [
        payload.title,
        payload.message,
        payload.recommendation,
        `Website demo: ${payload.websiteDemoUrl}`,
        `Setup guide: ${payload.setupUrl}`,
        `Local MCP: ${payload.localMcpCommand}`,
      ].join("\n"),
      {
        status: 403,
        headers: {
          "cache-control": "no-store",
          "content-type": "text/plain; charset=utf-8",
        },
      }
    );
  }

  return new Response(JSON.stringify(payload), {
    status: 403,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}
