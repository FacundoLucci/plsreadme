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
- **Clerk auth foundation** — GitHub/Google sign-in wiring + Clerk-hosted email fallback + backend auth verification utilities
- **Ownership model (Phase 2)** — docs can be linked to a Clerk user (`owner_user_id`) while preserving anonymous flows
- **My Links dashboard (Phase 3)** — authenticated `/my-links` page with search/sort/pagination and quick copy/open actions
- **Legacy link claiming (Phase 4)** — signed-in users can claim older anonymous links by proving the original `admin_token`
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

For docs owned by an authenticated Clerk user, update/delete also require that owner session (to prevent cross-user mutation), while anonymous docs continue to work with `admin_token` only.

To claim a legacy anonymous link into your signed-in account:

```bash
curl -X POST https://plsreadme.com/api/auth/claim-link \
  -H "Authorization: Bearer <clerk-session-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"id":"abc123def456","adminToken":"sk_..."}'
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

### Docker (for MCP registries / listing checks)
Build and run the stdio MCP server in a clean container:

```bash
docker build -t plsreadme-mcp:local .
docker run --rm -i plsreadme-mcp:local
```

The containerized server uses stdio (no ports, no env vars required).

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
│   ├── auth.ts               # Clerk JWT verification utilities/middleware
│   ├── routes/
│   │   ├── auth.ts           # Auth config/session/protected identity endpoints
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
├── docs/
│   ├── auth-clerk.md         # Auth setup + environment checklist
│   └── runbooks/
│       └── legacy-link-claim-rollout.md
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

# Bootstrap schema (fresh local DB)
npm run db:migrate:local

# Audit unapplied migrations (remote + local)
npm run db:migrations:status

# Apply migration files explicitly
npm run db:migrations:apply        # remote
npm run db:migrations:apply:local  # local
```

Ownership phase migration notes:
- `wrangler.jsonc` points `migrations_dir` to `db/migrations`, so migration status is auditable with explicit list/apply commands.
- Apply `db/migrations/004_owner_user_id.sql` in existing environments before relying on ownership filters.
- Legacy rows are intentionally backfilled as `owner_user_id = NULL` (anonymous/public behavior preserved).
- Write routes still run a safe ownership schema ensure step (duplicate-column tolerant) for mixed-env rollout safety.
- See [`docs/migrations.md`](docs/migrations.md) for the explicit audit/apply workflow.

### MCP package release
`plsreadme-mcp` is published from `packages/mcp` by pushing an `mcp-v*` tag (see `.github/workflows/publish-mcp.yml`).

```bash
cd packages/mcp
npm version patch   # or minor/major
cd ../..
git add packages/mcp/package.json packages/mcp/package-lock.json
VERSION=$(node -p "require('./packages/mcp/package.json').version")
git commit -m "chore(mcp): release v${VERSION}"
git tag "mcp-v${VERSION}"
# push commit + tag from your machine to trigger npm publish workflow
```

### Environment Variables

Start from `.env.example` and set values in your local/dev/prod environment.

> Cloudflare tip: non-sensitive values can live in `vars`; sensitive values should be set with `wrangler secret put`.

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | No | OpenAI key for `/api/convert` text→markdown |
| `DISCORD_WEBHOOK_URL` | No | Waitlist signup notifications |
| `DISCORD_LINK_WEBHOOK_URL` | No | New link creation notifications |
| `RESEND_API_KEY` | No | Email notifications |
| `NOTIFICATION_EMAIL` | No | Email recipient for notifications |
| `CLERK_PUBLISHABLE_KEY` | For auth | Clerk publishable key for frontend auth wiring (social + email fallback) |
| `CLERK_JWT_ISSUER` | For auth | Clerk JWT issuer used by worker verification |
| `CLERK_JWT_AUDIENCE` | Optional | Expected audience claim for Clerk JWTs |
| `CLERK_SIGN_IN_URL` | Optional | Clerk-hosted sign-in URL hint (default `/sign-in`) |
| `CLERK_SIGN_UP_URL` | Optional | Clerk-hosted sign-up URL hint (default `/sign-up`) |
| `CLERK_SECRET_KEY` | Optional | Reserved for future server-side Clerk integrations |

If OAuth credentials are not configured yet, users can still click **Sign in** / **Use email instead** and complete auth through the Clerk-hosted email flow immediately.

The core sharing functionality still requires **zero configuration**. Clerk auth, AI conversion, and notifications are opt-in.

For the full auth setup checklist, see [`docs/auth-clerk.md`](docs/auth-clerk.md).

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
