import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpAgent } from 'agents/mcp';
import { z } from 'zod';
import { createHostedMcpDoc, getHostedMcpGrantProps, HostedMcpRateLimitError } from './mcp-create.ts';
import { DocValidationError } from './doc-pipeline.ts';
import type { HostedMcpGrantProps } from './mcp-oauth.ts';
import type { Env } from './types.ts';

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

const LOCAL_MCP_FALLBACK = 'npx -y plsreadme-mcp';

export class OutframerMCP extends McpAgent<Env, unknown, HostedMcpGrantProps> {
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
        const grant = getHostedMcpGrantProps(this.props);

        if (!grant) {
          return {
            content: [
              {
                type: 'text',
                text: [
                  '❌ Hosted remote MCP requires browser login before it can create owned docs.',
                  '',
                  'Reconnect this server from your editor to complete browser login, or configure a personal plsreadme API key if your client cannot finish interactive auth.',
                  `Local fallback: ${LOCAL_MCP_FALLBACK}`,
                ].join('\n'),
              },
            ],
            isError: true,
          };
        }

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

        let result;
        try {
          result = await createHostedMcpDoc(
            env,
            {
              markdown,
              title,
            },
            grant
          );
        } catch (error) {
          if (error instanceof DocValidationError) {
            return {
              content: [
                {
                  type: 'text',
                  text: `❌ ${error.failure.message}`,
                },
              ],
              isError: true,
            };
          }

          if (error instanceof HostedMcpRateLimitError) {
            return {
              content: [
                {
                  type: 'text',
                  text: [
                    `❌ ${error.message}`,
                    `Retry after about ${error.retryAfterSeconds} seconds.`,
                  ].join('\n'),
                },
              ],
              isError: true,
            };
          }

          throw error;
        }

        // Discord notification (best-effort, fire and forget)
        const linkWebhookUrl = env.DISCORD_LINK_WEBHOOK_URL;
        if (linkWebhookUrl) {
          sendDiscordLinkCreatedNotification(linkWebhookUrl, {
            id: result.id,
            title: result.title,
            url: result.url,
            rawUrl: result.rawUrl,
            bytes: result.bytes,
          }).catch(() => {});
        }

        return {
          content: [
            {
              type: 'text',
              text: [
                `✅ Shared successfully!`,
                ``,
                grant.authMode === 'remote_api_key'
                  ? `🔐 Owned by API key ${grant.apiKeyName ? `"${grant.apiKeyName}"` : grant.apiKeyId || grant.userId}`
                  : `🔐 Owned by ${grant.email || grant.userId}`,
                `🏷️ ${grant.source}`,
                `📄 ${result.title || 'Untitled'}`,
                `🔗 ${result.url}`,
                `📝 Raw: ${result.rawUrl}`,
              ].join('\n'),
            },
          ],
        };
      }
    );
  }
}

// v2 class alias to force a fresh Durable Object namespace migration when
// legacy namespace names are already reserved in the account.
export class OutframerMCPv2 extends OutframerMCP {}
