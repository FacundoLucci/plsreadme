# plsreadme-mcp

MCP server for [plsreadme.com](https://plsreadme.com) — share markdown files and text as clean, readable web links.

Turn any markdown file or text into a shareable link, right from your editor.

## Quick Install

### Claude Code

```bash
claude mcp add plsreadme -- npx -y plsreadme-mcp
```

### Cursor

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "plsreadme": {
      "command": "npx",
      "args": ["-y", "plsreadme-mcp"]
    }
  }
}
```

### VS Code

Add to your VS Code settings (`settings.json`):

```json
{
  "mcp": {
    "servers": {
      "plsreadme": {
        "command": "npx",
        "args": ["-y", "plsreadme-mcp"]
      }
    }
  }
}
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "plsreadme": {
      "command": "npx",
      "args": ["-y", "plsreadme-mcp"]
    }
  }
}
```

### Windsurf

Add to your Windsurf MCP config:

```json
{
  "mcpServers": {
    "plsreadme": {
      "command": "npx",
      "args": ["-y", "plsreadme-mcp"]
    }
  }
}
```

### Remote MCP (no install needed)

Some clients support remote MCP servers. Use the URL directly:

```
https://plsreadme.com/mcp
```

### add-mcp

```bash
npx add-mcp plsreadme-mcp
```

## Tools

### `plsreadme_share_file`

Share a local markdown file as a readable web link.

```
"Share README.md as a link"
"Generate a plsreadme link for docs/architecture.md"
```

**Parameters:**
- `file_path` (string, required) — Path to the markdown file

### `plsreadme_share_text`

Share markdown text as a readable web link.

```
"Share this markdown as a plsreadme link"
"Turn this PRD into a shareable link"
```

**Parameters:**
- `markdown` (string, required) — Markdown content to share
- `title` (string, optional) — Document title (auto-detected from first H1 if omitted)

## Use Cases

- **Share READMEs** — Send a colleague a nicely rendered README link
- **Share PRDs & proposals** — Turn a doc into a link for stakeholders
- **Share meeting notes** — Quick link to formatted notes
- **Share code docs** — API docs, architecture decisions, changelogs

## Limits

- Maximum file size: 200KB
- Links are permanent and publicly accessible

## Requirements

- Node.js 18+

## Development

```bash
npm install
npm run build
```

## License

MIT
