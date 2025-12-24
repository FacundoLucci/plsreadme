import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types';
import { waitlistRoutes } from './routes/waitlist';
import { analyticsRoutes } from './routes/analytics';
import { docsRoutes } from './routes/docs';
import { convertRoutes } from './routes/convert';

const app = new Hono<{ Bindings: Env }>();

// Durable Object kept for backwards compatibility with existing instances.
// Cloudflare will reject deploys if a class referenced by existing DO instances
// is removed or renamed without a migration.
export class OutframerMCP {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(_request: Request): Promise<Response> {
    return new Response(
      'OutframerMCP Durable Object is no longer used by this Worker.',
      {
        status: 410,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      }
    );
  }
}

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
app.route('/t', analyticsRoutes);

// Mount document viewer routes
app.route('/v', docsRoutes);

// Health check
app.get('/api/health', (c) => c.json({ status: 'ok' }));

// Fallback to static assets for all other routes
app.get('*', async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;

