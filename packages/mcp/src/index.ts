#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync } from 'fs';
import { resolve, basename } from 'path';

const PLSREADME_API_URL = 'https://plsreadme.com/api/render';
const MAX_FILE_SIZE = 200 * 1024; // 200 KB

interface PlsreadmeResponse {
  id: string;
  url: string;
  raw_url: string;
}

function extractTitle(markdown: string): string | null {
  for (const line of markdown.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('# ')) {
      return trimmed.substring(2).trim();
    }
  }
  return null;
}

async function uploadMarkdown(markdown: string): Promise<PlsreadmeResponse> {
  const response = await fetch(PLSREADME_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ markdown }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => response.statusText);
    if (response.status === 413) {
      throw new Error(
        `Content too large for the API. Try shortening your markdown (max ~200KB). Server said: ${body}`
      );
    }
    if (response.status >= 500) {
      throw new Error(
        `plsreadme.com is temporarily unavailable (HTTP ${response.status}). Try again in a moment.`
      );
    }
    throw new Error(`Upload failed (HTTP ${response.status}): ${body}`);
  }

  return (await response.json()) as PlsreadmeResponse;
}

function formatSuccess(title: string | null, url: string, rawUrl: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text: [
          `✅ Shared successfully!`,
          ``,
          `📄 ${title || 'Untitled'}`,
          `🔗 ${url}`,
          `📝 Raw: ${rawUrl}`,
        ].join('\n'),
      },
    ],
  };
}

function formatError(message: string) {
  return {
    content: [{ type: 'text' as const, text: `❌ ${message}` }],
    isError: true,
  };
}

// Create MCP server
const server = new McpServer({
  name: 'plsreadme',
  version: '0.3.0',
});

// Tool 1: Share a local markdown file as a readable web link
server.tool(
  'plsreadme_share_file',
  `Share a local markdown file as a clean, readable web link on plsreadme.com.

Use when the user wants to share a markdown file (README, PRD, doc, proposal, notes) as a link others can read in the browser. Reads the file from disk and uploads it.

Returns the shareable URL. The link is permanent and publicly accessible.`,
  {
    file_path: z
      .string()
      .describe(
        'Path to the markdown file to share. Can be relative (resolved from cwd) or absolute.'
      ),
  },
  // Annotations
  {
    title: 'Share Markdown File',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  async ({ file_path }) => {
    const absolutePath = resolve(process.cwd(), file_path);

    let markdown: string;
    try {
      markdown = readFileSync(absolutePath, 'utf-8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return formatError(
          `File not found: ${file_path}\n\nMake sure the path is correct. Tried: ${absolutePath}`
        );
      }
      if (code === 'EACCES') {
        return formatError(`Permission denied reading: ${file_path}`);
      }
      return formatError(`Could not read file: ${(err as Error).message}`);
    }

    if (markdown.length > MAX_FILE_SIZE) {
      return formatError(
        `File is too large (${Math.round(markdown.length / 1024)}KB). Maximum size is ${MAX_FILE_SIZE / 1024}KB. Try splitting the document or removing large embedded content.`
      );
    }

    if (markdown.trim().length === 0) {
      return formatError(`File is empty: ${file_path}`);
    }

    try {
      const result = await uploadMarkdown(markdown);
      const title = extractTitle(markdown) || basename(file_path, '.md');
      return formatSuccess(title, result.url, result.raw_url);
    } catch (err) {
      return formatError((err as Error).message);
    }
  }
);

// Tool 2: Share markdown text as a readable web link
server.tool(
  'plsreadme_share_text',
  `Share markdown text as a clean, readable web link on plsreadme.com.

Use when the user wants to share markdown content (not a file) as a link. Good for generated docs, formatted text, or content composed in the conversation.

Accepts raw markdown as a string. Returns the shareable URL.`,
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
  // Annotations
  {
    title: 'Share Markdown Text',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  async ({ markdown, title }) => {
    if (!markdown || markdown.trim().length === 0) {
      return formatError(
        'No markdown content provided. Pass the markdown text you want to share.'
      );
    }

    if (markdown.length > MAX_FILE_SIZE) {
      return formatError(
        `Content is too large (${Math.round(markdown.length / 1024)}KB). Maximum size is ${MAX_FILE_SIZE / 1024}KB. Try shortening the content.`
      );
    }

    try {
      const result = await uploadMarkdown(markdown);
      const displayTitle = title || extractTitle(markdown);
      return formatSuccess(displayTitle, result.url, result.raw_url);
    } catch (err) {
      return formatError((err as Error).message);
    }
  }
);

// Prompt: Share a document
server.prompt(
  'share-document',
  'Share a markdown file or text as a readable web link',
  {
    content: z
      .string()
      .optional()
      .describe('Markdown content or file path to share'),
  },
  ({ content }) => ({
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: content
            ? `Share this as a plsreadme link:\n\n${content}`
            : 'Help me share a markdown document as a readable web link using plsreadme.',
        },
      },
    ],
  })
);

// Resource: API info
server.resource(
  'plsreadme-api',
  'plsreadme://api-info',
  {
    description: 'plsreadme API information and limits',
    mimeType: 'text/plain',
  },
  async () => ({
    contents: [
      {
        uri: 'plsreadme://api-info',
        mimeType: 'text/plain',
        text: [
          'plsreadme API',
          '=============',
          '',
          'Endpoint: https://plsreadme.com/api/render',
          'Method: POST',
          'Content-Type: application/json',
          'Body: { "markdown": "<markdown content>" }',
          '',
          'Limits:',
          '- Max content size: 200KB',
          '- Links are permanent and publicly accessible',
          '- No authentication required',
          '',
          'Response: { "id": "...", "url": "https://plsrd.me/...", "raw_url": "https://plsreadme.com/v/..." }',
          '',
          'Website: https://plsreadme.com',
          'MCP Setup: https://plsreadme.com/mcp-setup',
        ].join('\n'),
      },
    ],
  })
);

// Start
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('plsreadme MCP server running on stdio');
}

main().catch((error) => {
  console.error('Failed to start plsreadme MCP server:', error);
  process.exit(1);
});
