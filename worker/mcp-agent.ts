import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpAgent } from 'agents/mcp';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import type { Env } from './types';

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

// Send Discord notification (link/doc creation)
async function sendDiscordLinkCreatedNotification(
  webhookUrl: string,
  payload: { id: string; title: string | null; url: string; rawUrl: string; bytes: number }
): Promise<void> {
  try {
    if (!webhookUrl || webhookUrl.trim() === '') return;

    const safeTitle = (payload.title || 'Untitled').slice(0, 256);
    const embed = {
      title: '🤖 MCP link generated',
      color: 0x8b5cf6, // purple for MCP
      fields: [
        { name: 'Title', value: safeTitle, inline: false },
        { name: 'Doc ID', value: payload.id, inline: true },
        { name: 'Size', value: `${payload.bytes} bytes`, inline: true },
        { name: 'View', value: payload.url, inline: false },
        { name: 'Raw', value: payload.rawUrl, inline: false },
        { name: 'Source', value: 'MCP Server', inline: true },
        { name: 'Time', value: new Date().toISOString(), inline: true },
      ],
      timestamp: new Date().toISOString(),
    };

    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('Discord MCP notification failed:', {
        status: res.status,
        statusText: res.statusText,
        body: text.slice(0, 500),
      });
    }
  } catch (error) {
    console.error(
      'Discord MCP notification error:',
      error instanceof Error ? error.message : String(error)
    );
  }
}

export class OutframerMCP extends McpAgent {
  server = new McpServer({
    name: 'Outframer',
    version: '0.1.0',
  });

  async init() {
    // Tool: Generate preview link from markdown text
    this.server.tool(
      'generate_from_text',
      {
        markdown: z.string().describe('Markdown content to generate a preview for'),
      },
      async ({ markdown }) => {
        const env = this.env as Env;
        
        // Validate input
        const MAX_FILE_SIZE = 200 * 1024; // 200 KB
        if (!markdown || markdown.trim().length === 0) {
          return {
            content: [{ type: 'text', text: 'Error: No markdown content provided' }],
          };
        }

        if (markdown.length > MAX_FILE_SIZE) {
          return {
            content: [
              {
                type: 'text',
                text: `Error: File too large. Maximum size is ${MAX_FILE_SIZE / 1024} KB`,
              },
            ],
          };
        }

        // Generate ID and metadata
        const id = nanoid(10);
        const r2Key = `md/${id}.md`;
        const title = extractTitle(markdown);
        const now = new Date().toISOString();

        // Store in R2
        await env.DOCS_BUCKET.put(r2Key, markdown, {
          httpMetadata: {
            contentType: 'text/markdown',
          },
          customMetadata: {
            created_at: now,
          },
        });

        // Store metadata in D1
        await env.DB.prepare(
          'INSERT INTO docs (id, r2_key, content_type, bytes, created_at, sha256, title) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(id, r2Key, 'text/markdown', markdown.length, now, null, title).run();

        // Track analytics event (best-effort)
        try {
          await env.ANALYTICS.writeDataPoint({
            blobs: ['mcp_doc_create', id],
            doubles: [markdown.length],
            indexes: ['mcp-server'],
          });
        } catch (e) {
          console.error('Analytics error:', e);
        }

        const url = `https://outframer.com/v/${id}`;
        const rawUrl = `https://outframer.com/v/${id}/raw`;

        // Send Discord notification (optional, best-effort)
        const linkWebhookUrl = env.DISCORD_LINK_WEBHOOK_URL;
        if (linkWebhookUrl) {
          // Fire and forget - don't await
          sendDiscordLinkCreatedNotification(linkWebhookUrl, {
            id,
            title,
            url,
            rawUrl,
            bytes: markdown.length,
          }).catch(() => {});
        }

        return {
          content: [
            {
              type: 'text',
              text: `✓ Preview link generated successfully!\n\n📄 **${title || 'Untitled'}**\n🔗 View: ${url}\n📝 Raw: ${rawUrl}`,
            },
          ],
        };
      }
    );
  }
}

