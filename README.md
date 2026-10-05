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

The chat pipeline needs an active model. Two options:

- **Local llama.cpp** — run `llama-server -m <model>.gguf --port 8080` and use
  the built-in local models (Gemma 2, Qwen2.5 Coder, Mistral 7B, Llama 3.2 3B…).
- **Remote OpenRouter** — set `LLAMA_API_KEY=<key>` in `.env`, then pick a
  remote model in **Tools → Models** (deepseek, qwen, nemotron, ling…). Keys
  are stored only in `.env` (per-model keys: `LLAMA_API_KEY_<MODEL_ID>`),
  never duplicated into state files.

> The frontend loads Tailwind, marked and highlight.js from CDNs — an internet
> connection is needed for UI styling on first load.

## Model lifecycle & cold-start controls

The header shows a live **model status badge** for the active model — green
**ready**, amber spinner **loading** (warm-up or prompt prefill / cold start),
gray **unloaded**, red **error** — with an approximate memory footprint in the
tooltip. Clicking it opens a dropdown with **Warm-up** (background pre-load so
the first prompt responds instantly) and **Eject** (free the weights from
memory) plus a shortcut to the Models panel. The badge polls
`GET /api/models/status` every 15s and refreshes immediately after sends,
warm-ups and ejects.

- Lifecycle states are derived per model endpoint from `/health`, `/v1/models`
  and `/slots` (see `services/modelLifecycle.js`); a 2-probe debounce absorbs
  llama.cpp's task "tombstones" (a finished task leaves `id_task` set, which
  would otherwise pin the badge on "busy" forever).
- **Warm-up** (`POST /api/models/warmup`) runs a `max_tokens=1` completion
  containing ONLY the static prompt prefix (short system prompt + ALL tools,
  `cache_prompt: true`) through the same FIFO request queue as chat — never
  two concurrent connections into a single-slot llama.cpp. Local endpoints
  only. The agent also warms up on startup (`AUTO_WARMUP=false` to disable).
  After a warm-up, the first real message starts from a KV-cache hit (the
  usage badge shows it: "6.1k tok (5.9k cached) · 12.1/2.6 tok/s").
- **Prompt caching:** the system prompt and the full 16-tool array are
  byte-stable (static text, tools sorted by name, identical serialization),
  `cache_prompt: true` is set on every request, and dynamic content is never
  injected before the history — so llama.cpp re-evaluates only the new user
  message + last reply on subsequent turns of a conversation. Every `[llm]`
  log line carries `prefix=<hash>` of the serialized prefix; a runtime
  change logs a warning.
- **Tool output limits & history compaction:** one tool result is capped at
  `TOOL_OUTPUT_MAX_CHARS` (4000, head+tail with a truncation marker applied
  once at insertion — run_shell keeps mostly the tail); read_file supports
  line offset/limit and caps at READ_FILE_MAX_CHARS; list_files caps entries
  and reports the omitted count. Compaction is a deterministic REPLAY of the
  conversation with the fixed chars/3.4 estimator (never the per-request
  usage.prompt_tokens calibration, which only feeds logs/UI): a compaction
  event fires only when the running estimate crosses 75% of the context
  budget (n_ctx − prefix − 1024 reserve − 5% margin) and brings the state to
  50% — oldest tool results stubbed, then oldest complete turns dropped,
  always keeping the last 3 user turns. The cut is sticky, so between
  events every request reproduces the byte-identical compacted prefix and
  only the new messages re-evaluate; `scripts/compaction-stability-sim.js`
  proves this (prompt tokens, common prefix, re-evaluated tokens per turn,
  ±10% calibration-invariance). Compaction events and estimated re-prefill
  time (tokens after the first changed position ÷ measured prompt speed)
  are logged (`[ctx] compact(...)`). A context-exceeded error triggers one
  compact-and-retry, then a clear error.
- **Misformatted tool calls (tolerant fallback + guard retry):** some llama.cpp
  builds leave a correctly-shaped call wrapped in a tag (`<tool_call>`,
  `<tool_calls>`, `<function_call>`, `<function-calls>`) or a fenced JSON block
  in the raw assistant content with `tool_calls` empty. A strict parser
  (`services/toolCallParser.js`) converts exactly this shape — only the
  assistant's own content, tool name must exactly match a registered tool,
  arguments must be valid JSON; anything ambiguous/invalid stays plain text
  (never executes). The tag text never reaches the stored history or the UI,
  and each use is logged (`[tool-fallback] variant=…`). If a reply still has
  no call but contains a shell block / curl / wget on a live-data request,
  the agent retries ONCE with the stable instruction and
  `tool_choice:"required"` for that single completion (config
  `GUARD_RETRY_TOOL_CHOICE`, default on). Genuine plain-text replies log the
  finish reason and content head (`[llm-no-call]`). Every executed tool call
  logs one line with real exit code, duration and the first 200 chars of
  command / stdout / stderr, JSON-escaped
  (`[tool] name=run_shell exit=0 dur=1.2s cmd="…" out="…" err="…"`). Tests:
  `scripts/tool-call-fallback-tests.js` (mocked, no server).
- **Eject** (`POST /api/models/eject`) is capability-tiered: true weight
  unload via llama.cpp's model-router API (`POST /models/unload`), a degraded
  KV-cache erase where supported, and otherwise an honest response explaining
  that this llama-server instance cannot unload at runtime — restart it with
  the model router (`--router`) for true eject-from-memory.
- Memory reporting is approximate: weights ≈ GGUF file size on disk plus the
  KV context capacity reported by `/slots`.

## System resource monitor (header)

Two compact circular gauges in the header (left of the model status badge)
show live **RAM** (blue) and **CPU** (violet) usage with the percentage
inside the ring: `GET /api/system/metrics` (Node `os` module, no
dependencies). Warnings at ≥85% and critical at ≥95% tint the ring amber/red.
Tooltips carry the raw numbers (GB used / total, core count, load average,
uptime). The widget polls every 5s and sweeps smoothly between samples.

- **RAM** is kernel-accurate and **container-aware**: inside a Docker
  container (`/.dockerenv` / cgroup markers) usage and limit come from the
  process cgroup — cgroup v2 `memory.current`/`memory.max` or cgroup v1
  `memory.usage_in_bytes`/`memory.limit_in_bytes` — so the header matches
  `docker stats` (used = cgroup usage; total = the container's limit, or
  host memory when the cgroup is unlimited, mirroring docker-stats LIMIT).
  Bare metal falls back to `/proc/meminfo` with the procps `kb_main_used`
  formula (buffers + page cache count as used) plus `percentAvail`
  (`MemTotal − MemAvailable`, modern `free`'s used column). Beware
  `os.freemem()` on Linux ≈ MemAvailable (reclaimable cache included), so a
  plain `totalmem − freemem` understates the naive ratio whenever cache is
  large — and on WSL2 it can disagree with Windows Task Manager's vmmem
  accounting, which counts the VM's held cache too.
- **CPU** is container-aware like RAM: inside a container the delta comes
  from the cgroup's own counters — `cpuacct.usage` (cgroup v1, ns) or
  `cpu.stat usage_usec` (cgroup v2) — with the percentage expressed against
  the allocated quota (`cpu.max` / `cpu.cfs_quota_us`), or the host core
  count when the quota is unlimited. Bare metal keeps the `os.cpus().times`
  tick-delta method. In both cases the very first sample has no baseline
  and falls back to a loadavg-based estimate for one tick.

## Daemon lifecycle management (`pagent.sh`)

The root-level `pagent.sh` is the unified management script — instead of
tracking PIDs or juggling `nohup` by hand, use it for the whole process
lifecycle. State lives in `data/pagent.pid` (PID file) and
`data/pagent.log` (boot/run logs) — both gitignored.

```bash
./pagent.sh --start
```

Spins up the backend daemon **in the background** (agent loopback, Telegram
poller, and automations scheduler all boot with `server.js`). Before
launching it:

- verifies `node` and `node_modules` (hints at `npm install` if missing),
- creates `.env` from `.env-example` when absent (warned),
- refuses/warns on double starts — it checks the PID file first, then scans
  for a `node server.js` process and probes port `8888`,
- writes the PID to `data/pagent.pid` and waits until `/api/health`
  responds (up to 30s); on failure it prints the log tail and cleans up.

```bash
./pagent.sh --status
```

Reports whether the daemon is running: PID, uptime (`ps etimes`), port, and a
live `/api/health` check. It also distinguishes tracked processes (started
via the script) from untracked ones, detects stale PID files, and exits
non-zero when the service is down.

```bash
./pagent.sh --stop
```

Terminates the daemon gracefully: sends SIGTERM (the server stops its
Telegram poller and schedulers cleanly), waits up to 10s, escalates to
SIGKILL if needed, removes `data/pagent.pid`, and verifies the port is
released. Servers started outside the script are detected by process/port
scan and stopped with a warning.

Notes: `PORT=<other> ./pagent.sh --start` runs on a different port;
`NO_COLOR=1` (or a pipe) disables colored output.

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
│   ├── models.js          #   /api/models registry + activate + status/warmup/eject
│   ├── automations.js     #   /api/automations CRUD + run
│   ├── skills.js          #   /api/skills registry + run
│   ├── library.js         #   /api/library CRUD + upload
│   ├── channels.js        #   /api/channels — Telegram config/status
│   ├── fs.js              #   /api/fs/list, /api/fs/read (file explorer)
│   ├── health.js          #   GET /api/health
│   ├── queue.js           #   GET /api/queue — request-queue stats
│   └── system.js          #   GET /api/system/metrics — RAM + CPU (os module)
├── services/              # business logic (no HTTP)
│   ├── llamaClient.js     #   upstream client: payload, SSE parse, probes
│   ├── requestQueue.js    #   strict FIFO + transient retries/backoff
│   ├── toolLoop.js        #   tool registry dispatch, extractor, dedup guards
│   ├── chatLoopback.js    #   HTTP loopback into /api/chat (channel bridge)
│   ├── telegramBot.js     #   Telegram long-polling channel (no deps)
│   ├── libraryManager.js  #   persistent file library
│   ├── sessionStore.js    #   session persistence (data/sessions.json)
│   ├── modelManager.js    #   model registry + .env key management
│   ├── modelLifecycle.js  #   per-model lifecycle state, status probes, warm-up/eject
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
| GET/POST/PUT/DELETE | `/api/models[/:id]` + `POST /:id/activate` | Model registry / activation |
| GET | `/api/models/status` | Live lifecycle: unloaded/loading/ready/error + memory |
| POST | `/api/models/warmup` | Background pre-load (local, `{id?}`) |
| POST | `/api/models/eject` | Free weights from memory (local, `{id?}`) |
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
| GET | `/api/system/metrics` | Host RAM + CPU usage (os module) |

## Key environment variables

`PORT`, `LLAMA_BASE_URL`, `LLAMA_API_KEY` (+ `LLAMA_API_KEY_<MODEL_ID>`),
`LLAMA_MODEL`, `LLAMA_MAX_TOKENS`, `LLAMA_SYSTEM_PROMPT`, `TOOL_CALLING`
(`false` disables tools), `TOOL_MAX_ITERATIONS`, `QUEUE_LIMIT`,
`QUEUE_RETRIES`, `PLIFE_WORK_ROOT` (sandbox), `LIBRARY_MAX_UPLOAD_MB`,
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_ADMIN_CHAT_ID`, `PAGENT_BASE_URL` (CLI),
`PLIFE_DOTENV_FILE` (alternate .env path). See `.env-example` for the full list.