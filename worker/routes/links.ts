import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import type { Env } from '../types';

const app = new Hono<{ Bindings: Env }>();

// Helper: Simple SHA-256 hash
async function sha256(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Helper: Extract title from markdown
function extractTitle(markdown: string): string | null {
  const lines = markdown.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('# ')) {
      return trimmed.substring(2).trim();
    }
  }
  return null;
}

// POST /api/create-link
app.post('/', async (c) => {
  try {
    const body = await c.req.json();
    const markdown = body.markdown;

    // Validate markdown length > 0
    if (!markdown || markdown.trim().length === 0) {
      return c.json({ error: 'No markdown content provided' }, 400);
    }

    // Generate ID and hash
    const id = nanoid(10);
    const hash = await sha256(markdown);
    const r2Key = `md/${id}.md`;
    const title = extractTitle(markdown);
    const now = new Date().toISOString();

    // Store in R2
    await c.env.DOCS_BUCKET.put(r2Key, markdown, {
      httpMetadata: {
        contentType: 'text/markdown',
      },
      customMetadata: {
        created_at: now,
        sha256: hash,
      },
    });

    // Store metadata in D1 docs table
    await c.env.DB.prepare(
      'INSERT INTO docs (id, r2_key, content_type, bytes, created_at, sha256, title, view_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(id, r2Key, 'text/markdown', markdown.length, now, hash, title, 0).run();

    // Return id and url
    const baseUrl = new URL(c.req.url).origin;
    return c.json({
      id,
      url: `${baseUrl}/v/${id}`
    });
  } catch (error) {
    console.error('Error creating link:', error);
    return c.json({ error: 'Failed to create link' }, 500);
  }
});

export { app as linksRoutes };
