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

// Send Discord notification
async function sendDiscordNotification(webhookUrl: string, email: string, requestedFeatures: string | null, utmSource: string | null): Promise<void> {
  try {
    const embed = {
      title: '🎉 New Beta Signup!',
      color: 0x6366f1, // Indigo
      fields: [
        { name: 'Email', value: email, inline: false },
        { name: 'Requested Features', value: requestedFeatures || '_Not specified_', inline: false },
        { name: 'Source', value: utmSource || '_Direct_', inline: true },
        { name: 'Time', value: new Date().toISOString(), inline: true },
      ],
      timestamp: new Date().toISOString(),
    };

    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });
  } catch (error) {
    console.error('Discord notification failed:', error);
    // Don't throw - notifications are non-critical
  }
}

// Send email notification via Resend
async function sendEmailNotification(apiKey: string, toEmail: string, email: string, requestedFeatures: string | null, utmSource: string | null): Promise<void> {
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Outframer <onboarding@resend.dev>', // Change to your verified domain
        to: toEmail,
        subject: '🎉 New Beta Signup - Outframer',
        html: `
          <h2>New Beta Signup</h2>
          <p><strong>Email:</strong> ${email}</p>
          <p><strong>Requested Features:</strong> ${requestedFeatures || '<em>Not specified</em>'}</p>
          <p><strong>Source:</strong> ${utmSource || '<em>Direct</em>'}</p>
          <p><strong>Time:</strong> ${new Date().toISOString()}</p>
        `,
      }),
    });
  } catch (error) {
    console.error('Email notification failed:', error);
    // Don't throw - notifications are non-critical
  }
}

// POST /api/waitlist - Submit email
waitlistRoutes.post('/', async (c) => {
  try {
    const body = await c.req.json<{
      email: string;
      requested_features?: string;
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

    const requestedFeatures = body.requested_features?.trim() || null;

    // Insert into D1
    const result = await c.env.DB.prepare(`
      INSERT INTO waitlist_signups (
        email, created_at, requested_features, source, 
        utm_source, utm_medium, utm_campaign, utm_content, utm_term,
        referrer, landing_path, user_agent, ip_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      email,
      new Date().toISOString(),
      requestedFeatures,
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
      // Send notifications (non-blocking, best-effort)
      const notificationPromises: Promise<void>[] = [];
      
      if (c.env.DISCORD_WEBHOOK_URL) {
        notificationPromises.push(
          sendDiscordNotification(c.env.DISCORD_WEBHOOK_URL, email, requestedFeatures, body.utm_source || null)
        );
      }
      
      if (c.env.RESEND_API_KEY && c.env.NOTIFICATION_EMAIL) {
        notificationPromises.push(
          sendEmailNotification(c.env.RESEND_API_KEY, c.env.NOTIFICATION_EMAIL, email, requestedFeatures, body.utm_source || null)
        );
      }

      // Fire and forget - don't wait for notifications
      if (notificationPromises.length > 0) {
        Promise.all(notificationPromises).catch(err => console.error('Notification error:', err));
      }

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

