#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const OUTFRAMER_API_URL = 'https://outframer.com/api/render';

interface OutframerResponse {
  id: string;
  url: string;
  raw_url: string;
}

// Extract title from markdown
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

// Upload markdown to Outframer
async function uploadMarkdown(markdown: string): Promise<OutframerResponse> {
  const response = await fetch(OUTFRAMER_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ markdown }),
  });

  if (!response.ok) {
    const error = await response.text().catch(() => response.statusText);
    throw new Error(`Failed to upload to Outframer: ${error}`);
  }

  return (await response.json()) as OutframerResponse;
}

// Create MCP server
const server = new McpServer({
  name: 'outframer-mcp',
  version: '0.1.0',
});

// Tool 1: Generate preview link from file path
server.registerTool(
  'generate_preview_link',
  {
    title: 'Generate Preview Link',
    description: 'Read a markdown file and generate a shareable Outframer preview link',
    inputSchema: {
      file_path: z.string().describe('Path to the markdown file (relative or absolute)'),
    },
    outputSchema: {
      url: z.string(),
      raw_url: z.string(),
      title: z.string().nullable(),
      id: z.string(),
    },
  },
  async ({ file_path }) => {
    try {
      // Resolve the file path
      const absolutePath = resolve(process.cwd(), file_path);
      
      // Read the file
      const markdown = readFileSync(absolutePath, 'utf-8');
      
      // Upload to Outframer
      const result = await uploadMarkdown(markdown);
      
      // Extract title
      const title = extractTitle(markdown);
      
      const output = {
        url: result.url,
        raw_url: result.raw_url,
        title,
        id: result.id,
      };
      
      return {
        content: [
          {
            type: 'text',
            text: `✓ Preview link generated successfully!\n\n📄 **${title || 'Untitled'}**\n🔗 View: ${result.url}\n📝 Raw: ${result.raw_url}`,
          },
        ],
        structuredContent: output,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to generate preview link: ${errorMessage}`);
    }
  }
);

// Tool 2: Generate preview link from text/markdown content
server.registerTool(
  'generate_from_text',
  {
    title: 'Generate Preview from Text',
    description: 'Generate a shareable Outframer preview link from markdown text',
    inputSchema: {
      markdown: z.string().describe('Markdown content to generate a preview for'),
    },
    outputSchema: {
      url: z.string(),
      raw_url: z.string(),
      title: z.string().nullable(),
      id: z.string(),
    },
  },
  async ({ markdown }) => {
    try {
      // Upload to Outframer
      const result = await uploadMarkdown(markdown);
      
      // Extract title
      const title = extractTitle(markdown);
      
      const output = {
        url: result.url,
        raw_url: result.raw_url,
        title,
        id: result.id,
      };
      
      return {
        content: [
          {
            type: 'text',
            text: `✓ Preview link generated successfully!\n\n📄 **${title || 'Untitled'}**\n🔗 View: ${result.url}\n📝 Raw: ${result.raw_url}`,
          },
        ],
        structuredContent: output,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to generate preview from text: ${errorMessage}`);
    }
  }
);

// Start the server with stdio transport
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  
  // Log to stderr (stdout is used for MCP protocol)
  console.error('Outframer MCP server running on stdio');
}

main().catch((error) => {
  console.error('Failed to start MCP server:', error);
  process.exit(1);
});


