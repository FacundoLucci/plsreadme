import { Hono } from 'hono';
import type { Env, TrackingEvent } from '../types';

export const analyticsRoutes = new Hono<{ Bindings: Env }>();

// Valid event names
const VALID_EVENTS = new Set([
  'page_view',
  'cta_click',
  'request_beta_access',
  'waitlist_submit',
  'waitlist_success',
  'waitlist_error',
  'scroll_50',
  'scroll_90',
  'origin_answer'
]);

// POST /t - Track event
analyticsRoutes.post('/', async (c) => {
  try {
    const event = await c.req.json<TrackingEvent>();

    // Validate event name
    if (!event.event || !VALID_EVENTS.has(event.event)) {
      return c.json({ error: 'Invalid event' }, 400);
    }

    // Write to Analytics Engine
    // blobs: string data (max 20 blobs, 256 bytes each)
    // doubles: numeric data (max 20 doubles)
    // indexes: indexed string for fast lookups (max 1, 32 bytes)
    c.env.ANALYTICS.writeDataPoint({
      blobs: [
        event.event,                           // blob1: event name
        event.path || '',                      // blob2: page path
        event.referrer || '',                  // blob3: referrer
        event.utm_source || '',                // blob4: utm_source
        event.utm_medium || '',                // blob5: utm_medium
        event.utm_campaign || '',              // blob6: utm_campaign
        event.utm_content || '',               // blob7: utm_content
        event.utm_term || '',                  // blob8: utm_term
        event.cta_location || '',              // blob9: cta location (hero|bottom)
      ],
      doubles: [
        event.timestamp || Date.now(),         // double1: timestamp
      ],
      indexes: [
        event.anon_id || '',                   // index1: anonymous user ID
      ],
    });

    return c.json({ success: true });
  } catch (error) {
    console.error('Analytics error:', error);
    return c.json({ error: 'Failed to track' }, 500);
  }
});

