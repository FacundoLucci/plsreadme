import type { ClientInfo } from "@cloudflare/workers-oauth-provider";
import type { RequestAuth } from "./auth.ts";
import { resolveRequestAuthFromRequest } from "./auth.ts";
import type { Env } from "./types.ts";

export const HOSTED_MCP_AUTHORIZE_PATH = "/authorize";
export const HOSTED_MCP_TOKEN_PATH = "/oauth/token";
export const HOSTED_MCP_REGISTER_PATH = "/oauth/register";
export const HOSTED_MCP_SCOPE = "mcp:tools";
export const HOSTED_MCP_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
export const HOSTED_MCP_REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;

const CSRF_COOKIE_NAME = "__Host-plsreadme-mcp-csrf";
const LOCAL_MCP_COMMAND = "npx -y plsreadme-mcp";
const DEFAULT_SIGN_IN_PATH = "/sign-in";
const SETUP_PATH = "/mcp-setup";

export interface HostedMcpGrantProps {
  userId: string;
  sessionId: string | null;
  email: string | null;
  authMode: "remote_login" | "remote_api_key";
  source: "mcp_remote_login" | "mcp_remote_api_key";
  clientId: string;
  clientName: string;
  grantedAt: string;
  apiKeyId?: string | null;
  apiKeyName?: string | null;
}

type OAuthErrorInput = {
  code: string;
  description: string;
  status: number;
  headers: Record<string, string>;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseCookieValue(cookieHeader: string, cookieName: string): string | null {
  const pairs = cookieHeader.split(";");
  for (const pair of pairs) {
    const [rawName, ...rest] = pair.trim().split("=");
    if (rawName !== cookieName) continue;
    const value = rest.join("=").trim();
    if (!value) return null;
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  return null;
}

function buildCsrfCookie(requestUrl: string, token: string): string {
  const url = new URL(requestUrl);
  const secure = url.protocol === "https:";
  return [
    `${CSRF_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=600",
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

function clearCsrfCookie(requestUrl: string): string {
  const url = new URL(requestUrl);
  const secure = url.protocol === "https:";
  return [
    `${CSRF_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

function getDisplayClientName(clientInfo: ClientInfo | null, clientId: string): string {
  if (clientInfo?.clientName?.trim()) {
    return clientInfo.clientName.trim();
  }

  if (clientInfo?.clientUri) {
    try {
      return new URL(clientInfo.clientUri).hostname;
    } catch {}
  }

  try {
    return new URL(clientId).hostname;
  } catch {
    return clientId;
  }
}

function buildGrantProps(
  auth: RequestAuth,
  clientInfo: ClientInfo | null,
  clientId: string
): HostedMcpGrantProps {
  if (!auth.userId) {
    throw new Error("Authenticated user is required for hosted MCP authorization");
  }

  return {
    userId: auth.userId,
    sessionId: auth.sessionId,
    email: auth.email,
    authMode: "remote_login",
    source: "mcp_remote_login",
    clientId,
    clientName: getDisplayClientName(clientInfo, clientId),
    grantedAt: new Date().toISOString(),
    apiKeyId: null,
    apiKeyName: null,
  };
}

function buildAuthorizePageFrame({
  title,
  eyebrow,
  body,
}: {
  title: string;
  eyebrow: string;
  body: string;
}): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)} · plsreadme</title>
    <meta
      name="description"
      content="Approve browser login for the plsreadme hosted MCP server."
    />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@500;600&display=swap"
      rel="stylesheet"
    />
    <style>
      :root {
        --bg: #f8fafc;
        --surface: rgba(255, 255, 255, 0.94);
        --border: rgba(15, 23, 42, 0.1);
        --text: #0f172a;
        --muted: #475569;
        --accent: #2563eb;
        --accent-strong: #1d4ed8;
      }

      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #020617;
          --surface: rgba(15, 23, 42, 0.92);
          --border: rgba(148, 163, 184, 0.18);
          --text: #e2e8f0;
          --muted: #94a3b8;
          --accent: #60a5fa;
          --accent-strong: #93c5fd;
        }
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        font-family: "Instrument Sans", sans-serif;
        color: var(--text);
        background:
          radial-gradient(circle at top left, rgba(37, 99, 235, 0.16), transparent 34%),
          linear-gradient(180deg, var(--bg), color-mix(in srgb, var(--bg) 78%, white 22%));
      }

      .page {
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 1.5rem;
      }

      .panel {
        width: min(720px, 100%);
        border: 1px solid var(--border);
        border-radius: 24px;
        background: var(--surface);
        backdrop-filter: blur(18px);
        box-shadow: 0 26px 90px rgba(15, 23, 42, 0.16);
        overflow: hidden;
      }

      .panel-inner {
        padding: 1.5rem;
        display: grid;
        gap: 1rem;
      }

      .eyebrow {
        display: inline-flex;
        width: fit-content;
        align-items: center;
        gap: 0.45rem;
        border-radius: 999px;
        padding: 0.38rem 0.72rem;
        font-size: 0.76rem;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--accent-strong);
        background: rgba(37, 99, 235, 0.1);
      }

      h1 {
        margin: 0;
        font-size: clamp(1.8rem, 4vw, 2.6rem);
        line-height: 1.05;
      }

      p {
        margin: 0;
        color: var(--muted);
        line-height: 1.6;
      }

      .card {
        border: 1px solid var(--border);
        border-radius: 18px;
        padding: 1rem;
        background: rgba(255, 255, 255, 0.5);
      }

      @media (prefers-color-scheme: dark) {
        .card {
          background: rgba(15, 23, 42, 0.58);
        }
      }

      .scopes {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
      }

      .scope-chip {
        font-family: "JetBrains Mono", monospace;
        font-size: 0.78rem;
        padding: 0.38rem 0.58rem;
        border-radius: 999px;
        border: 1px solid var(--border);
        background: rgba(37, 99, 235, 0.08);
        color: var(--text);
      }

      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 0.75rem;
        align-items: center;
      }

      .primary-button,
      .secondary-link {
        appearance: none;
        border: none;
        border-radius: 999px;
        font: inherit;
        text-decoration: none;
        cursor: pointer;
      }

      .primary-button {
        background: linear-gradient(135deg, var(--accent), var(--accent-strong));
        color: white;
        font-weight: 700;
        padding: 0.82rem 1.18rem;
      }

      .secondary-link {
        color: var(--accent-strong);
        font-weight: 600;
      }

      .auth-shell-host {
        min-height: 2.25rem;
      }
    </style>
  </head>
  <body>
    <main class="page">
      <section class="panel">
        <div class="panel-inner">
          <span class="eyebrow">${escapeHtml(eyebrow)}</span>
          ${body}
        </div>
      </section>
    </main>
    <script src="/clerk-auth-shell.js" defer></script>
  </body>
</html>`;
}

function renderSignInPage({
  requestUrl,
  clientName,
}: {
  requestUrl: string;
  clientName: string;
}): string {
  return buildAuthorizePageFrame({
    title: `Sign in to connect ${clientName}`,
    eyebrow: "Hosted MCP Login",
    body: `
      <h1>Sign in to connect ${escapeHtml(clientName)}</h1>
      <p>
        plsreadme uses your existing website account for hosted MCP. Sign in once, approve the
        connection, and your editor can create account-owned docs without copying a token.
      </p>
      <div class="card">
        <p>
          If your client cannot finish browser login, use the local MCP package today:
          <strong>${escapeHtml(LOCAL_MCP_COMMAND)}</strong> and authenticate it with a personal
          plsreadme API key from your account page.
        </p>
      </div>
      <div class="card">
        <div class="auth-shell-host" data-auth-root data-auth-variant="read-link"></div>
      </div>
      <div class="actions">
        <a class="secondary-link" href="${escapeHtml(
          `${SETUP_PATH}?return_to=${encodeURIComponent(requestUrl)}`
        )}">Open setup guide</a>
      </div>
    `,
  });
}

function renderConsentPage({
  requestUrl,
  clientName,
  csrfToken,
  email,
  scopes,
}: {
  requestUrl: string;
  clientName: string;
  csrfToken: string;
  email: string | null;
  scopes: string[];
}): string {
  return buildAuthorizePageFrame({
    title: `Approve ${clientName}`,
    eyebrow: "Approve Access",
    body: `
      <div class="auth-shell-host" data-auth-root></div>
      <h1>Allow ${escapeHtml(clientName)} to use plsreadme</h1>
      <p>
        This grants the editor a renewable login for the hosted MCP endpoint. Reconnecting the same
        client replaces the older grant, and token refresh is handled automatically by the client.
      </p>
      <div class="card">
        <p><strong>Signed in as:</strong> ${escapeHtml(email || "your plsreadme account")}</p>
      </div>
      <div class="card">
        <p><strong>Granted scope</strong></p>
        <div class="scopes">
          ${scopes
            .map((scope) => `<span class="scope-chip">${escapeHtml(scope)}</span>`)
            .join("")}
        </div>
      </div>
      <div class="card">
        <p>
          After approval, return to your editor and retry the connection. Hosted remote creates will
          be owned by your account and tagged as <strong>mcp_remote_login</strong>.
        </p>
      </div>
      <form method="POST" action="${escapeHtml(requestUrl)}">
        <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}" />
        <div class="actions">
          <button class="primary-button" type="submit">Approve and continue</button>
          <a class="secondary-link" href="${escapeHtml(SETUP_PATH)}">Cancel</a>
        </div>
      </form>
    `,
  });
}

function renderErrorPage({
  title,
  message,
}: {
  title: string;
  message: string;
}): string {
  return buildAuthorizePageFrame({
    title,
    eyebrow: "Authorization Error",
    body: `
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
      <div class="card">
        <p>
          Re-open the connection from a supported client, or use the local MCP package today:
          <strong>${escapeHtml(LOCAL_MCP_COMMAND)}</strong> with a personal plsreadme API key.
        </p>
      </div>
      <div class="actions">
        <a class="secondary-link" href="${escapeHtml(SETUP_PATH)}">Open setup guide</a>
      </div>
    `,
  });
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function getAuthorizeHelpers(env: Env) {
  if (!env.OAUTH_PROVIDER) {
    throw new Error("OAUTH_PROVIDER helper missing from environment");
  }

  return env.OAUTH_PROVIDER;
}

export async function handleHostedMcpAuthorizeRequest(
  request: Request,
  env: Env
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "GET, POST" },
    });
  }

  const oauth = getAuthorizeHelpers(env);

  let oauthRequest;
  try {
    oauthRequest = await oauth.parseAuthRequest(request);
  } catch (error) {
    return htmlResponse(
      renderErrorPage({
        title: "Invalid authorization request",
        message: error instanceof Error ? error.message : "Could not parse the client request.",
      }),
      400
    );
  }

  const clientInfo = await oauth.lookupClient(oauthRequest.clientId);
  const clientName = getDisplayClientName(clientInfo, oauthRequest.clientId);
  const requestAuth = await resolveRequestAuthFromRequest(request, env);

  if (!requestAuth.isAuthenticated || !requestAuth.userId) {
    return htmlResponse(
      renderSignInPage({
        requestUrl: request.url,
        clientName,
      })
    );
  }

  if (request.method === "GET") {
    const csrfToken = crypto.randomUUID();
    const response = htmlResponse(
      renderConsentPage({
        requestUrl: request.url,
        clientName,
        csrfToken,
        email: requestAuth.email,
        scopes:
          oauthRequest.scope.length > 0 ? oauthRequest.scope : [HOSTED_MCP_SCOPE],
      })
    );
    response.headers.append("Set-Cookie", buildCsrfCookie(request.url, csrfToken));
    return response;
  }

  const cookieHeader = request.headers.get("cookie") ?? "";
  const cookieToken = parseCookieValue(cookieHeader, CSRF_COOKIE_NAME);
  const formData = await request.formData().catch(() => null);
  const postedToken = typeof formData?.get("csrf_token") === "string"
    ? String(formData?.get("csrf_token"))
    : null;

  if (!cookieToken || !postedToken || cookieToken !== postedToken) {
    const response = htmlResponse(
      renderErrorPage({
        title: "Session check failed",
        message: "Your approval session expired. Sign in again and retry the connection.",
      }),
      400
    );
    response.headers.append("Set-Cookie", clearCsrfCookie(request.url));
    return response;
  }

  const grantedScopes = Array.from(
    new Set(
      (oauthRequest.scope.length ? oauthRequest.scope : [HOSTED_MCP_SCOPE]).filter(
        (scope) => scope === HOSTED_MCP_SCOPE
      )
    )
  );

  const { redirectTo } = await oauth.completeAuthorization({
    request: oauthRequest,
    userId: requestAuth.userId,
    metadata: {
      clientId: oauthRequest.clientId,
      clientName,
      source: "mcp_remote_login",
      approvedAt: new Date().toISOString(),
    },
    scope: grantedScopes.length ? grantedScopes : [HOSTED_MCP_SCOPE],
    props: buildGrantProps(requestAuth, clientInfo, oauthRequest.clientId),
    revokeExistingGrants: true,
  });

  return new Response(null, {
    status: 302,
    headers: {
      Location: redirectTo,
      "Set-Cookie": clearCsrfCookie(request.url),
    },
  });
}

export function buildHostedMcpOauthErrorResponse(error: OAuthErrorInput): Response {
  const message =
    error.code === "invalid_token"
      ? "Your hosted MCP login expired or was revoked. Reconnect the editor to sign in again, or switch to a personal plsreadme API key."
      : error.code === "access_denied"
        ? "This MCP client could not finish the browser login flow. Use a personal plsreadme API key instead."
        : error.description;

  return new Response(
    JSON.stringify({
      error: error.code,
      error_description: error.description,
      message,
      setupUrl: `https://plsreadme.com${SETUP_PATH}`,
      localMcpCommand: LOCAL_MCP_COMMAND,
      nextStep:
        error.code === "invalid_token"
          ? "Open the editor's MCP connection again to restart browser login, or use a personal API key from the setup guide."
          : "Open the setup guide and use the supported remote-login instructions or the API key fallback.",
    }),
    {
      status: error.status,
      headers: {
        ...error.headers,
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    }
  );
}

export function buildHostedMcpGrantPropsForTest(
  auth: RequestAuth,
  clientId: string,
  clientName = "Example Client"
): HostedMcpGrantProps {
  return buildGrantProps(
    auth,
    {
      clientId,
      clientName,
      redirectUris: [],
      tokenEndpointAuthMethod: "none",
    },
    clientId
  );
}
