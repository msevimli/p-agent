# p-agent (plife) — Multi-Channel Self-Hosted AI Agent Platform

A self-hosted, multi-modal AI agent platform: a **web dashboard**, a
**Telegram bot**, and a **terminal CLI (`pagent`)** all drive the same agentic
pipeline — tool calling (shell, files, library, skills, automations), streaming
responses, persistent sessions, and a built-in automations scheduler — over
local llama.cpp models *or* remote OpenAI-compatible providers (OpenRouter).

```
 ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
 │  Web UI      │   │  Telegram    │   │  pagent CLI  │
 │  :8888       │   │  long-poll   │   │  terminal    │
 └──────┬───────┘   └──────┬───────┘   └──────┬───────┘
        └──────────────────┼──────────────────┘
                   ┌───────▼────────┐
                   │  /api/chat     │  agentic tool loop
                   │  (single      │  queue + tools + sessions
                   │  pipeline)     │
                   └───────┬────────┘
                    llama.cpp │ OpenRouter (OpenAI-compatible)
```

## Quick start

```bash
git clone https://github.com/msevimli/p-agent.git && cd p-agent
npm install
cp .env-example .env        # add LLAMA_API_KEY for remote models
npm start                   # → web dashboard at http://localhost:8888
```

Prefer the unified lifecycle script instead of managing processes by hand:

```bash
./pagent.sh --start    # background start + PID file + health wait
./pagent.sh --status   # PID / uptime / health
./pagent.sh --stop     # graceful stop (Telegram poller + schedulers shut down with it)
```

The chat pipeline needs an active model. Two options:

- **Local llama.cpp** — run `llama-server -m <model>.gguf --port 8080` and use
  the built-in local models (Gemma 2, Qwen2.5 Coder, Mistral 7B, Llama 3.2 3B…).
- **Remote OpenRouter** — set `LLAMA_API_KEY=<key>` in `.env`, then pick a
  remote model in **Tools → Models** (deepseek, qwen, nemotron, ling…). Keys
  are stored only in `.env` (per-model keys: `LLAMA_API_KEY_<MODEL_ID>`),
  never duplicated into state files.

> The frontend loads Tailwind, marked and highlight.js from CDNs — an internet
> connection is needed for UI styling on first load.

## Terminal CLI (`pagent`)

Link the CLI globally (or run it directly with `node bin/pagent.js`):

```bash
npm link                    # → `pagent` available in any terminal
```

### Interactive REPL

```bash
pagent                      # opens a chat REPL
You> what files are in the library?
⚙ Listing Library files
…streamed answer…
You> /help                  # commands: /new /attach /model /exit
```

REPL commands: `/help`, `/exit`, `/quit`, `/new [name]` (fresh session),
`/attach <name|id>` (attach a Library file to the next message), `/model <id>`.
`Ctrl+C` aborts the in-flight generation; pressing again exits.

### One-shot prompts

```bash
pagent chat "fetch the current Solana price"
pagent "create a backup automation for every 6 hours"
```

### Management subcommands

```bash
pagent sessions             # list browser + Telegram + CLI sessions
pagent models               # list models, * = active
pagent models deepseek      # switch the active model
pagent channels             # Telegram bot status (token, whitelist, polling)
pagent channels on|off      # enable/disable the Telegram channel
pagent config               # effective configuration (secrets masked)
pagent config set LLAMA_MAX_TOKENS=8192   # edit .env values
```

Add `--json` to `sessions`/`models`/`channels` for machine-readable output.
Chat and write commands talk to the local server (`PAGENT_BASE_URL` overrides
`http://127.0.0.1:8888`); read-only commands fall back to the local `data/`
state files when the server is down.

## Telegram channel

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. Open **Tools → Channels**, paste the token, **Save token** (written to
   `.env` as `TELEGRAM_BOT_TOKEN`, never into state files).
3. Message your bot once, reply to `/id`, and add the returned chat id to the
   **whitelist** (comma-separated) — or set `TELEGRAM_ADMIN_CHAT_ID` in `.env`,
   which is always allowed and cannot be removed from the UI.
4. Flip the toggle. The bot long-polls (50s) without any extra dependency.

In-chat commands: `/id`, `/status`, `/help`. Authorized chats reach the **same
agent pipeline** as the web/CLI — tools, Library attachments, automations, and
the request queue included. Conversations persist as normal dashboard sessions
(`tg-<chat_id>`) with full history replay, so the bot remembers context and
you can read the whole exchange in the sidebar. Unauthorized chats get one
short refusal and never trigger the agent.

## Resilience & smart tool handling

- **Agentic tool loop with dual call formats** — native OpenAI `tool_calls`
  (remote providers) *and* a tolerant JSON-block contract
  (`{"tool": "...", "args": {...}}`, fenced or bare) for Content-only
  llama.cpp builds; calls are schema-validated before execution (missing or
  placeholder args are rejected with corrective feedback, never run).
- **Smart tool deduplication** — exact repeats of a call are skipped
  (writable/side-effectful tools execute once per request), and `run_shell`
  carries a consecutive-duplicate guard: a command that just succeeded is not
  re-run back-to-back, even if the model re-emits it with different quoting
  (`curl 'URL'` == `curl "URL"` == `curl URL`). Intentional repeats after other
  steps, and retries of *failed* commands, still execute.
- **Never stalls on a broken model** — if the active model returns an empty
  stream when tool calling is enabled (some providers do), the request is
  automatically re-run without the tools array and still answers, with a
  status event explaining the fallback.
- **Transient-provider handling** — the FIFO request queue retries network
  gremlins, empty streams, OpenRouter 402 (in-flight budget) and 429
  rate-limits with escalating backoff (8s for throttling-class errors).
- **Length-cap continuation** — outputs cut by `max_tokens` are completed in
  up to 8 continuation rounds instead of truncated mid-code (or mid-JSON call).
- **Automation enforcement** — asking for a recurring task forces the model to
  call `create_automation` instead of explaining how; the server can also
  create it directly from your wording when the model refuses.

## Project structure

```
p-agent/
├── server.js              # Express init, route mounting, scheduler/telegram boot
├── config.js              # env-driven config (port, llama, queue, sandbox, telegram)
├── bin/pagent.js          # `pagent` terminal CLI (REPL + management commands)
├── routes/                # thin HTTP layer
│   ├── chat.js            #   POST /api/chat — agentic tool loop + SSE
│   ├── sessions.js        #   /api/sessions CRUD
│   ├── models.js          #   /api/models registry + activate
│   ├── automations.js     #   /api/automations CRUD + run
│   ├── skills.js          #   /api/skills registry + run
│   ├── library.js         #   /api/library CRUD + upload
│   ├── channels.js        #   /api/channels — Telegram config/status
│   ├── fs.js              #   /api/fs/list, /api/fs/read (file explorer)
│   ├── health.js          #   GET /api/health
│   └── queue.js           #   GET /api/queue — request-queue stats
├── services/              # business logic (no HTTP)
│   ├── llamaClient.js     #   upstream client: payload, SSE parse, probes
│   ├── requestQueue.js    #   strict FIFO + transient retries/backoff
│   ├── toolLoop.js        #   tool registry dispatch, extractor, dedup guards
│   ├── chatLoopback.js    #   HTTP loopback into /api/chat (channel bridge)
│   ├── telegramBot.js     #   Telegram long-polling channel (no deps)
│   ├── libraryManager.js  #   persistent file library
│   ├── sessionStore.js    #   session persistence (data/sessions.json)
│   ├── modelManager.js    #   model registry + .env key management
│   ├── skillManager.js    #   SKILL.md registry
│   └── automationManager.js # cron/interval engine
├── tools/                 # 16 agent tools (uniform {name,desc,parameters,execute})
├── public/                # vanilla-JS dashboard (no build step)
├── data/                  # gitignored runtime state (JSON files + library blobs)
└── skills/                # user-authored skills (SKILL.md)
```

## API (main endpoints)

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/health` | Server + model status |
| POST | `/api/chat` | Agentic chat (SSE streaming, `stream: true`) |
| GET/POST/PUT/DELETE | `/api/sessions[/:id]` | Session CRUD |
| GET/POST | `/api/models[/:id/activate]` | Model registry / activation |
| GET/POST/DELETE | `/api/automations[/:id]` + `POST /:id/run` | Automations engine |
| GET/POST | `/api/skills[/:name/run|toggle]` | Skills registry |
| GET/POST/DELETE | `/api/library[/:id]` + `GET /:id/content` | File Library (upload via raw body) |
| GET | `/api/channels` | Telegram channel status |
| PUT | `/api/channels/telegram` | Whitelist update |
| POST | `/api/channels/telegram/toggle` | Enable/disable |
| POST | `/api/channels/telegram/token` | Set/clear token (`.env`) |
| POST | `/api/channels/telegram/test` | getMe connection test |
| GET | `/api/fs/list`, `/api/fs/read` | File explorer |
| GET | `/api/queue` | Queue stats |

## Key environment variables

`PORT`, `LLAMA_BASE_URL`, `LLAMA_API_KEY` (+ `LLAMA_API_KEY_<MODEL_ID>`),
`LLAMA_MODEL`, `LLAMA_MAX_TOKENS`, `LLAMA_SYSTEM_PROMPT`, `TOOL_CALLING`
(`false` disables tools), `TOOL_MAX_ITERATIONS`, `QUEUE_LIMIT`,
`QUEUE_RETRIES`, `PLIFE_WORK_ROOT` (sandbox), `LIBRARY_MAX_UPLOAD_MB`,
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_ADMIN_CHAT_ID`, `PAGENT_BASE_URL` (CLI),
`PLIFE_DOTENV_FILE` (alternate .env path). See `.env-example` for the full list.