import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import type { Env } from './types.ts';
import { waitlistRoutes } from './routes/waitlist.ts';
import { analyticsRoutes } from './routes/analytics.ts';
import { docsRoutes } from './routes/docs.ts';
import { convertRoutes } from './routes/convert.ts';
import { linksRoutes } from './routes/links.ts';
import { adminRoutes } from './routes/admin.ts';
import { commentsRoutes } from './routes/comments.ts';
import { authRoutes } from './routes/auth.ts';
import {
  buildHostedMcpOauthErrorResponse,
  handleHostedMcpAuthorizeRequest,
  HOSTED_MCP_ACCESS_TOKEN_TTL_SECONDS,
  HOSTED_MCP_AUTHORIZE_PATH,
  HOSTED_MCP_REFRESH_TOKEN_TTL_SECONDS,
  HOSTED_MCP_REGISTER_PATH,
  HOSTED_MCP_SCOPE,
  HOSTED_MCP_TOKEN_PATH,
} from './mcp-oauth.ts';
import {
  buildHostedMcpApiKeyProps,
  MCP_REMOTE_API_KEY_SOURCE,
  resolvePersonalMcpApiKey,
} from './mcp-api-keys.ts';
import { OutframerMCP, OutframerMCPv2 } from './mcp-agent.ts';

// Export MCP Durable Object classes for Cloudflare bindings/migrations
export { OutframerMCP, OutframerMCPv2 };

const app = new Hono<{ Bindings: Env }>();

function serveHtmlAsset(c: Context<{ Bindings: Env }>, pathname: string) {
  const url = new URL(c.req.url);
  url.pathname = pathname;
  return c.env.ASSETS.fetch(new Request(url.toString(), { method: 'GET', headers: c.req.raw.headers }));
}

// CORS for API routes
app.use('/api/*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Admin-Token'],
}));

// Mount routes
app.route('/api/waitlist', waitlistRoutes);
app.route('/api/render', docsRoutes);
app.route('/api/convert', convertRoutes);
app.route('/api/create-link', linksRoutes);
app.route('/api/admin', adminRoutes);
app.route('/api/comments', commentsRoutes);
app.route('/api/auth', authRoutes);
app.route('/t', analyticsRoutes);

// Mount document viewer routes
app.route('/v', docsRoutes);

// Health check
app.get('/api/health', (c) => c.json({ status: 'ok' }));

// Redirect plsrd.me root to plsreadme.com
app.get('/', (c) => {
  const hostname = new URL(c.req.url).hostname;
  if (hostname === 'plsrd.me') {
    return c.redirect('https://plsreadme.com', 301);
  }
  // Otherwise serve homepage normally
  return c.env.ASSETS.fetch(c.req.raw);
});

app.get('/my-links', async (c) => {
  return serveHtmlAsset(c, '/my-links.html');
});

app.get('/sign-in', async (c) => {
  return serveHtmlAsset(c, '/sign-in.html');
});

app.get('/sign-in/*', async (c) => {
  return serveHtmlAsset(c, '/sign-in.html');
});

app.get('/sign-up', async (c) => {
  return serveHtmlAsset(c, '/sign-up.html');
});

app.get('/sign-up/*', async (c) => {
  return serveHtmlAsset(c, '/sign-up.html');
});

// MCP setup page (served as static asset: mcp-setup.html)

// Fallback to static assets for all other routes
app.get('*', async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

const hostedMcpStreamableHandler = OutframerMCP.serve('/mcp', {
  binding: 'MCP_OBJECT',
});

const hostedMcpSseHandler = OutframerMCP.serveSSE('/sse', {
  binding: 'MCP_OBJECT',
});

const hostedMcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === '/mcp') {
      return hostedMcpStreamableHandler.fetch(request, env, ctx);
    }

    if (url.pathname === '/sse' || url.pathname === '/sse/message') {
      return hostedMcpSseHandler.fetch(request, env, ctx);
    }

    return new Response('Not found', { status: 404 });
  },
};

const hostedMcpDefaultHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === HOSTED_MCP_AUTHORIZE_PATH) {
      return handleHostedMcpAuthorizeRequest(request, env);
    }

    return app.fetch(request, env, ctx);
  },
};

const hostedMcpOAuth = new OAuthProvider<Env>({
  apiRoute: ['/mcp', '/sse'],
  apiHandler: hostedMcpApiHandler,
  defaultHandler: hostedMcpDefaultHandler,
  authorizeEndpoint: HOSTED_MCP_AUTHORIZE_PATH,
  tokenEndpoint: HOSTED_MCP_TOKEN_PATH,
  clientRegistrationEndpoint: HOSTED_MCP_REGISTER_PATH,
  scopesSupported: [HOSTED_MCP_SCOPE],
  accessTokenTTL: HOSTED_MCP_ACCESS_TOKEN_TTL_SECONDS,
  refreshTokenTTL: HOSTED_MCP_REFRESH_TOKEN_TTL_SECONDS,
  allowPlainPKCE: false,
  async resolveExternalToken({ token, env }) {
    const apiKeyAuth = await resolvePersonalMcpApiKey(env, token, MCP_REMOTE_API_KEY_SOURCE);
    if (!apiKeyAuth) {
      return null;
    }

    return {
      props: buildHostedMcpApiKeyProps(apiKeyAuth),
    };
  },
  onError(error) {
    return buildHostedMcpOauthErrorResponse(error);
  },
});

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return hostedMcpOAuth.fetch(request, env, ctx);
  },
};
