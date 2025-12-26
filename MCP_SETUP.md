# Outframer MCP Integration

Use Outframer as a Model Context Protocol (MCP) server in Cursor to generate shareable markdown preview links directly from your editor.

## Quick Start

Choose one of two options:

| Method                   | Setup                     | Requirements |
| ------------------------ | ------------------------- | ------------ |
| **Remote (Recommended)** | Just add URL to config    | None         |
| **Local (npx)**          | Add npx command to config | Node.js 18+  |

---

## Option 1: Remote MCP (Recommended) ⭐

The easiest way to get started - uses the `mcp-remote` proxy to connect to Outframer's hosted MCP server.

### Configuration

Add this to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "outframer": {
      "command": "npx",
      "args": ["mcp-remote", "https://outframer.com/sse"]
    }
  }
}
```

### How it Works

- The `mcp-remote` package acts as a local proxy between Cursor and the remote MCP server
- Your markdown content is sent to the Outframer server via Server-Sent Events (SSE)
- No local files are accessed - content must be sent as text

### Requirements

- Node.js 18+ (for npx)
- Internet connection

### Limitations

- Only the `generate_from_text` tool is available (cannot read local files directly)
- Content must be provided as text/selection

---

## Option 2: Local MCP Package

Run the MCP server locally for full functionality including direct file reading.

### Configuration

Add this to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "outframer": {
      "command": "npx",
      "args": ["-y", "outframer-mcp"]
    }
  }
}
```

### Requirements

- Node.js 18 or higher
- Internet connection (for initial download and API calls)

### Advantages

- Can read local files directly
- Both `generate_preview_link` and `generate_from_text` tools available
- Runs entirely on your machine

---

## Usage in Cursor

Once configured, you can ask Claude:

**Examples:**

- _"Generate a preview link for README.md"_
- _"Create an Outframer link for this markdown"_
- _"Share this document on Outframer"_
- _"Generate a preview for the selected markdown"_

### Available Tools

#### `generate_preview_link` (Local npx only)

Reads a markdown file from your filesystem and generates a preview link.

**Parameters:**

- `file_path` (string): Path to the markdown file (relative or absolute)

**Returns:**

- `url`: Rendered preview URL
- `raw_url`: Raw markdown download URL
- `title`: Extracted document title (from first `# heading`)
- `id`: Unique document ID

**Example:**

```
You: Generate a preview link for docs/api.md

Claude: ✓ Preview link generated successfully!

📄 **API Documentation**
🔗 View: https://outframer.com/v/abc123xyz
📝 Raw: https://outframer.com/v/abc123xyz/raw
```

#### `generate_from_text` (Both options)

Generates a preview link from markdown text (e.g., selected text or inline markdown).

**Parameters:**

- `markdown` (string): Markdown content

**Returns:**

- `url`: Rendered preview URL
- `raw_url`: Raw markdown download URL
- `title`: Extracted document title
- `id`: Unique document ID

**Example:**

```
You: Create a preview link for this markdown:
# Hello World
This is a test document.

Claude: ✓ Preview link generated successfully!

📄 **Hello World**
🔗 View: https://outframer.com/v/xyz789abc
📝 Raw: https://outframer.com/v/xyz789abc/raw
```

---

## Troubleshooting

### Cursor doesn't recognize the MCP server

1. Make sure `~/.cursor/mcp.json` exists and has valid JSON
2. Restart Cursor after adding the configuration
3. Check the MCP logs in Cursor's output panel

### "Command not found: npx" (Local option)

Install Node.js from [nodejs.org](https://nodejs.org)

### Rate limiting

Outframer has rate limits:

- **30 uploads per hour per IP address**
- **Maximum file size: 200 KB**

If you hit the rate limit, wait an hour or consider self-hosting Outframer.

---

## Development

### Testing the Local Package

```bash
cd packages/mcp
npm install
npm run build
node dist/index.js
```

### Testing the Remote Endpoint

```bash
# Test the /mcp endpoint locally
npm run dev

# In another terminal
curl -X POST http://localhost:8788/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {}
  }'
```

---

## Publishing the NPM Package

```bash
cd packages/mcp
npm run build
npm publish
```

---

## How It Works

### Architecture

```
┌─────────────────┐
│   Cursor IDE    │
│    (Claude)     │
└────────┬────────┘
         │
    ┌────┴────┐
    │   MCP   │
    │Protocol │
    └────┬────┘
         │
    ┌────┴──────────────────┐
    │                       │
┌───▼────┐          ┌──────▼───────┐
│ Remote │          │ Local (npx)  │
│  /mcp  │          │   Package    │
└───┬────┘          └──────┬───────┘
    │                      │
    │   ┌──────────────────┘
    │   │
┌───▼───▼───────────┐
│ Outframer API     │
│ /api/render       │
└───────────────────┘
    │
┌───▼───────────────┐
│  R2 + D1 Storage  │
└───────────────────┘
```

### What happens when you use it:

1. **You ask Claude** to generate a preview link
2. **Claude calls the MCP tool** (via JSON-RPC)
3. **MCP server processes** the markdown:
   - Local: Reads file from disk
   - Remote: Receives text from Cursor
4. **Uploads to Outframer API** at `/api/render`
5. **Outframer stores** in R2 (content) and D1 (metadata)
6. **Returns shareable URL** to you in Cursor

---

## License

MIT

---

**Last updated:** 2024-12-22
