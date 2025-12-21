import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types';
import { waitlistRoutes } from './routes/waitlist';
import { analyticsRoutes } from './routes/analytics';

const app = new Hono<{ Bindings: Env }>();

// CORS for API routes
app.use('/api/*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type'],
}));

// Mount routes
app.route('/api/waitlist', waitlistRoutes);
app.route('/t', analyticsRoutes);

// Health check
app.get('/api/health', (c) => c.json({ status: 'ok' }));

// Fallback to static assets for all other routes
app.get('*', async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;

