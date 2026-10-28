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
│   ├── models.js              #   /api/models CRUD, activate, status/warmup, /:id/load,eject
│   ├── templates.js           #   /api/models/templates — launch-template CRUD
│   ├── automations.js         #   /api/automations CRUD, run, logs
│   ├── skills.js             #   /api/skills CRUD, toggle, run
│   ├── library.js            #   /api/library CRUD + upload (raw body)
│   ├── channels.js           #   /api/channels — Telegram config/status/toggle
│   ├── fs.js                 #   /api/fs list/read/write/patch (explorer + editor)
│   ├── memory.js             #   /api/memory — global facts + workspace MEMORY.md
│   ├── queue.js              #   GET /api/queue — LLM queue stats
│   ├── system.js             #   GET /api/system/metrics — RAM/CPU (os module)
│   └── systemPrompt.js       #   GET/POST/DELETE /api/system/prompt — prompt override
│
├── services/                 # business logic (no HTTP)
│   ├── llamaClient.js        # payload build, streaming client, SSE parse,
│   │                         #   /health /props /slots probes, slot supervisor
│   ├── requestQueue.js       # strict FIFO (limit 1) + transient retries/backoff
│   ├── toolLoop.js           # tool registry dispatch, system-prompt builder,
│   │                         #   JSON tool-call extractor, dedup guards,
│   │                         #   automation enforcement
│   ├── agentPaths.js        #   two-zone path resolver: agent tool paths
│   │                         #   default to workspaces/, "../" = project root
│   ├── chatLoopback.js       # HTTP loopback into /api/chat (channel bridge)
│   ├── telegramBot.js        # Telegram channel: long-poll, auth, replies
│   ├── libraryManager.js     # persistent file library (index + blobs)
│   ├── sessionStore.js       # session persistence (data/sessions.json)
│   ├── modelManager.js       # model registry, active-model resolution,
│   │                         #   writeDotEnvVar (.env key management)
│   ├── modelLifecycle.js     # lifecycle state, status probes, warm-up/eject + systemd
│   │                         #   template-unit generation (launch templates, 0.0.0.0 bind)
│   ├── templateStore.js      # launch templates (llama-server flag sets, CRUD + validation)
│   ├── cascade.js            # two-stage cascade orchestration (router → primary units)
│   ├── systemPrompt.js       # system-prompt override persistence (data/system-prompt.txt)
│   ├── skillManager.js       # SKILL.md registry, run/validate/migrate
│   ├── automationManager.js  # cron/interval engine, script/skill/prompt actions
│   ├── embedder.js           # memory embeddings: xenova → ollama → hash chain
│   ├── vectorMemory.js       # global memory store (node:sqlite, cosine top-k)
│   ├── workspaceMemory.js    # workspace MEMORY.md store (fixed path, 48 KiB cap)
│   └── memoryContext.js      # per-turn memory tail builder (cache-safe append)
│
├── tools/                    # agent tool registry (uniform shape)
│   ├── fileTools.js          #   read_file / write_file / edit_file (sandboxed)
│   ├── shellTools.js         #   run_shell (timeout, destructive-command denylist)
│   ├── skillsTools.js        #   list/run/write/delete_skill
│   ├── automationsTools.js   #   create/list/run/delete_automation
│   ├── libraryTools.js       #   list/read/upload_library_file
│   ├── globalMemory.js       #   manage_global_memory (add/delete/search/list)
│   ├── workspaceMemory.js    #   update_workspace_memory (read/append/overwrite)
│   └── index.js              #   registry = concat of the above (18 tools)
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
│   ├── system-prompt.txt     #   system prompt override (Tools → System panel, optional)
│   ├── library-index.json    #   library file metadata
│   ├── pagent.pid            #   daemon PID file (written by pagent.sh)
│   ├── pagent.log            #   daemon boot/run logs (written by pagent.sh)
│   └── library/              #   library blobs (uuid files)
│
├── workspaces/                   # agent workspace: scripts/ (harnesses + user runtime
│   │                             #   scripts), skills/ (user-authored, agent-runnable),
│   │                             #   MEMORY.md (workspace memory), agent outputs
│   └── skills/<name>/SKILL.md    #   YAML frontmatter + Markdown instructions
│
└── scripts/                      # (removed 2026-10-28 — all content moved to workspaces/scripts/)
```

### 2.1 Agent workspace + two-zone path resolution

Since 2026-10-28 the former root `scripts/` and `skills/` directories live inside `workspaces/` (test harnesses + user runtime scripts, agent-managed skills, `MEMORY.md`, agent outputs). `config.workspaceDir` (env `WORKSPACE_DIR`) defaults to `<workRoot>/workspaces/`; `config.skillsRoot` points the skills store at `<workspaceDir>/skills` (skillManager binds at require).

`services/agentPaths.js` implements the zone rule applied to AGENT tool paths (chat loop + executeTool; the File Explorer/fs routes bypass it and browse the project root directly):

- BARE relative paths (`scripts/foo.py`) → `workspaces/scripts/foo.py` — the workspace is the agent's default working directory
- `..` / `../x` → the **project root** (one level up from the workspace: `..` maps to `.`, `../routes/fs.js` maps to `routes/fs.js`)
- `../../x` and absolute paths → rejected; `workspaces/x` passes through; placeholder-shaped paths bypass zoning so the validation gates see the raw value
- `list_files` with no path lists the workspace; `run_shell`'s cwd IS the workspace (`cd ..` reaches the root). Automation scripts keep cwd = project root (agent-written scripts referenced by automations use `workspaces/scripts/…`); automation logs land in the root `logs/`.
- The hard sandbox is still `workRoot` (`resolveWithin`) — zoning only picks WHERE inside the project a bare path lands; nothing can escape.

The trading dashboard runs as a systemd USER unit (`trading-dashboard.service`, workdir `workspaces/skills/trading-dashboard/`, port 3005) like the llama servers.

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
  answer. There is **no round ceiling and no duplicate suppression** —
  identical repeat calls execute with fresh state, and the loop runs until
  the model answers, the client stops the turn, or the repeated-invalid-call
  freeze trips. `type:"status"` SSE events stream tool activity (”⚙ Running
  command: …”) live.
  **Reasoning relay:** reasoning-capable models stream their thinking
  separately — llama.cpp/OpenRouter `reasoning_content` deltas (and locally
  emitted ` thinking... ` / `.../thinking` tags) are extracted every round and
  relayed as `type:"reasoning"` SSE events distinct from the answer text;
  round boundaries wipe the trace buffer so each round's thinking stays
  attributted. The client renders a collapsible "Thinking…" panel, splits
  ` thinking... ` tags itself, auto-collapses at the first answer token, and a
  global visibility toggle (compose toolbar) hides all panels without
  stopping the trace collection (state: `localStorage` `pagent.showReasoning`
  legacy key; see the reasoning controller below).
  **System-prompt override:** every turn consults
  `services/systemPrompt.getOverride()` — a persisted
  `data/system-prompt.txt` (Tools → System panel) REPLACES the generated
  template byte-for-byte on both the tool path and the tool-less path.
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
  The extractor recognizes fenced ```json blocks, XML tool tags
    (`<tools>` — Qwen2.5-Coder —, `<tool_call>`, `<function-calls>`), bare
    `{"tool":…}` / `{"name":…,"arguments":…}` objects, and whole-output JSON —
    always validated against the registry (exact registered name; `name`/`tool`
    and `arguments`/`args` key aliases; several calls per completion execute in
    emission order). Fragmented native `tool_calls.arguments` are re-joined on
    JSON token boundaries (`joinToolCallArgs`).
  **No duplicate suppression, no round ceiling:** every tool call executes
  exactly as emitted, however often the same (tool, args) already ran in the
  request — a model re-running a grep or re-reading a file after an edit gets
  FRESH state and is never skipped as a "duplicate", and the tool loop has no
  iteration cap: it ends only on a plain-text final answer, a lost client, a
  manual stop, or the repeated-invalid-call freeze (the old per-request
  exact-args ledger, the consecutive-`run_shell` guard, the alternation
  detector, the redundant-churn guard and the 64-round execution ceiling
  were all removed).
  **Validation before execution:** required parameters must be present,
  type-coerced, non-empty and free of placeholder tokens; an invalid call is
  rejected with a corrective `invalidArgs` error (never executed) and
  surfaces live as a “Tool call rejected” event.
  The rejection names the missing key AND the expected shape
  (`Expected format: {"path": …}` / `{"command": "your_shell_command_here"}`
  — the hint's own placeholder text is itself caught by the placeholder gate,
  so the example can never execute as a real command).
  **Argument normalization (pre-validation):** small models emit the right
  value under the wrong key or as a bare unkeyed string. `normalizeFileToolArgs`
  maps `file`/`filepath`/`file_path`/`filename`/`src`/`target` and bare strings
  → `path` (file tools); `normalizeShellToolArgs` maps
  `cmd`/`exec`/`script`/`c`/`shell_command` and bare strings → `command`
  (run_shell). Status labels
  resolve the same aliases (`labelPath`/`labelCommand` in routes/chat.js), so
  the feed shows the real path/command pre-execution.
  **Anti-loop safety:** the only structural stop is the repeated-invalid-call
  freeze — the SAME invalid emission repeated 3× in one request fails fast
  and forces the final answer instead of looping forever. There is no
  repetition detection and no round ceiling, so identical repeats of
  any tool call execute (verification re-runs after edits are legitimate);
  conversation-based path recovery is
  whitelisted to read_file/write_file/edit_file ONLY — never inferred for
  run_shell, delete_file, skills, or automations (exactly one unique
  workRoot-resolving candidate, non-URL, real content still required for
  writes/edits).

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
  is env-driven end to end (PORT, LLAMA_*, TOOL_CALLING,
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
  SPECIFIC endpoint (not the active one).
  **Load / Eject (systemd units):** `POST /api/models/:id/load` derives a
  systemd *user unit* `~/.config/systemd/user/llama-<id>.service` from the
  model's launch template (`services/templateStore.js` + Templates tab; flags
  validated: `-m`/`--host`/`--port` may not appear in templates), resolves the
  GGUF path (config → `~/llama.cpp` → `/home/hermesai/llama.cpp`), and always
  appends `-m <path> --host 0.0.0.0` LAST — llama.cpp's last-wins parsing
  makes the bind authoritative over any template arg, and loopback health
  probes still work against 0.0.0.0. Auto-generated units carry a
  `p-agent launch template` marker in their Description: on the next Load they
  are re-rendered whenever the derivation changed (self-healing flag fixes),
  while hand-crafted units without the marker are preserved untouched.
  Activating a model (`POST /api/models/:id/activate`) also queues a
  background warm-up (warm-on-activate). **Eject is tiered:** native unload
  via the model-router `POST /models/unload` (200/204) → an active-model busy
  guard (probe `/slots`; any in-flight request → 409, never kill mid-request)
  → **systemd unit-stop** (`systemctl --user stop llama-<id>.service` —
  process terminates, ALL memory freed; the tier that actually works on this
  llama.cpp build) → honest `{ok:true, unloaded:false, degraded:true}` for
  hand-run servers with no unit (weights stayed resident — never claimed
  otherwise). Remote endpoints reject warm-up/eject/load with 400 — there are
  no local weights to manage.
  **Identity-scoped status (port sharing):** several registry entries may
  share one loopback port. `modelManager` resolves the served identity once
  per endpoint per sweep (`/v1/models` alias ids — llama.cpp `--alias`
  values — plus `/props` model_path, ~1.5s in-flight cache) and matches it
  against each entry's GGUF name via `endpointServes`. Only the genuinely
  loaded model reports online/lifecycle `ready`; same-port siblings get a
  `conflict` lifecycle (online:false, "port busy" label, Load not Eject) and
  registry status `conflict`; routers serving nothing report unloaded.
  `launch()` returns 409 instead of spawning onto a port occupied by a
  foreign model; `eject()` refuses (409) to unload/stop a server whose
  occupant isn't the target unless the target's own unit is active.
  **Reasoning levels:** the 5-level controller (Off/Default/Low/Medium/High)
  rides every `/api/chat` body as `reasoningLevel`; routes/chat.js threads it
  onto the shared `gen` object so every `buildChatPayload` call site
  (plain/tool-loop/cascade) inherits it from one line. Mapping in
  `llamaClient.buildChatPayload` (opts-layer wins, then gen-layer):
  `off` → `reasoning_effort:"none"` (this llama.cpp build natively erases the
  chat-template kwarg = thinking disabled); `low|medium|high` →
  `reasoning_effort` + (loopback endpoints only) Anthropic-style
  `thinking:{type:"enabled", budget_tokens: 1024|4096|16384}` which
  server-chat.cpp maps to `thinking_budget_tokens`; `default`/unknown →
  dropped entirely. The parameters touch the PAYLOAD ONLY — never the prompt —
  so the KV prefix is byte-stable across levels (tested), except caps-style
  templates that bake effort into their own rendering (one-time prefill after
  a level switch). Cloud endpoints never get the `thinking` field.

- **Automations Engine** (`services/automationManager.js` +
  `routes/automations.js`): dependency-free 5-field cron engine with
  wall-clock aligned intervals, 15s tick started from `server.js`. Actions:
  `script` (workspace-relative, `node`, traversal-blocked), `skill` (via
  skillManager), `prompt` (LLM completion). Logs bounded at 20 entries; runs
  serialize through the request queue. Creation enforcement as described in
  the Agent Core section.

- **Frontend** (`public/`): single-page vanilla JS app with a sidebar
  (SESSIONS accordion + TOOLS: File Explorer, Skills, Models, Automations,
  Library, Channels, System), streaming chat with Markdown/highlight
  rendering, per-message collapsible **Thinking…** panels (live reasoning
  stream, auto-collapse on answer, global visibility toggle + 5-level
  effort dropdown in the compose toolbar, `localStorage`
  `pagent.reasoningLevel`), generation settings (incl. the **Advanced local
  params** toggle — `generation.advancedParams` — auto-disabled with a hint
  when the active model is cloud-hosted) + context-budget popovers,
  stop-generation via AbortController, per-message ⚡ duration/token badges,
  library grid tiles with inline delete-confirm state machine, a channels
  panel (token, whitelist, toggle, test-connection, live status meta), the
  Models panel with category sections, per-model **Load/Eject** buttons and
  a Templates tab, the header model lifecycle badge (color-coded dot, amber
  spinner while loading, warm-up / eject dropdown with memory footprint),
  the **System** view (full-size mono system-prompt editor with Save /
  Reset-to-default, custom badge), and a system resource monitor
  (RAM/CPU circular gauges, 5s poll, delta-based CPU percentage). No build
  pipeline.

## 5. Data Flow

1. **User input:** the browser sends `POST /api/chat` (SSE); the Telegram bot
   (after whitelist auth) and the CLI loop through `chatLoopback`/`streamChat`
   into the same endpoint, each replaying its persisted session history.
2. **Payload build** (`routes/chat.js` → `services/llamaClient.js`): the
   system prompt — the per-turn override from `data/system-prompt.txt` when
   set (Tools → System), else `toolLoop.buildSystemPrompt` (short base +
   compact tool-call instructions; NO embedded tool schema — that duplicated
   ~3,400 tokens and is dropped) — is prepended; the FULL 16-tool array
   (name-sorted, identical serialization on every request — stable,
   warm-up-compatible prefix) is attached; `cache_prompt: true` tells
   llama.cpp to reuse its KV cache for the stable prefix; the selected
   `reasoningLevel` is mapped to `reasoning_effort` / `thinking.budget_tokens`
   (payload-only, NEVER prompt bytes — KV-prefix-stable, see Local LLM
   Integration); attachments are inlined into the last user message.
   Provider-aware sanitization runs last on the payload: llama.cpp-only keys
   (`repeat_penalty`, `repeat_last_n`, `cache_prompt`) are stripped for
   cloud endpoints (Nvidia NIM rejects them with HTTP 400) and on local
   endpoints when `generation.advancedParams` is false; a cloud 400 mentioning
   unsupported parameters triggers ONE retry with the minimal OpenAI-safe
   payload before the provider error surfaces.
   Dynamic content (dates, request ids, session ids) is NEVER part of the
   prefix — only the per-turn tail is new, so the second message of a
   conversation re-evaluates just the new message + last reply. Every
   completion logs `[llm] … prefix=<sha>`; a mid-process prefix change logs
   a warning. (`LAZY_TOOLS=true` re-enables an experimental topic-based
   subset, kept for experiments — it breaks prefix stability when a tool
   group appears mid-conversation.)
3. **Output limits & history compaction** (`services/historyManager.js`):
   tool results are serialized and truncated ONCE at insertion into the
   history (head+tail with a clear `[truncated N chars. …]` marker;
   run_shell keeps mostly the tail); read_file gained 1-based offset/limit
   and a per-call char cap; list_files caps listed entries and reports the
   omitted count. The history budget = server n_ctx (/props, read-only)
   − prefix − 1024 reserve − 5% margin. Compaction is a deterministic
   REPLAY (pure function of the raw message list, fixed chars/3.4
   estimator — NEVER the per-request usage.prompt_tokens calibration,
   which only feeds logs/UI): turns are walked from the start and an event
   fires only when the running estimate crosses the 75% high watermark,
   bringing the state to the 50% low watermark — oldest tool results
   stubbed first, then oldest complete turns dropped, never touching the
   last 3 user turns or the system prompt. The state carries forward, so
   the cut is sticky: between events every request reproduces the
   byte-identical compacted prefix (llama.cpp cache stays valid; only the
   new messages re-evaluate). Compactions are logged with tokens
   before/after and estRePrefill = tokens AFTER THE FIRST CHANGED POSITION
   ÷ last measured prompt speed (not removed tokens), and announced to the
   UI ("Context trimmed, next reply may take longer (est. re-prefill
   ~Ns)"). A context-exceeded error compacts and retries once, then
   errors clearly.
4. **Queue:** the completion enters the strict FIFO request queue (limit 1);
   position surfaced via `X-Queue-Position` + a status event. A
   "Processing prompt (cold start…)" status event appears after ~2.5s of
   silence and is cancelled on the first byte; the lifecycle badge shows
   prefill % from `/slots`.
5. **Upstream generation:** `complete()` POSTs to the active model's
   `/v1/chat/completions`, consumes the SSE stream, resolves
   `{content, toolCalls, usage, timings, finishReason, firstTokenMs}`. Slot
   supervisor + heartbeats keep the stream alive. Every completion logs
   `[llm] prompt/eval/cached · pp/gen tok/s · ttft · wall · prefix`; the usage
   SSE chunk carries `timings` for the message badge ("6.1k tok (5.9k cached) ·
   12.1/2.6 tok/s").
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

   ### 5.1 Two-tier semantic memory

   - **Workspace memory** (`MEMORY.md` at the workspace root): project facts,
     decisions, conventions. Read into the request context on EVERY turn while
     present; managed via `update_workspace_memory` (read/append/overwrite,
     fixed path, 48 KiB cap — the file rides inside every prompt).
   - **Global memory** (`data/vector-memory.db`, `node:sqlite`): facts with
     categories and Float32 embeddings (384-dim). The per-turn builder embeds
     the user's latest message and retrieves the top-k (default 3) by cosine
     similarity; managed via `manage_global_memory`
     (add/delete/search/list) or the sidebar Memory tab.
   - **Embedding chain** (`services/embedder.js`): `auto` → xenova
     (all-MiniLM-L6-v2, local, ~90 MB one-time download) → ollama
     (OLLAMA_URL) → deterministic hash fallback (stemmed word + n-gram
     hashing, 384-dim, deps-free; keyword-overlap quality). Boot pre-warms
     the provider so the first real turn never pays the model load.
   - **Cache-safe injection (deliberate deviation from "system prompt"
     placement)**: dynamic memory blocks ride as the LAST message of the
     request (`[Memory context …] <workspace_memory>…</workspace_memory>
     <global_user_memory>…</global_user_memory>`), NEVER inside the system
     message — dynamic content in the prefix would invalidate the llama.cpp
     KV cache every turn (minutes of CPU prefill on this host). The system
     prompt (template AND the data/system-prompt.txt override) carries only
     STATIC guidance about the blocks. The tail is appended at call time by
     `withMemory(msgs)` in routes/chat.js on primary rounds (the router
     stage stays byte-stable); it never enters session history/compaction.
     Failure-hard: embedding errors/timeouts degrade to "no context", chat
     proceeds unchanged.

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