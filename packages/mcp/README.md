# Outframer MCP Server

Model Context Protocol server for [Outframer](https://outframer.com) - Generate shareable markdown preview links directly from Cursor.

## What is this?

This package lets you use Outframer as an MCP (Model Context Protocol) server in Cursor. You can ask Claude to generate preview links for your markdown files without leaving your editor.

## Installation & Setup

### Option 1: npx (Recommended - No Installation)

Add this to your Cursor settings at `~/.cursor/mcp.json`:

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

**Requirements:** Node.js 18+

### Option 2: Remote (Zero Install)

Add this to your Cursor settings at `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "outframer": {
      "url": "https://outframer.com/mcp"
    }
  }
}
```

**Requirements:** None! Works out of the box.

## Usage

Once configured, you can ask Claude in Cursor:

- *"Generate a preview link for README.md"*
- *"Create an Outframer link for this markdown file"*
- *"Share this document on Outframer"*

### Available Tools

#### `generate_preview_link`

Reads a markdown file and generates a shareable preview link.

**Input:**
- `file_path` (string): Path to the markdown file

**Output:**
- `url`: Rendered preview URL
- `raw_url`: Raw markdown URL
- `title`: Extracted title (or null)
- `id`: Document ID

#### `generate_from_text`

Generates a preview link from markdown text (e.g., selected text).

**Input:**
- `markdown` (string): Markdown content

**Output:**
- `url`: Rendered preview URL
- `raw_url`: Raw markdown URL
- `title`: Extracted title (or null)
- `id`: Document ID

## Examples

```
You: Generate a preview link for docs/api.md

Claude: I'll create a preview link for that file.
[calls generate_preview_link with file_path: "docs/api.md"]

✓ Preview link generated successfully!

📄 **API Documentation**
🔗 View: https://outframer.com/v/abc123xyz
📝 Raw: https://outframer.com/v/abc123xyz/raw
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Test locally
node dist/index.js
```

## License

MIT



