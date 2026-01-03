import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types';
import { waitlistRoutes } from './routes/waitlist';
import { analyticsRoutes } from './routes/analytics';
import { docsRoutes } from './routes/docs';
import { convertRoutes } from './routes/convert';
import { linksRoutes } from './routes/links';
import { adminRoutes } from './routes/admin';
// Export the MCP Durable Object class for Cloudflare binding
export { OutframerMCP } from './mcp-agent';
import { OutframerMCP as MCPServer } from './mcp-agent';

const app = new Hono<{ Bindings: Env }>();

// CORS for API routes
app.use('/api/*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type'],
}));

// Mount routes
app.route('/api/waitlist', waitlistRoutes);
app.route('/api/render', docsRoutes);
app.route('/api/convert', convertRoutes);
app.route('/api/create-link', linksRoutes);
app.route('/api/admin', adminRoutes);
app.route('/t', analyticsRoutes);

// Mount document viewer routes
app.route('/v', docsRoutes);

// Health check
app.get('/api/health', (c) => c.json({ status: 'ok' }));

// Fallback to static assets for all other routes
app.get('*', async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // Handle MCP endpoints
    if (url.pathname === '/sse' || url.pathname === '/sse/message') {
      return MCPServer.serveSSE('/sse').fetch(request, env, ctx);
    }

    if (url.pathname === '/mcp') {
      return MCPServer.serve('/mcp').fetch(request, env, ctx);
    }

    // Handle all other routes with Hono app
    return app.fetch(request, env, ctx);
  },
};

