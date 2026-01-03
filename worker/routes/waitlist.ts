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
    if (!webhookUrl || webhookUrl.trim() === '') {
      console.error('Discord webhook URL is empty or invalid');
      return;
    }

    const truncate = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);
    const safeRequestedFeatures = requestedFeatures ? truncate(requestedFeatures, 1000) : null; // Discord embed field value max is 1024
    const safeSource = utmSource ? truncate(utmSource, 128) : null;

    const embed = {
      title: '🎉 New Beta Signup!',
      color: 0x6366f1, // Indigo
      fields: [
        { name: 'Email', value: email, inline: false },
        { name: 'Requested Features', value: safeRequestedFeatures || '_Not specified_', inline: false },
        { name: 'Source', value: safeSource || '_Direct_', inline: true },
        { name: 'Time', value: new Date().toISOString(), inline: true },
      ],
      timestamp: new Date().toISOString(),
    };

    const payload = JSON.stringify({ embeds: [embed] });
    console.log('Sending Discord notification to webhook:', webhookUrl.substring(0, 50) + '...');

    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('Discord notification failed:', {
        status: res.status,
        statusText: res.statusText,
        body: text.slice(0, 500),
        webhookUrl: webhookUrl.substring(0, 50) + '...',
      });
    } else {
      console.log('Discord notification sent successfully');
    }
  } catch (error) {
    console.error('Discord notification error:', error instanceof Error ? error.message : String(error));
    // Don't throw - notifications are non-critical
  }
}

// Send email notification via Resend
async function sendEmailNotification(apiKey: string, toEmail: string, email: string, requestedFeatures: string | null, utmSource: string | null): Promise<void> {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'plsreadme <onboarding@resend.dev>', // Change to your verified domain
        to: toEmail,
        subject: '🎉 New Beta Signup - plsreadme',
        html: `
          <h2>New Beta Signup</h2>
          <p><strong>Email:</strong> ${email}</p>
          <p><strong>Requested Features:</strong> ${requestedFeatures || '<em>Not specified</em>'}</p>
          <p><strong>Source:</strong> ${utmSource || '<em>Direct</em>'}</p>
          <p><strong>Time:</strong> ${new Date().toISOString()}</p>
        `,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('Email notification failed:', {
        status: res.status,
        statusText: res.statusText,
        body: text.slice(0, 500),
      });
    }
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

      // Fire-and-forget, but keep the Worker alive long enough to finish.
      // Without waitUntil(), the runtime may terminate before webhook fetch completes.
      if (notificationPromises.length > 0) {
        // Create promise that handles errors but doesn't reject (for waitUntil)
        const all = Promise.all(notificationPromises).then(
          () => console.log('All notifications completed successfully'),
          (err) => console.error('Notification error:', err)
        );
        
        // Access execution context - Hono provides this via c.executionCtx
        const execCtx = (c as any).executionCtx as ExecutionContext | undefined;
        if (execCtx && typeof execCtx.waitUntil === 'function') {
          execCtx.waitUntil(all);
          console.log('Using executionCtx.waitUntil() for background notifications');
        } else {
          // Fallback: try c.event (Service Worker syntax)
          const event = (c as any).event as { waitUntil?: (promise: Promise<unknown>) => void } | undefined;
          if (event && typeof event.waitUntil === 'function') {
            event.waitUntil(all);
            console.log('Using event.waitUntil() for background notifications');
          } else {
            console.warn('Execution context not available - notifications may not complete');
            console.warn('Available context keys:', Object.keys(c));
            // Still execute but don't block - this might work in some cases
            all.catch(() => {});
          }
        }
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

// GET /api/waitlist/test-discord - Test Discord notification
waitlistRoutes.get('/test-discord', async (c) => {
  if (!c.env.DISCORD_WEBHOOK_URL) {
    return c.json({ error: 'DISCORD_WEBHOOK_URL not set' }, 400);
  }
  
  try {
    await sendDiscordNotification(
      c.env.DISCORD_WEBHOOK_URL,
      'test@example.com',
      'This is a test notification',
      'test'
    );
    
    return c.json({ 
      success: true, 
      message: 'Discord notification sent. Check your Discord channel and worker logs.',
      webhookUrl: c.env.DISCORD_WEBHOOK_URL.substring(0, 50) + '...'
    });
  } catch (error) {
    return c.json({ 
      error: 'Failed to send notification',
      details: error instanceof Error ? error.message : String(error)
    }, 500);
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

