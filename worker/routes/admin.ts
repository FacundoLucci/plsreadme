import { Hono } from 'hono';
import type { Env } from '../types';

const app = new Hono<{ Bindings: Env }>();

// GET /api/admin/metrics
app.get('/metrics', async (c) => {
  try {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).toISOString();
    const sevenDaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7).toISOString();

    // Links created today
    const todayResult = await c.env.DB.prepare(
      'SELECT COUNT(*) as count FROM outframer_links WHERE created_at >= ?'
    ).bind(today).first<{ count: number }>();
    const links_today = todayResult?.count || 0;

    // Links created yesterday
    const yesterdayResult = await c.env.DB.prepare(
      'SELECT COUNT(*) as count FROM outframer_links WHERE created_at >= ? AND created_at < ?'
    ).bind(yesterday, today).first<{ count: number }>();
    const links_yesterday = yesterdayResult?.count || 0;

    // Total links
    const totalResult = await c.env.DB.prepare(
      'SELECT COUNT(*) as count FROM outframer_links'
    ).first<{ count: number }>();
    const total_links = totalResult?.count || 0;

    // Average links/day (last 7 days)
    const last7DaysResult = await c.env.DB.prepare(
      'SELECT COUNT(*) as count FROM outframer_links WHERE created_at >= ?'
    ).bind(sevenDaysAgo).first<{ count: number }>();
    const links_last_7_days = last7DaysResult?.count || 0;
    const avg_links_per_day = Math.round(links_last_7_days / 7);

    return c.json({
      links_today,
      links_yesterday,
      total_links,
      avg_links_per_day
    });
  } catch (error) {
    console.error('Error fetching admin metrics:', error);
    return c.json({ error: 'Failed to fetch metrics' }, 500);
  }
});

export { app as adminRoutes };
