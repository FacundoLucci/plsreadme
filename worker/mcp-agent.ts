import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpAgent } from 'agents/mcp';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import type { Env } from './types';

const MAX_FILE_SIZE = 200 * 1024; // 200 KB

// Helper: Extract title from markdown
function extractTitle(markdown: string): string | null {
  for (const line of markdown.split('\n')) {
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
      color: 0x8b5cf6,
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
    name: 'plsreadme',
    version: '0.2.0',
  });

  async init() {
    this.server.tool(
      'plsreadme_share_text',
      `Share markdown text as a clean, readable web link on plsreadme.com.

Use when the user wants to share markdown content as a link others can read in the browser. Good for READMEs, PRDs, docs, proposals, notes, or any markdown content.

Pass the markdown content directly. If sharing a file, read it first and pass the content here. Returns a permanent, publicly accessible URL.`,
      {
        markdown: z
          .string()
          .describe('The markdown content to share. Will be rendered as a readable web page.'),
        title: z
          .string()
          .optional()
          .describe(
            'Optional title for the document. If omitted, the first H1 heading is used.'
          ),
      },
      async ({ markdown, title }) => {
        const env = this.env as Env;

        // Validate input
        if (!markdown || markdown.trim().length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: '❌ No markdown content provided. Pass the markdown text you want to share.',
              },
            ],
            isError: true,
          };
        }

        if (markdown.length > MAX_FILE_SIZE) {
          return {
            content: [
              {
                type: 'text',
                text: `❌ Content is too large (${Math.round(markdown.length / 1024)}KB). Maximum size is ${MAX_FILE_SIZE / 1024}KB. Try shortening the content.`,
              },
            ],
            isError: true,
          };
        }

        // Generate ID and metadata
        const id = nanoid(10);
        const r2Key = `md/${id}.md`;
        const extractedTitle = title || extractTitle(markdown);
        const now = new Date().toISOString();

        // Store in R2
        await env.DOCS_BUCKET.put(r2Key, markdown, {
          httpMetadata: { contentType: 'text/markdown' },
          customMetadata: { created_at: now },
        });

        // Store metadata in D1
        await env.DB.prepare(
          'INSERT INTO docs (id, r2_key, content_type, bytes, created_at, sha256, title) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
          .bind(id, r2Key, 'text/markdown', markdown.length, now, null, extractedTitle)
          .run();

        // Track analytics (best-effort)
        try {
          await env.ANALYTICS.writeDataPoint({
            blobs: ['mcp_doc_create', id],
            doubles: [markdown.length],
            indexes: ['mcp-server'],
          });
        } catch (e) {
          console.error('Analytics error:', e);
        }

        const url = `https://plsreadme.com/v/${id}`;
        const rawUrl = `https://plsreadme.com/v/${id}/raw`;

        // Discord notification (best-effort, fire and forget)
        const linkWebhookUrl = env.DISCORD_LINK_WEBHOOK_URL;
        if (linkWebhookUrl) {
          sendDiscordLinkCreatedNotification(linkWebhookUrl, {
            id,
            title: extractedTitle,
            url,
            rawUrl,
            bytes: markdown.length,
          }).catch(() => {});
        }

        return {
          content: [
            {
              type: 'text',
              text: [
                `✅ Shared successfully!`,
                ``,
                `📄 ${extractedTitle || 'Untitled'}`,
                `🔗 ${url}`,
                `📝 Raw: ${rawUrl}`,
              ].join('\n'),
            },
          ],
        };
      }
    );
  }
}
