# Bastilon

**Your personal AI fortress.** Kingston runs here.

Bastilon is a self-hosted autonomous AI platform that connects a Telegram bot to a local Claude Code CLI, with 300+ skills, semantic memory, a multi-agent system, and a web dashboard. Zero cloud API costs — runs entirely on your machine.

> Originally inspired by [godagoo/claude-telegram-relay](https://github.com/godagoo/claude-telegram-relay). This is a complete, from-scratch reimplementation that has evolved far beyond a simple relay.

---

## Architecture

```
Telegram ←→ grammY (long polling)
               ↓
         Orchestrator (router.ts)
          ┌────┼────────┐
          ↓    ↓        ↓
      Claude  Gemini  Ollama
      CLI     Flash   (local)
      (brain) (tools) (trivial)
          ↓
    300+ Skills ←→ SQLite + Semantic Memory
          ↓
    4 Autonomous Agents (Scout, Analyst, Learner, Executor)
          ↓
    Dashboard (localhost:3200) + Voice Server (Twilio/Deepgram/ElevenLabs)
```

### Model Tiers

| Tier | Model | Usage | Cost |
|------|-------|-------|------|
| Opus | Claude CLI (Max plan) | User conversations | $0 |
| Sonnet | Claude CLI | Follow-up tool chains | $0 |
| Haiku | Claude CLI | Agent cycles | $0 |
| Ollama | qwen2.5:14b (local) | Heartbeats, greetings | $0 |
| Gemini | 2.0 Flash | Vision, image gen, browser | $0 |

---

## Features

### Core
- **Telegram ↔ Claude Code CLI** — messages flow through your local `claude` binary
- **300+ skills** across 73 namespaces (files, git, web, browser, office, social, business, etc.)
- **Semantic memory** — MemU-inspired system with Gemini embeddings, auto-extraction, cosine similarity search
- **Conversation memory** — per-chat history in SQLite with configurable turn limit
- **Progressive disclosure** — compact skill catalog (~5KB) instead of full schema (~50KB)
- **SOUL.md** — editable AI personality file that Kingston can modify

### Agents
- **Scout** — Market intelligence & prospecting (4h cycles, 6-cycle rotation)
- **Analyst** — Performance analysis & tiered reports (6h cycles)
- **Learner** — Error analysis & self-improvement (8h cycles, 3-cycle rotation)
- **Executor** — Code request bridge between Kingston and Emile (5min polling)

### Security
- **User allowlist** — only approved Telegram user IDs can interact
- **Tool profiles** — 4 tiers (default/coding/automation/full) with granular permissions
- **SSRF protection** — DNS resolution + private IP blocking on outbound requests
- **Strict tool_call parsing** — pure JSON only, no embedded JSON injection
- **Path traversal prevention** — pre-resolve `..` + null byte rejection
- **Dashboard auth** — token-based, localhost-only, CORS restricted
- **Log redaction** — 8 secret patterns automatically stripped from output

### Integrations
- **Voice** — Twilio SIP → Deepgram STT → Claude → ElevenLabs TTS (mulaw 8kHz)
- **Browser** — 14 Puppeteer-based skills including AI computer-use
- **Email** — Gmail OAuth (send, read, search, reply, draft, labels)
- **Calendar** — Google Calendar OAuth (create, search, delete events)
- **SMS** — Twilio (send, receive, reply, bulk)
- **Social** — Twitter, LinkedIn, Reddit, Discord, Facebook, Instagram, Moltbook
- **Business** — Stripe, HubSpot, booking, contacts
- **FTP** — File deployment to web hosting
- **Office** — Word, Excel, PowerPoint, CSV via Python
- **OS** — Process management, clipboard, screenshots, app control, registry, services

### Dashboard
- **11 views**: chat, overview, sessions, scheduler, agents, skills, memory, config, logs, debug, system
- **Live logs** via WebSocket broadcast
- **Skills browser** with namespace grouping and search
- **Config editor** with secrets masking
- **Conseil mode** — Kingston + Emile collaborative interface

---

## Prerequisites

- **Node.js** >= 20 (runs via tsx, no build step)
- **Claude Code CLI** installed and on your PATH (`claude --version`)
- **Build tools** for native modules (better-sqlite3):
  - Windows: `npm install -g windows-build-tools` (or install Visual Studio Build Tools)
  - Linux: `sudo apt-get install build-essential python3`
  - macOS: `xcode-select --install`
- A **Telegram Bot Token** from [@BotFather](https://t.me/BotFather)
- **Ollama** (optional) for local model tier — [ollama.com](https://ollama.com)
- **Python 3** (optional) for office/image/PDF skills
- **Puppeteer** is installed automatically (~400MB Chromium download on first run)

## Quick Start

### 1. Clone & install

```bash
git clone https://github.com/mrmagnifique666/Bastilon.git
cd Bastilon
npm install
```

### 2. Configure

```bash
cp .env.example .env
```

Edit `.env` with your values. The minimum required config:

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Token from [@BotFather](https://t.me/BotFather) |
| `TELEGRAM_ALLOWED_USERS` | Your Telegram user ID (find via [@userinfobot](https://t.me/userinfobot)) |

Optional but recommended:

| Variable | Description |
|----------|-------------|
| `GEMINI_API_KEY` | Free — for vision, image gen, browser tools ([aistudio.google.com](https://aistudio.google.com)) |
| `DASHBOARD_TOKEN` | Auth token to secure the dashboard API |
| `ADMIN_PASSPHRASE` | Unlock admin-only skills via `/admin` in Telegram |
| `OLLAMA_ENABLED=true` | Enable local Ollama for $0 agent runs |
| `BRAVE_SEARCH_API_KEY` | For web search skill (free tier: 2000 queries/month) |

See `.env.example` for all ~65 environment variables with descriptions.

### 3. Personalize (optional)

```bash
cp relay/SOUL.md.example relay/SOUL.md
cp AUTONOMOUS.md.example AUTONOMOUS.md
```

Edit these files to customize Kingston's personality and autonomous behavior.

### 4. Run

```bash
npm run dev:node     # development (runs via tsx, auto-restarts on crash)
```

### 5. Test

```bash
npm test
```

---

## Project Structure

```
bastilon/
├── src/
│   ├── index.ts                 # Entry point — bot, scheduler, agents, dashboard, voice
│   ├── wrapper.ts               # Process wrapper for auto-restart
│   ├── agents/                  # Autonomous agent system
│   │   ├── base.ts              # Base agent class (lifecycle, rate limits)
│   │   ├── manager.ts           # Agent bootstrap & management
│   │   └── definitions/         # Scout, Analyst, Learner, Executor configs
│   ├── bot/
│   │   └── telegram.ts          # grammY bot setup & message handling
│   ├── browser/                 # Puppeteer browser manager
│   ├── config/
│   │   └── env.ts               # Environment config with hot-reload
│   ├── dashboard/               # Web dashboard (HTML + REST API + WebSocket)
│   ├── gmail/                   # Google OAuth client
│   ├── hooks/                   # Event hook system (startup, session, agent cycles)
│   ├── llm/
│   │   ├── claudeCli.ts         # Claude CLI spawn & prompt builder (single-shot)
│   │   ├── claudeStream.ts      # Claude CLI streaming mode
│   │   ├── gemini.ts            # Gemini Flash client (tools only)
│   │   ├── ollamaClient.ts      # Local Ollama client
│   │   └── protocol.ts          # Strict JSON tool_call parser
│   ├── memory/
│   │   └── semantic.ts          # MemU semantic memory (embeddings + CRUD)
│   ├── orchestrator/
│   │   └── router.ts            # Message routing, tool chaining, model selection
│   ├── processors/              # Message pre/post processors
│   ├── scheduler/               # Cron-like task scheduler
│   ├── security/
│   │   ├── policy.ts            # Tool profiles & allowlists
│   │   ├── rateLimit.ts         # Token-bucket rate limiter
│   │   └── ssrf.ts              # SSRF protection module
│   ├── skills/
│   │   ├── loader.ts            # Skill registry, compact catalog, progressive disclosure
│   │   └── builtin/             # 70 skill files, 300+ individual skills
│   ├── storage/
│   │   └── store.ts             # SQLite (turns, notes, memory_items, agents, sessions)
│   ├── utils/
│   │   ├── log.ts               # Levelled logger with secret redaction
│   │   └── paths.ts             # Path traversal protection
│   └── voice/                   # Twilio → Deepgram → Claude → ElevenLabs pipeline
├── relay/
│   ├── SOUL.md                  # Kingston's editable personality
│   ├── AUTONOMOUS.md            # Autonomous mode instructions
│   └── schedules.json           # Scheduled tasks config
├── tests/
├── .env.example
├── package.json
└── tsconfig.json
```

## Skill Namespaces (300+)

| Namespace | Skills | Description |
|-----------|--------|-------------|
| `files.*` | 16 | File CRUD, search, zip, diff, bulk rename, checksums |
| `browser.*` | 14 | Navigate, click, type, extract, screenshots, AI computer-use |
| `system.*` | 15 | Services, env, disk, installed apps, startup, full system info |
| `twitter.*` | 9 | Tweet, reply, search, follow, DM, timeline, analytics |
| `moltbook.*` | 11 | Posts, comments, follow, search, feed, profile |
| `reddit.*` | 8 | Post, comment, search, subscribe, upvote, trending |
| `linkedin.*` | 7 | Post, connect, search, message, profile, jobs |
| `stripe.*` | 7 | Customers, charges, invoices, subscriptions, products |
| `hubspot.*` | 7 | Contacts, deals, companies, tasks, notes, pipeline |
| `gmail.*` | 6 | Send, read, search, reply, draft, labels |
| `git.*` | 6 | Status, diff, commit, push, branch, log |
| `browser.*` | 14 | Full browser automation with Puppeteer |
| `calendar.*` | 5 | Google Calendar — create, search, delete events |
| `ftp.*` | 7 | Connect, list, upload, download, delete, mkdir |
| `sms.*` | 4 | Send, receive, reply, bulk SMS via Twilio |
| `memory.*` | 7 | Semantic search, remember, forget, stats, update, query |
| `agents.*` | 4 | List, status, pause, resume agents |
| `ollama.*` | 4 | Models, chat, pull, delete local models |
| `office.*` | 5 | Word, Excel, PowerPoint, CSV, list documents |
| `pdf.*` | 5 | Info, extract text, merge, split, to images |
| `image.*` | 7 | Info, resize, crop, watermark, convert, generate |
| ... | ... | 73 namespaces total |

---

## Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message |
| `/clear` | Reset conversation history |
| `/help` | List available skills |
| `/admin <passphrase>` | Enable admin mode |

---

## Cost Architecture

Bastilon is designed to run at **$0/month**:

- **Claude CLI** on Anthropic's Max plan — no API key charges
- **Gemini 2.0 Flash** free tier — vision, image generation, browser tools
- **Ollama** local inference — heartbeats and trivial queries
- **Voice** (optional) — Deepgram/ElevenLabs/Twilio have free tiers

---

## Troubleshooting

### "claude not found"
Ensure the Claude Code CLI is on your PATH: `claude --version`. Or set the full path in `.env`:
```
CLAUDE_BIN=C:\Users\YourName\.claude\claude.exe
```

### EADDRINUSE
Another instance is running. Kill node processes and remove the lock file:
```bash
taskkill /F /IM node.exe    # Windows
rm relay/bot.lock
```

### SQLite compilation errors
```bash
npm install -g windows-build-tools   # Windows
sudo apt-get install build-essential  # Linux
```

---

## License

MIT
