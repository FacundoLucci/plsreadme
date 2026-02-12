# plsreadme-mcp

MCP server for [plsreadme.com](https://plsreadme.com) — share, update, and delete markdown documents as clean, readable web links.

Turn any markdown file or text into a shareable link, right from your editor. Edit and delete without leaving your workflow.

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

```
https://plsreadme.com/mcp
```

### add-mcp

```bash
npx add-mcp plsreadme-mcp
```

### OpenClaw

```bash
clawhub install plsreadme
```

## Tools

### `plsreadme_share_file`

Share a local file as a readable web link. Re-sharing the same file updates the existing link.

```
"Share README.md as a link"
"Share docs/architecture.md on plsreadme"
```

### `plsreadme_share_text`

Share markdown or plain text as a readable web link. Plain text is auto-structured.

```
"Share this markdown as a plsreadme link"
"Turn these notes into a shareable page"
```

### `plsreadme_update`

Update an existing document with new content.

```
"Update the shared PRD with the latest version"
"Refresh the plsreadme link for my API docs"
```

### `plsreadme_delete`

Delete a shared document permanently.

```
"Delete that plsreadme link I created"
"Remove the shared doc for meeting-notes.md"
```

### `plsreadme_list`

List all documents you've shared from this project.

```
"Show my plsreadme links"
"What docs have I shared?"
```

## .plsreadme Record File

The server tracks shared documents in a `.plsreadme` JSON file. This stores document IDs, URLs, and admin tokens needed for edit/delete.

**⚠️ Add `.plsreadme` to your `.gitignore`** — it contains admin tokens. The tool will warn you if it's missing.

## Prompts

- **`share-document`** — Guided flow to share content as a readable link
- **`refactor-and-share`** — Use your AI to refactor raw text into polished markdown, then share

## Limits

- Maximum file size: 200KB
- Links are permanent and publicly accessible
- 30 uploads per hour per IP

## Requirements

- Node.js 18+

## License

MIT
