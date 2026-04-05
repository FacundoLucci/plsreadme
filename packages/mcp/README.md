# plsreadme-mcp

MCP server for [plsreadme.com](https://plsreadme.com) — share, update, and delete markdown documents as clean, readable web links.

Turn any markdown file or text into a shareable link, right from your editor. Edit and delete without leaving your workflow.

## Auth And Rollout Status

Recommendation order:

1. try plsreadme in the browser first
2. use hosted remote MCP with browser login when that client flow is available
3. use API key auth as the compatibility fallback

Current rollout state:

- hosted remote MCP at `https://plsreadme.com/mcp` supports browser login in compatible clients
- hosted remote MCP also accepts a personal API key bearer header as the compatibility fallback
- the local `npx -y plsreadme-mcp` package now expects `PLSREADME_API_KEY` by default for owned creates
- legacy anonymous local mode still exists, but only with explicit `PLSREADME_ALLOW_ANONYMOUS=1`
- website demos remain the fastest zero-setup path

## Quick Install

### Claude Code

```bash
claude mcp add --transport stdio \
  --env PLSREADME_API_KEY=$PLSREADME_API_KEY \
  plsreadme -- npx -y plsreadme-mcp
```

### Cursor

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "plsreadme": {
      "command": "npx",
      "args": ["-y", "plsreadme-mcp"],
      "env": {
        "PLSREADME_API_KEY": "${env:PLSREADME_API_KEY}"
      }
    }
  }
}
```

### VS Code

Add to your VS Code settings (`settings.json`):

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "plsreadme-api-key",
      "description": "plsreadme personal API key",
      "password": true
    }
  ],
  "servers": {
    "plsreadme": {
      "command": "npx",
      "args": ["-y", "plsreadme-mcp"],
      "env": {
        "PLSREADME_API_KEY": "${input:plsreadme-api-key}"
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
      "args": ["-y", "plsreadme-mcp"],
      "env": {
        "PLSREADME_API_KEY": "<paste-your-personal-api-key>"
      }
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
      "args": ["-y", "plsreadme-mcp"],
      "env": {
        "PLSREADME_API_KEY": "${env:PLSREADME_API_KEY}"
      }
    }
  }
}
```

### Hosted Remote MCP (supported clients)

Supported clients can use the hosted endpoint directly:

Claude Code:
```bash
claude mcp add --transport http plsreadme https://plsreadme.com/mcp
```

Cursor:
```json
{
  "mcpServers": {
    "plsreadme": {
      "url": "https://plsreadme.com/mcp"
    }
  }
}
```

Hosted remote lifecycle:

- access token TTL is about `1 hour`
- refresh token TTL is about `30 days`
- reconnecting the same client replaces the older grant
- signing out of the website does not automatically revoke an existing editor grant
- `GET /api/auth/mcp-grants` lists current hosted editor grants
- `DELETE /api/auth/mcp-grants/:grantId` revokes one hosted editor grant

Rollout note:

- if browser login is unavailable in your client, use the personal API key fallback below
- website demos remain the fastest zero-setup path while you decide which editor path you want

### Hosted Remote API Key fallback

Create a personal API key from [https://plsreadme.com/my-links](https://plsreadme.com/my-links) first.

Claude Code:
```bash
claude mcp add --transport http \
  --header "Authorization: Bearer $PLSREADME_API_KEY" \
  plsreadme-api https://plsreadme.com/mcp
```

Cursor / generic remote JSON:
```json
{
  "mcpServers": {
    "plsreadme-api": {
      "url": "https://plsreadme.com/mcp",
      "headers": {
        "Authorization": "Bearer ${env:PLSREADME_API_KEY}"
      }
    }
  }
}
```

Notes:

- local package creates are owned when `PLSREADME_API_KEY` is present
- local package anonymous mode now requires `PLSREADME_ALLOW_ANONYMOUS=1`
- run `plsreadme_auth_status` inside your client to confirm which mode the local package is using

## Migration From Older Anonymous Local MCP Setups

If you already installed `plsreadme-mcp` before owned local auth existed:

1. Create a personal key from [https://plsreadme.com/my-links](https://plsreadme.com/my-links).
2. Add `PLSREADME_API_KEY` to your MCP config.
3. Remove any silent anonymous assumptions from scripts or shared config snippets.
4. Use `PLSREADME_ALLOW_ANONYMOUS=1` only when you intentionally want legacy anonymous behavior.

Compatibility summary:

- hosted remote login first where the client supports it
- remote API key headers second when browser auth is missing
- local stdio with `PLSREADME_API_KEY` for clients like Claude Desktop

### add-mcp

```bash
npx add-mcp plsreadme-mcp
```

### OpenClaw

```bash
clawhub install plsreadme
```

## Docker

Build and run the stdio MCP server in a clean container:

```bash
docker build -t plsreadme-mcp:local -f Dockerfile .
docker run --rm -i plsreadme-mcp:local
```

Notes:
- Run the command from the repository root (where `Dockerfile` lives).
- The containerized MCP server uses stdio and does not require env vars.

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

### `plsreadme_auth_status`

Show whether the local MCP server is using a personal API key or explicit legacy anonymous mode.

```
"How is plsreadme authenticated right now?"
"Show my local plsreadme auth status"
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
