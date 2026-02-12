#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import { resolve, basename, dirname } from 'path';

const PLSREADME_API = 'https://plsreadme.com/api/render';
const PLSREADME_VIEW = 'https://plsreadme.com/v';
const MAX_FILE_SIZE = 200 * 1024; // 200 KB
const RECORD_FILE = '.plsreadme';

// --- Types ---

interface CreateResponse {
  id: string;
  url: string;
  raw_url: string;
  admin_token: string;
}

interface DocRecord {
  id: string;
  url: string;
  raw_url: string;
  admin_token: string;
  title: string | null;
  source: string | null; // file path or null for text
  created_at: string;
}

// --- .plsreadme record file ---

function findRecordFile(): string {
  // Walk up from cwd to find existing .plsreadme, or default to cwd
  let dir = process.cwd();
  while (true) {
    const candidate = resolve(dir, RECORD_FILE);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(process.cwd(), RECORD_FILE);
}

function loadRecords(filePath: string): DocRecord[] {
  if (!existsSync(filePath)) return [];
  try {
    const raw = readFileSync(filePath, 'utf-8').trim();
    if (!raw) return [];
    return JSON.parse(raw) as DocRecord[];
  } catch {
    return [];
  }
}

function saveRecord(record: DocRecord): void {
  const filePath = findRecordFile();
  const records = loadRecords(filePath);
  // Replace if same id exists
  const idx = records.findIndex((r) => r.id === record.id);
  if (idx >= 0) records[idx] = record;
  else records.push(record);
  writeFileSync(filePath, JSON.stringify(records, null, 2) + '\n');
}

function getRecordById(id: string): DocRecord | undefined {
  return loadRecords(findRecordFile()).find((r) => r.id === id);
}

function getRecordBySource(source: string): DocRecord | undefined {
  const abs = resolve(process.cwd(), source);
  return loadRecords(findRecordFile()).find(
    (r) => r.source === source || r.source === abs
  );
}

function removeRecord(id: string): void {
  const filePath = findRecordFile();
  const records = loadRecords(filePath).filter((r) => r.id !== id);
  writeFileSync(filePath, JSON.stringify(records, null, 2) + '\n');
}

function checkGitignore(): string | null {
  const cwd = process.cwd();
  const gitignorePath = resolve(cwd, '.gitignore');
  if (!existsSync(gitignorePath)) {
    return `⚠️ No .gitignore found. Create one and add \`.plsreadme\` to keep your admin tokens out of version control.`;
  }
  const content = readFileSync(gitignorePath, 'utf-8');
  if (!content.includes('.plsreadme')) {
    return `⚠️ \`.plsreadme\` is not in your .gitignore. Add it to keep admin tokens private:\n\necho ".plsreadme" >> .gitignore`;
  }
  return null;
}

// --- Helpers ---

function extractTitle(markdown: string): string | null {
  for (const line of markdown.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('# ')) return trimmed.substring(2).trim();
  }
  return null;
}

function looksLikeMarkdown(input: string): boolean {
  return /(^|\n)\s{0,3}(#|>|-|\*|\d+\.|```|\|.+\|)/m.test(input) ||
    /\[[^\]]+\]\([^\)]+\)/.test(input);
}

function coerceToMarkdown(input: string): string {
  const text = input.trim();
  if (!text) return text;
  if (looksLikeMarkdown(text)) return text;

  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return text;

  const first = lines[0];
  const isLikelyTitle = first.length <= 80 && !/[.!?]$/.test(first);
  const body = isLikelyTitle ? lines.slice(1) : lines;

  const out: string[] = [];
  if (isLikelyTitle) out.push(`# ${first}`);

  for (const line of body) {
    if (/^[-*•]\s+/.test(line)) {
      out.push(`- ${line.replace(/^[-*•]\s+/, '')}`);
    } else if (/^\d+[\.)]\s+/.test(line)) {
      out.push(line.replace(/^(\d+)[\.)]\s+/, '$1. '));
    } else {
      out.push(line);
    }
  }

  return out.join('\n\n');
}

async function apiCreate(markdown: string): Promise<CreateResponse> {
  const response = await fetch(PLSREADME_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ markdown }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => response.statusText);
    if (response.status === 413) throw new Error(`Content too large (max ~200KB). ${body}`);
    if (response.status >= 500) throw new Error(`plsreadme.com unavailable (HTTP ${response.status}). Try again.`);
    throw new Error(`Upload failed (HTTP ${response.status}): ${body}`);
  }

  return (await response.json()) as CreateResponse;
}

async function apiUpdate(id: string, token: string, markdown: string): Promise<void> {
  const response = await fetch(`${PLSREADME_VIEW}/${id}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ markdown }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => response.statusText);
    throw new Error(`Update failed (HTTP ${response.status}): ${body}`);
  }
}

async function apiDelete(id: string, token: string): Promise<void> {
  const response = await fetch(`${PLSREADME_VIEW}/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => response.statusText);
    throw new Error(`Delete failed (HTTP ${response.status}): ${body}`);
  }
}

// --- Response formatters ---

function formatSuccess(title: string | null, url: string, rawUrl: string, extra?: string) {
  const lines = [
    `✅ Shared successfully!`,
    ``,
    `📄 ${title || 'Untitled'}`,
    `🔗 ${url}`,
    `📝 Raw: ${rawUrl}`,
  ];
  if (extra) lines.push('', extra);
  return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
}

function formatError(message: string) {
  return { content: [{ type: 'text' as const, text: `❌ ${message}` }], isError: true };
}

// --- MCP Server ---

const server = new McpServer({
  name: 'plsreadme',
  version: '0.5.0',
});

// Tool: Share a file
server.tool(
  'plsreadme_share_file',
  `Share a local markdown file as a clean, readable web link on plsreadme.com.

Reads the file, uploads it, and returns a permanent shareable URL. If the file was previously shared, updates the existing link instead of creating a new one.

Tracks links in a local .plsreadme file for future edits and deletes.`,
  {
    file_path: z.string().describe('Path to the markdown file to share (relative or absolute).'),
  },
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
      if (code === 'ENOENT') return formatError(`File not found: ${file_path}\nTried: ${absolutePath}`);
      if (code === 'EACCES') return formatError(`Permission denied: ${file_path}`);
      return formatError(`Could not read file: ${(err as Error).message}`);
    }

    if (markdown.length > MAX_FILE_SIZE) return formatError(`File too large (${Math.round(markdown.length / 1024)}KB). Max ${MAX_FILE_SIZE / 1024}KB.`);
    if (markdown.trim().length === 0) return formatError(`File is empty: ${file_path}`);

    try {
      // Check if already shared — update instead of creating new
      const existing = getRecordBySource(file_path) || getRecordBySource(absolutePath);
      if (existing) {
        await apiUpdate(existing.id, existing.admin_token, markdown);
        const title = extractTitle(markdown) || basename(file_path, '.md');
        existing.title = title;
        saveRecord(existing);
        return formatSuccess(title, existing.url, existing.raw_url, '♻️ Updated existing link (same URL).');
      }

      const result = await apiCreate(markdown);
      const title = extractTitle(markdown) || basename(file_path, '.md');

      saveRecord({
        id: result.id,
        url: result.url,
        raw_url: result.raw_url,
        admin_token: result.admin_token,
        title,
        source: file_path,
        created_at: new Date().toISOString(),
      });

      const gitWarn = checkGitignore();
      return formatSuccess(title, result.url, result.raw_url, gitWarn || undefined);
    } catch (err) {
      return formatError((err as Error).message);
    }
  }
);

// Tool: Share text
server.tool(
  'plsreadme_share_text',
  `Share text as a clean, readable web link on plsreadme.com.

Accepts markdown or plain text. Plain text is auto-structured into markdown before upload. Returns a permanent shareable URL.

Tracks links in a local .plsreadme file for future edits and deletes.`,
  {
    markdown: z.string().describe('Content to share. Markdown preferred, but plain text accepted.'),
    title: z.string().optional().describe('Optional title (auto-detected from first H1 if omitted).'),
  },
  {
    title: 'Share Text',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  async ({ markdown, title }) => {
    if (!markdown || markdown.trim().length === 0) return formatError('No content provided.');
    if (markdown.length > MAX_FILE_SIZE) return formatError(`Content too large (${Math.round(markdown.length / 1024)}KB). Max ${MAX_FILE_SIZE / 1024}KB.`);

    try {
      const prepared = coerceToMarkdown(markdown);
      const result = await apiCreate(prepared);
      const displayTitle = title || extractTitle(prepared);

      saveRecord({
        id: result.id,
        url: result.url,
        raw_url: result.raw_url,
        admin_token: result.admin_token,
        title: displayTitle,
        source: null,
        created_at: new Date().toISOString(),
      });

      const gitWarn = checkGitignore();
      return formatSuccess(displayTitle, result.url, result.raw_url, gitWarn || undefined);
    } catch (err) {
      return formatError((err as Error).message);
    }
  }
);

// Tool: Update an existing doc
server.tool(
  'plsreadme_update',
  `Update an existing plsreadme document with new content.

Requires either the document ID or the original file path. Looks up the admin token from the local .plsreadme record file.`,
  {
    id: z.string().optional().describe('Document ID to update.'),
    file_path: z.string().optional().describe('Original file path (looks up the linked doc).'),
    markdown: z.string().describe('New markdown content.'),
  },
  {
    title: 'Update Document',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  async ({ id, file_path, markdown }) => {
    if (!markdown || markdown.trim().length === 0) return formatError('No content provided.');

    let record: DocRecord | undefined;
    if (id) record = getRecordById(id);
    else if (file_path) record = getRecordBySource(file_path) || getRecordBySource(resolve(process.cwd(), file_path));

    if (!record) return formatError('Document not found in .plsreadme records. Provide the correct ID or file path.');

    try {
      const prepared = coerceToMarkdown(markdown);
      await apiUpdate(record.id, record.admin_token, prepared);
      const title = extractTitle(prepared) || record.title;
      record.title = title;
      saveRecord(record);
      return formatSuccess(title, record.url, record.raw_url, '♻️ Updated successfully.');
    } catch (err) {
      return formatError((err as Error).message);
    }
  }
);

// Tool: Delete a doc
server.tool(
  'plsreadme_delete',
  `Delete a plsreadme document permanently.

Requires either the document ID or the original file path. Looks up the admin token from the local .plsreadme record file.`,
  {
    id: z.string().optional().describe('Document ID to delete.'),
    file_path: z.string().optional().describe('Original file path (looks up the linked doc).'),
  },
  {
    title: 'Delete Document',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  async ({ id, file_path }) => {
    let record: DocRecord | undefined;
    if (id) record = getRecordById(id);
    else if (file_path) record = getRecordBySource(file_path) || getRecordBySource(resolve(process.cwd(), file_path));

    if (!record) return formatError('Document not found in .plsreadme records. Provide the correct ID or file path.');

    try {
      await apiDelete(record.id, record.admin_token);
      removeRecord(record.id);
      return {
        content: [{
          type: 'text' as const,
          text: `🗑️ Deleted: ${record.title || record.id}\n\nThe link ${record.url} is no longer accessible.`,
        }],
      };
    } catch (err) {
      return formatError((err as Error).message);
    }
  }
);

// Tool: List tracked docs
server.tool(
  'plsreadme_list',
  `List all plsreadme documents tracked in the local .plsreadme file.

Shows document IDs, titles, URLs, and source files.`,
  {},
  {
    title: 'List Shared Documents',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async () => {
    const records = loadRecords(findRecordFile());
    if (records.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No documents tracked yet. Share something first!' }] };
    }

    const lines = records.map((r, i) => [
      `${i + 1}. **${r.title || 'Untitled'}** (${r.id})`,
      `   🔗 ${r.url}`,
      r.source ? `   📁 ${r.source}` : '   📝 (shared from text)',
      `   📅 ${r.created_at}`,
    ].join('\n'));

    return { content: [{ type: 'text' as const, text: lines.join('\n\n') }] };
  }
);

// Prompt: Share a document
server.prompt(
  'share-document',
  'Share markdown or plain text as a readable web link',
  {
    content: z.string().optional().describe('Content or file path to share'),
  },
  ({ content }) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: content
          ? `Share this as a plsreadme link:\n\n${content}`
          : 'Help me share content as a readable web link using plsreadme.',
      },
    }],
  })
);

// Prompt: Refactor and share
server.prompt(
  'refactor-and-share',
  'Use your own model to refactor raw text into clean markdown, then share with plsreadme',
  {
    content: z.string().describe('Raw text, notes, or mixed content to refactor and share'),
    style: z.string().optional().describe('Optional style target, e.g. "PRD", "README", "meeting notes"'),
  },
  ({ content, style }) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: [
          'Refactor the following content into polished markdown using your own reasoning.',
          style ? `Target style: ${style}` : 'Target style: clean readable document',
          'Then call plsreadme_share_text with the final markdown.',
          '',
          content,
        ].join('\n'),
      },
    }],
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
    contents: [{
      uri: 'plsreadme://api-info',
      mimeType: 'text/plain',
      text: [
        'plsreadme API',
        '=============',
        '',
        'Create: POST https://plsreadme.com/api/render',
        '  Body: { "markdown": "..." }',
        '  Response: { "id", "url", "raw_url", "admin_token" }',
        '',
        'Update: PUT https://plsreadme.com/v/:id',
        '  Headers: Authorization: Bearer <admin_token>',
        '  Body: { "markdown": "..." }',
        '  Behavior: increments doc version; previous markdown archived at /v/:id/raw?version=<oldVersion>.',
        '',
        'Delete: DELETE https://plsreadme.com/v/:id',
        '  Headers: Authorization: Bearer <admin_token>',
        '  Behavior: permanently deletes current doc and comments (archived versions are not part of the public API contract).',
        '',
        'Limits:',
        '- Max content size: 200KB',
        '- Upload rate: 30/hour per IP',
        '- Links are permanent and publicly accessible',
        '- No authentication required for creation',
        '',
        'Website: https://plsreadme.com',
      ].join('\n'),
    }],
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
