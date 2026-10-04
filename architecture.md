# Project Architecture Overview

## 1. Introduction & Tech Stack

p-agent (plife) is a **multi-channel, self-hosted AI agent platform**: a web
dashboard, a Telegram bot, and a terminal CLI (`pagent`) all drive ONE agentic
pipeline — tool calling (shell, files, library, skills, automations),
streaming answers, persistent conversations, and an automations scheduler.
Model backends are pluggable: local llama.cpp servers or remote
OpenAI-compatible endpoints (OpenRouter etc.) through the same client layer.

- **Runtime:** Node.js >= 18, CommonJS modules; single runtime dependency is
  `express` (^4.19).
- **Backend:** Express app in `server.js` (entry point/router only). Business
  logic is split into `routes/` (thin HTTP layer) and `services/` (no HTTP).
- **Model backends:** local llama.cpp `llama-server` (OpenAI-compatible
  `/v1/chat/completions` SSE, default `http://127.0.0.1:8080`) and/or remote
  OpenAI-compatible providers (OpenRouter). The active model is resolved per
  request from the registry — no restart to switch.
- **Models:** multi-model registry (`data/models-state.json`) mixing local GGUF
  models (gemma, qwen-coder, mistral, llama, Qwen2.5-VL) and remote OpenRouter
  models (deepseek/deepseek-v3.2, qwen-2.5-7b, nemotron-3-120b, ling-3).
  Bearer tokens resolve from `.env` (`LLAMA_API_KEY_<MODEL_ID>` per-model,
  falling back to `LLAMA_API_KEY`) — keys never live in state files; keys typed
  into the dashboard are routed to `.env` by `modelManager.writeDotEnvVar`.
- **Tool-calling formats:** Content-only llama.cpp builds cannot emit native
  `tool_calls`, so the system prompt teaches a structured **JSON-block
  contract** (`{"tool":"<name>","args":{...}}`) plus a tolerant extractor;
  OpenAI-compatible remotes additionally flow native `tool_calls` through the
  same loop (native first, block extractor as fallback).
- **Frontend:** vanilla JS single-page app (`public/`), dark/light theme,
  Tailwind/marked/highlight.js from CDNs, SSE chat streaming, session list,
  file explorer, skills, models, automations, library, and channels panels.
- **Channels:** web (SSE via browser), Telegram (`services/telegramBot.js`,
  native long-polling, zero new dependencies) and terminal CLI
  (`bin/pagent.js`, npm-linked as `pagent`).
- **Storage:** flat JSON files under `data/` (no database); library blobs in
  `data/library/`. No vector DB — “memory” is session history + skills.
- **Scheduling:** built-in automations engine (cron/interval), 15s tick, never
  system cron.

## 2. Directory Structure

```
p-agent/
├── server.js                 # Express init, middleware, route mounting, listener,
│                             #   automation scheduler + telegram syncStart/stop
├── config.js                 # env-driven config: port, llama params, timeouts,
│                             #   queue limits, workRoot sandbox, tool-loop knobs,
│                             #   telegram knobs, library knobs
├── package.json              # express dependency; bin: pagent -> bin/pagent.js
├── pagent.sh                 # unified daemon lifecycle manager (--start/--status/--stop)
├── bin/pagent.js             # terminal CLI: REPL chat + management subcommands
├── README.md / architecture.md   # this documentation
│
├── routes/                   # thin HTTP endpoints (request/response only)
│   ├── health.js             #   GET /api/health — server + model status
│   ├── chat.js               #   POST /api/chat — agentic tool loop + SSE proxy
│   ├── sessions.js            #   /api/sessions CRUD (JSON persistence)
│   ├── models.js              #   /api/models CRUD, activate, status/warmup/eject
│   ├── automations.js         #   /api/automations CRUD, run, logs
│   ├── skills.js             #   /api/skills CRUD, toggle, run
│   ├── library.js            #   /api/library CRUD + upload (raw body)
│   ├── channels.js           #   /api/channels — Telegram config/status/toggle
│   ├── fs.js                 #   /api/fs/list, /api/fs/read (file explorer)
│   └── queue.js              #   GET /api/queue — LLM queue stats
│
├── services/                 # business logic (no HTTP)
│   ├── llamaClient.js        # payload build, streaming client, SSE parse,
│   │                         #   /health /props /slots probes, slot supervisor
│   ├── requestQueue.js       # strict FIFO (limit 1) + transient retries/backoff
│   ├── toolLoop.js           # tool registry dispatch, system-prompt builder,
│   │                         #   JSON tool-call extractor, dedup guards,
│   │                         #   automation enforcement
│   ├── chatLoopback.js       # HTTP loopback into /api/chat (channel bridge)
│   ├── telegramBot.js        # Telegram channel: long-poll, auth, replies
│   ├── libraryManager.js     # persistent file library (index + blobs)
│   ├── sessionStore.js       # session persistence (data/sessions.json)
│   ├── modelManager.js       # model registry, active-model resolution,
│   │                         #   writeDotEnvVar (.env key management)
│   ├── modelLifecycle.js     # per-model lifecycle (unloaded/loading/ready/error),
│   │                         #   status probes, warm-up / eject operations
│   ├── skillManager.js       # SKILL.md registry, run/validate/migrate
│   └── automationManager.js  # cron/interval engine, script/skill/prompt actions
│
├── tools/                    # agent tool registry (uniform shape)
│   ├── fileTools.js          #   read_file / write_file / edit_file (sandboxed)
│   ├── shellTools.js         #   run_shell (timeout, destructive-command denylist)
│   ├── skillsTools.js        #   list/run/write/delete_skill
│   ├── automationsTools.js   #   create/list/run/delete_automation
│   ├── libraryTools.js       #   list/read/upload_library_file
│   └── index.js              #   registry = concat of the above (16 tools)
│
├── public/                   # frontend (no build step)
│   ├── index.html            #   single page, CDN Tailwind/marked/highlight.js
│   ├── css/styles.css        #   dark/light theme, sidebar, panels, grid tiles
│   └── js/app.js             #   SSE chat, sessions, explorer, skills, models,
│                             #   automations, library, channels, queue/usage UI
│
├── data/                     # JSON persistence (gitignored runtime state;
│   │                         #   models-state.json is tracked)
│   ├── sessions.json         #   chat sessions (browser s_*, Telegram tg-*, CLI cli)
│   ├── models-state.json     #   model registry + activeId
│   ├── automations-state.json#   automations + logs (bounded 20)
│   ├── skills-state.json     #   skill enabled/disabled state
│   ├── channels-state.json   #   telegram metadata (enabled, whitelist, lastError)
│   ├── library-index.json    #   library file metadata
│   ├── pagent.pid            #   daemon PID file (written by pagent.sh)
│   ├── pagent.log            #   daemon boot/run logs (written by pagent.sh)
│   └── library/              #   library blobs (uuid files)
│
├── skills/                   # workspace skills (user-authored, agent-runnable)
│   └── <name>/SKILL.md       #   YAML frontmatter + Markdown instructions
│
└── scripts/                  # dev utilities / test harnesses
```

## 3. High-Level Component Flow

```
   ┌──────────────┐   ┌───────────────┐   ┌───────────────┐
   │  Web UI      │   │  Telegram     │   │  pagent CLI   │
   │ (browser)    │   │  chat_id      │   │  (terminal)   │
   └──────┬───────┘   └───────┬───────┘   └───────┬───────┘
          │ /api/chat SSE    │ getUpdates·sendMSG │ /api/chat SSE
          │                  │ (telegramBot.js)   │ (bin/pagent.js)
          │                  └─────────┬───────────┘
          │                            │ chatLoopback.runAgentSession()
          │                            │  (POST own /api/chat, consume SSE)
          ▼                            ▼
   ┌───────────────────────────────────────────────────────┐
   │                 /api/chat  (routes/chat.js)           │
   │  agentic tool loop: complete() → tool calls → tools   │
   │  → results fed back → final answer (≤10 iterations)   │
   │  • empty-stream fallback (re-run without tools)       │
   │  • length-cap continuation (≤8 rounds)                │
   │  • automation enforcement                             │
   └───────┬───────────────────────────────┬───────────────┘
           │ completes (SSE)               │ toolLoop.executeTool()
           ▼                               ▼
   ┌───────────────┐              ┌─────────────────────────┐
   │ llamaClient   │              │ tools/ (16 tools)       │
   │ requestQueue  │              │ fileTools / shellTools  │
   │ (FIFO limit 1,│              │ skillsTools /           │
   │  retry+backoff)              │ automationsTools /      │
   │   │                          │ libraryTools            │
   │   ▼                          └─────────┬───────────────┘
   │ llama.cpp / OpenRouter                 ▼
   └───────────────┘              dedup guards (toolLoop):
                                  • exact-args ledger (side-effectful tools)
                                  • consecutive run_shell guard (normalized)
                                  • schema validation before execution
                                          │
         ┌────────────────────────────────┘
         ▼
   sessionStore (data/sessions.json)
   • browser: s_*        (client-persisted)
   • telegram: tg-<chat_id>  (telegramBot.js, history replayed)
   • cli: cli             (bin/pagent.js)
```

## 4. Core Components & Modules

- **Agent Core / ReAct Loop** (`routes/chat.js` + `services/toolLoop.js`):
  Single SSE connection drives the agentic loop. Each turn sends an OpenAI
  `tools` array AND a system prompt that instructs the model to emit exactly
  one JSON object when a tool is needed. The loop: `complete()` → collect
  calls (native `tool_calls` first, else the JSON-block extractor) → execute
  via the registry → feed results back as alternating assistant/user messages
  (this llama build rejects `role:"tool"`) → repeat until a plain-text final
  answer or `toolMaxIterations` (default 10). `type:"status"` SSE events
  stream tool activity (”⚙ Running command: …”) live, and dedup intercepts
  surface as explicit ”⚠ duplicate … skipped” events.
  **Empty-stream fallback:** if a tools-enabled completion ends in an empty
  stream (some providers/models cannot carry the tools array — e.g.
  qwen-2.5-7b via OpenRouter/Phala), the request is re-run WITHOUT the tools
  array (base system prompt) and still streams a conversational answer, with
  a status event explaining the degradation — the turn never stalls.
  **Continuation:** `finish_reason:"length"` outputs are completed in up to 8
  rounds (also recovers truncated JSON tool calls). A slot-aware supervisor
  polls llama.cpp `/slots`; SSE heartbeats keep long streams alive.
  Automation enforcement intercepts explanations on automation-creation
  requests and forces/executes the `create_automation` call.

- **Tool-Calling System** (`tools/` + `services/toolLoop.js`): 16 registered
  tools, each `{ name, description, parameters, execute }` — file tools
  (sandboxed to `workRoot`, traversal-blocked), shell (timeout-clamped,
  destructive-command denylist), skills, automations, and library tools. The
  extractor recognizes fenced ` ```json ` blocks, `<tool_call>` blocks, bare
  `{"tool":…}` objects, and whole-output JSON — always validated against the
  registry. Fragmented native `tool_calls.arguments` are re-joined on JSON
  token boundaries (`joinToolCallArgs`).
  **Deduplication (per chat request):**
  - *Exact-args ledger* — writable/side-effectful tools (file writes,
    automations CRUD) execute once per request; exact repeats are refused with
    a corrective result (`skippedDuplicate`) fed back to the model.
  - *Consecutive `run_shell` guard* — a shell command that just succeeded is
    not executed again back-to-back with the same normalized command, even if
    the model re-emits it re-quoted: `curl -s 'URL'`, `curl -s "URL"` and
    `curl -s URL` compare equal (quote-char + whitespace-insensitive key,
    quoted inner whitespace stays distinct). A repeat after other steps still
    executes (intentional double runs work), and retries of FAILED commands
    still execute (recovery).
  **Validation before execution:** required parameters must be present,
  type-coerced, non-empty and free of placeholder tokens; an invalid call is
  rejected with a corrective `invalidArgs` error (never executed, never
  recorded in the ledger) and surfaces live as a “Tool call rejected” event.

- **Channels & Loopback** (`services/telegramBot.js` + `services/chatLoopback.js`
  + `routes/channels.js`): Telegram long-polls `getUpdates` (no new
  dependencies), processes updates sequentially with exponential backoff, and
  authorizes each chat against the whitelist (`allowedChatIds` from
  `channels-state.json`) plus `TELEGRAM_ADMIN_CHAT_ID` (always allowed,
  non-removable). Authorized messages go through `chatLoopback`, which POSTs
  the conversation to the server's own `/api/chat` and consumes the SSE stream
  — the EXACT pipeline the browser uses (tools, library attachments,
  automations enforcement, request queue), so Telegram requests serialize with
  web/CLI requests on the single model slot. Replies use markdown with a
  plain-text fallback (HTTP 400), chunked at 4000 chars, with a live
  ”⏳ Working…” bubble that is edited into the final answer and a tool-activity
  footer. `/api/channels` exposes status/config: token is written ONLY to
  `.env` via `writeDotEnvVar` (`tokenSet` boolean in responses), the whitelist
  is stored in `channels-state.json`, and a `getMe` test endpoint validates
  connectivity.

- **Terminal CLI** (`bin/pagent.js`): executable zero-dependency client
  (node core + readline), npm-linked as `pagent`. `chat` opens a REPL
  (streaming /api/chat SSE, statuses printed live, commands `/help`, `/exit`,
  `/quit`, `/new`, `/attach`, `/model`; Ctrl+C aborts the in-flight
  generation, second press exits; piped input is serialized and exit waits for
  the in-flight exchange). `pagent chat "<text>"` is one-shot. Management
  subcommands: `sessions`, `models [id]`, `channels [on|off]`, `config
  [set KEY=value]`, with `--json` output. Server-first with offline
  degradation: read-only commands fall back to the local `data/*` files when
  the server is down; secrets are never printed (presence-only).

- **Daemon Orchestration / Process Lifecycle** (`pagent.sh`): root-level bash
  script that owns the server process — no manual `nohup`/PID juggling.
  `--start` verifies node/npm deps, creates `.env` from `.env-example` when
  missing, and refuses double starts (PID file → process scan → port probe),
  then launches `server.js` in the background (nohup, stdout/stderr →
  `data/pagent.log`), records the PID in `data/pagent.pid`, and blocks until
  `/api/health` responds (30s cap; on failure prints the log tail and cleans
  up). `--status` reports PID, uptime (`ps etimes`), port and live health,
  distinguishing tracked / untracked / stale-PID states (exit 1 when down).
  `--stop` sends SIGTERM (the server's handler stops the Telegram poller and
  automation schedulers), waits up to 10s, escalates to SIGKILL, removes the
  PID file and verifies the port is released; servers started outside the
  script are detected by process/port scan and stopped with a warning.
  `PORT` env overrides the port; `NO_COLOR=1`/pipes disable colors.
  Logs are plain appends (no rotation) under the gitignored `data/` tree.

- **Session State Persistence** (`services/sessionStore.js` +
  `data/sessions.json`): one shared store for ALL channels.
  - Browser sessions (`s_*`) are client-driven: the UI POSTs the full message
    array per exchange (replace semantics).
  - Telegram sessions (`tg-<chat_id>`) and CLI sessions (`cli`) are
    server/CLI-driven: `telegramBot.js` (resp. `bin/pagent.js`) load the chat's
    session, replay the last 40 messages into every agent call (conversation
    memory), and append each user/assistant exchange with an
    `📡 via Telegram` / `⌨ via CLI` meta badge. Every channel's history is
    visible in the dashboard sidebar and survives restarts.

- **File Library** (`services/libraryManager.js` + `routes/library.js` +
  `tools/libraryTools.js`): persistent user-file store (blobs in
  `data/library/`, metadata in `library-index.json`), raw-body uploads capped
  at `LIBRARY_MAX_UPLOAD_MB` (50). Chat attachments are resolved server-side
  and inlined into the last user message (60k/file, 120k total caps; binary
  files replaced by metadata pointers to `read_library_file`). The dashboard
  renders the library as a grid of tiles; `pagent` REPL attaches files via
  `/attach`.

- **Memory & Storage** (`data/`, `services/sessionStore.js`,
  `services/skillManager.js`): flat JSON persistence — sessions, model
  registry (re-read per request, masked keys), automations state + bounded
  logs, skills state, channels state, library index + blobs. The config layer
  is env-driven end to end (PORT, LLAMA_*, TOOL_CALLING, TOOL_MAX_ITERATIONS,
  QUEUE_*, TELEGRAM_*, LIBRARY_*, PLIFE_WORK_ROOT, PLIFE_DOTENV_FILE, …).

- **Local LLM Integration** (`services/llamaClient.js` + `requestQueue.js` +
  `services/modelManager.js` + `services/modelLifecycle.js`): the client
  builds the OpenAI-compatible payload
  (system injection, role filtering, sampler overrides,
  `stream_options.include_usage`), opens the upstream SSE stream and parses it
  into `{content, toolCalls, usage, finishReason}`. All completions flow
  through a strict FIFO queue (`QUEUE_LIMIT=1`). Transient failures
  (hang-up/ECONNRESET/empty stream) retry at 350ms; throttling-class errors
  (OpenRouter 402 in-flight-budget, 429 rate-limited) retry at 8s backoff —
  both bounded by `QUEUE_RETRIES`. Endpoints may be `http` or `https`
  (OpenRouter-style remotes). Probes: `/health`, `/props` (context window),
  `/slots` (liveness).
  **Model lifecycle** (`modelLifecycle.js`): per-endpoint probes combine
  `/health`, `/v1/models` (loaded-model check for router-mode servers),
  `/slots` state drift, and the request queue's active flag into a four-state
  badge (`unloaded | loading | ready | error`). "Working" detection is
  dual-signal because llama.cpp builds differ: modern builds populate
  `is_processing`/`n_prompt_tokens_processed` (live prefill %), while others
  never flip `is_processing` and only advance `id_task`/`n_prompt_tokens`
  between polls — a slot-state mutation detector + 2-probe debounce covers
  both, and the request queue is the exact in-flight signal for the active
  model. Warm-up runs a `max_tokens=1` completion through the queue against a
  SPECIFIC endpoint (not the active one). Eject is capability-tiered: true
  unload via the model-router `POST /models/unload` (200/204), degraded
  KV-cache erase (`POST /slots/:id?action=erase`, needs `--slot-save-path`),
  or an honest `degraded:true` response stating the weights stayed resident
  (non-router llama-server answers 404 on `/models/unload`). Remote endpoints
  reject warm-up/eject with 400 — there are no local weights to manage.

- **Automations Engine** (`services/automationManager.js` +
  `routes/automations.js`): dependency-free 5-field cron engine with
  wall-clock aligned intervals, 15s tick started from `server.js`. Actions:
  `script` (workspace-relative, `node`, traversal-blocked), `skill` (via
  skillManager), `prompt` (LLM completion). Logs bounded at 20 entries; runs
  serialize through the request queue. Creation enforcement as described in
  the Agent Core section.

- **Frontend** (`public/`): single-page vanilla JS app with a sidebar
  (SESSIONS accordion + TOOLS: File Explorer, Skills, Models, Automations,
  Library, Channels), streaming chat with Markdown/highlight rendering,
  generation settings + context-budget popovers, stop-generation via
  AbortController, per-message ⚡ duration/token badges, library grid tiles
  with inline delete-confirm state machine, a channels panel (token,
  whitelist, toggle, test-connection, live status meta), and the header model
  lifecycle badge (color-coded dot, amber spinner while loading, warm-up /
  eject dropdown with memory footprint). No build pipeline.

## 5. Data Flow

1. **User input:** the browser sends `POST /api/chat` (SSE); the Telegram bot
   (after whitelist auth) and the CLI loop through `chatLoopback`/`streamChat`
   into the same endpoint, each replaying its persisted session history.
2. **Payload build** (`routes/chat.js` → `services/llamaClient.js`): the
   system prompt (`toolLoop.buildSystemPrompt` = base + tool instructions +
   embedded schema of all 16 tools + automations + library guidance) is
   prepended; the OpenAI `tools` array is attached; attachments are inlined
   into the last user message.
3. **Queue:** the completion enters the strict FIFO request queue (limit 1);
   position surfaced via `X-Queue-Position` + a status event.
4. **Upstream generation:** `complete()` POSTs to the active model's
   `/v1/chat/completions`, consumes the SSE stream, resolves
   `{content, toolCalls, usage, finishReason}`. Slot supervisor + heartbeats
   keep the stream alive.
5. **Tool detection & execution:** native `tool_calls` or an extracted JSON
   block → `toolLoop.executeTool` (dedup guards + validation first) → the call
   is recorded as an assistant message, the result fed back as a user message;
   the loop repeats with extended history. An empty-stream completion
   degrades to a tool-less re-run instead of failing.
6. **Answer:** plain text with no further call → streamed as content chunks,
   then a usage chunk (`elapsedMs` badge) and `data: [DONE]`.
7. **Persistence & UI:** the channel owner persists the exchange — browser:
   client POSTs to `/api/sessions`; Telegram: `telegramBot.js` appends to
   `tg-<chat_id>`; CLI: `bin/pagent.js` appends to `cli` — all into
   `data/sessions.json`, visible in the dashboard sidebar.

## 6. Resilience Notes (learned in production)

- Diagnostic dump (exact upstream payload + raw chunks) is opt-in via
  `PLIFE_DEBUG_DUMP=1` writing `/tmp/plife-dump.log`.
- Provider quirks observed: qwen-2.5-7b-instruct via OpenRouter/Phala returns
  EMPTY streams whenever the `tools` array is present — the empty-stream
  fallback absorbs this, but the reliable agentic defaults are
  deepseek/deepseek-v3.2 (and similar tool-capable remotes).
- Models often re-emit the same shell command back-to-back with different
  quoting — the consecutive `run_shell` guard with quote/whitespace-normalized
  keys is what keeps side effects single-execution in the loop.