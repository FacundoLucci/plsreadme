import { Hono } from 'hono';
import type { Env } from '../types';

export const waitlistRoutes = new Hono<{ Bindings: Env }>();

// Hash IP for privacy
async function hashIP(ip: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(ip + 'outframer-salt-2025');
  const hash = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hash));
  return hashArray.slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Validate email format
function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email) && email.length <= 254;
}

// POST /api/waitlist - Submit email
waitlistRoutes.post('/', async (c) => {
  try {
    const body = await c.req.json<{
      email: string;
      source?: string;
      utm_source?: string;
      utm_medium?: string;
      utm_campaign?: string;
      utm_content?: string;
      utm_term?: string;
      referrer?: string;
      landing_path?: string;
      honeypot?: string;
    }>();

    // Honeypot check - if filled, silently succeed (bot trap)
    if (body.honeypot) {
      return c.json({ success: true });
    }

    const email = body.email?.trim().toLowerCase();

    if (!email) {
      return c.json({ error: 'Email is required' }, 400);
    }

    if (!isValidEmail(email)) {
      return c.json({ error: 'Invalid email format' }, 400);
    }

    // Get IP and hash it
    const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'unknown';
    const ipHash = await hashIP(ip);

    // Get user agent
    const userAgent = c.req.header('User-Agent') || null;

    // Insert into D1
    const result = await c.env.DB.prepare(`
      INSERT INTO waitlist_signups (
        email, created_at, source, 
        utm_source, utm_medium, utm_campaign, utm_content, utm_term,
        referrer, landing_path, user_agent, ip_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      email,
      new Date().toISOString(),
      body.source || null,
      body.utm_source || null,
      body.utm_medium || null,
      body.utm_campaign || null,
      body.utm_content || null,
      body.utm_term || null,
      body.referrer || null,
      body.landing_path || null,
      userAgent,
      ipHash
    ).run();

    if (result.success) {
      return c.json({ success: true });
    } else {
      return c.json({ error: 'Failed to save' }, 500);
    }
  } catch (error: unknown) {
    // Handle duplicate email
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
      return c.json({ success: true, existing: true });
    }
    console.error('Waitlist error:', error);
    return c.json({ error: 'Server error' }, 500);
  }
});

// GET /api/waitlist/count - Get signup count for social proof
waitlistRoutes.get('/count', async (c) => {
  try {
    const result = await c.env.DB.prepare(
      'SELECT COUNT(*) as count FROM waitlist_signups'
    ).first<{ count: number }>();

    const count = result?.count || 0;

    // Apply social proof rules
    let display: string | null = null;
    if (count >= 100) {
      display = '100+';
    } else if (count >= 10) {
      display = count.toString();
    }
    // < 10: null (hide)

    return c.json({ count, display });
  } catch (error) {
    console.error('Count error:', error);
    return c.json({ count: 0, display: null });
  }
});

