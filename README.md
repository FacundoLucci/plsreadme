<p align="center">
  <img src="https://plsreadme.com/icon.png" alt="plsreadme" width="80" />
</p>

<h1 align="center">plsreadme</h1>

<p align="center">
  <strong>Paste markdown. Get a beautiful, shareable link. Done.</strong>
</p>

<p align="center">
  <a href="https://plsreadme.com">Website</a> ·
  <a href="https://www.npmjs.com/package/plsreadme-mcp">MCP Package</a> ·
  <a href="https://github.com/FacundoLucci/plsreadme/issues/new?labels=feature-request">Request a Feature</a>
</p>

<p align="center">
  <img src="https://img.shields.io/npm/v/plsreadme-mcp?style=flat-square&color=111827" alt="npm version" />
  <img src="https://img.shields.io/badge/Cloudflare_Workers-deployed-F38020?style=flat-square&logo=cloudflare&logoColor=white" alt="Cloudflare Workers" />
  <img src="https://img.shields.io/badge/MCP-compatible-10b981?style=flat-square" alt="MCP compatible" />
  <img src="https://img.shields.io/github/license/FacundoLucci/plsreadme?style=flat-square" alt="License" />
</p>

---

## The Problem

You wrote a README, a PRD, meeting notes, or an API doc in markdown. Now you need to share it with someone who doesn't have a markdown renderer, doesn't use GitHub, or just needs a clean link they can open in a browser.

**plsreadme** turns any markdown into a permanent, beautifully rendered web page in one step. No accounts. No sign-ups. No friction.

## ✨ Features

- **Instant sharing** — Paste markdown or upload a file, get a `plsrd.me` link
- **Beautiful rendering** — Clean typography, dark mode, mobile-responsive
- **Inline comments** — Readers can click any paragraph and leave feedback
- **AI auto-formatting** — Throw raw text at it; it comes out as clean markdown
- **MCP server** — Share docs directly from Claude, Cursor, VS Code, or any MCP client
- **OpenClaw skill** — Available on [ClawHub](https://clawhub.com) for AI agent workflows
- **Short links** — Every doc gets a compact `plsrd.me/v/xxx` URL
- **Raw access** — Download the original `.md` file from any shared link
- **Zero config** — No API keys needed for basic usage

## 🚀 Quick Start

### Web

Go to [plsreadme.com](https://plsreadme.com), paste your markdown, click share.

### API

```bash
curl -X POST https://plsreadme.com/api/render \
  -H "Content-Type: application/json" \
  -d '{"markdown": "# Hello World\n\nThis is my doc."}'
```

```json
{
  "id": "abc123def456",
  "url": "https://plsreadme.com/v/abc123def456",
  "raw_url": "https://plsreadme.com/v/abc123def456/raw",
  "admin_token": "sk_..."
}
```

Save the `admin_token` — you'll need it to edit or delete:

```bash
# Update
curl -X PUT https://plsreadme.com/v/abc123def456 \
  -H "Authorization: Bearer sk_..." \
  -H "Content-Type: application/json" \
  -d '{"markdown": "# Updated content"}'

# Delete
curl -X DELETE https://plsreadme.com/v/abc123def456 \
  -H "Authorization: Bearer sk_..."
```

### MCP (AI Editors)

Connect your editor to plsreadme and share docs with natural language:

> *"Share this README as a plsreadme link"*
> *"Turn my PRD into a shareable page"*
> *"Make these meeting notes into a readable link"*

## 🔌 MCP Setup

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
Add to your `settings.json`:
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

### Remote MCP (zero install)
Some clients support remote MCP endpoints directly:
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

## 🛠 MCP Tools

| Tool | What it does |
|------|-------------|
| `plsreadme_share_file` | Share a local file by path → returns shareable link. Re-sharing updates the same link. |
| `plsreadme_share_text` | Share markdown or plain text directly → returns shareable link |
| `plsreadme_update` | Update an existing doc with new content (by ID or file path) |
| `plsreadme_delete` | Delete a shared doc permanently (by ID or file path) |
| `plsreadme_list` | List all documents you've shared from this project |

**Prompts:**
- `share-document` — Guided flow to share content as a readable link
- `refactor-and-share` — Uses your AI model to refactor raw text into polished markdown, then shares it

Plain text input? No problem — the MCP auto-structures it into markdown, or you can use the `refactor-and-share` prompt to leverage your AI's reasoning for a polished result.

### .plsreadme Record File

The MCP server tracks your shared documents in a `.plsreadme` JSON file in your project root. This stores document IDs, URLs, and admin tokens needed for editing and deleting.

**⚠️ Add `.plsreadme` to your `.gitignore`** — it contains admin tokens. The tool will warn you if it's missing.

## 🏗 Architecture

Built on Cloudflare's edge stack for speed everywhere:

```
┌─────────────┐     ┌──────────────────┐     ┌─────────┐
│  Web / API  │────▶│  Cloudflare      │────▶│   R2    │
│  MCP Client │     │  Workers (Hono)  │     │ (docs)  │
└─────────────┘     └──────────────────┘     └─────────┘
                           │
                    ┌──────┴──────┐
                    │     D1      │
                    │ (metadata)  │
                    └─────────────┘
```

- **Hono** — Lightweight web framework on Workers
- **Cloudflare D1** — SQLite at the edge for metadata, comments, analytics
- **Cloudflare R2** — Object storage for markdown documents
- **Durable Objects** — Stateful MCP server endpoint
- **Workers AI** — Optional fallback for text-to-markdown conversion

## 📁 Project Structure

```
plsreadme/
├── worker/
│   ├── index.ts              # Main worker entry
│   ├── routes/
│   │   ├── docs.ts           # Document creation & rendering
│   │   ├── comments.ts       # Inline commenting system
│   │   ├── convert.ts        # AI text→markdown conversion
│   │   ├── analytics.ts      # View tracking
│   │   ├── links.ts          # Short link handling
│   │   └── waitlist.ts       # Waitlist & notifications
│   ├── mcp-agent.ts          # Remote MCP server (Durable Object)
│   └── types.ts              # TypeScript types
├── packages/
│   └── mcp/                  # npm package: plsreadme-mcp
│       └── src/index.ts      # MCP server (stdio transport)
├── public/                   # Static assets & landing pages
├── db/
│   └── schema.sql            # D1 database schema
├── skill/
│   └── plsreadme/            # OpenClaw agent skill
└── wrangler.jsonc             # Cloudflare Workers config
```

## 🔧 Development

```bash
# Install dependencies
npm install

# Run locally
npm run dev

# Deploy
npm run deploy

# Database migrations
npm run db:migrate
```

### Environment Variables

Set via `wrangler secret put`:

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | No | OpenAI key for `/api/convert` text→markdown |
| `DISCORD_WEBHOOK_URL` | No | Waitlist signup notifications |
| `DISCORD_LINK_WEBHOOK_URL` | No | New link creation notifications |
| `RESEND_API_KEY` | No | Email notifications |
| `NOTIFICATION_EMAIL` | No | Email recipient for notifications |

The core sharing functionality requires **zero configuration**. AI conversion and notifications are optional add-ons.

## 📊 Limits

| Limit | Value |
|-------|-------|
| Max document size | 200 KB |
| Upload rate limit | 30/hour per IP |
| AI convert rate limit | 10/hour per IP |
| Link lifetime | Permanent |

## 🤝 Contributing

Feature ideas? Bug reports? [Open an issue](https://github.com/FacundoLucci/plsreadme/issues/new?labels=feature-request).

PRs welcome for bug fixes and improvements.

## 📄 License

MIT — do whatever you want with it.

---

<p align="center">
  <sub>Built by <a href="https://github.com/FacundoLucci">Facundo Lucci</a></sub>
</p>
