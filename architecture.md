# Project Architecture Overview

## 1. Introduction & Tech Stack

plife is a **local AI agent dashboard** that serves a browser UI and an agentic
chat API over a locally hosted llama.cpp backend. It is 100% local by default —
no cloud LLM required — while remaining compatible with remote
OpenAI-style endpoints (OpenRouter etc.) through the same client layer.

- **Runtime:** Node.js >= 18, CommonJS modules; single runtime dependency is
  `express` (^4.19).
- **Backend:** Express app in `server.js` (entry point/router only). Business
  logic is split into `routes/` (thin HTTP layer) and `services/` (no HTTP).
- **Model backend:** llama.cpp `llama-server` exposed via its OpenAI-compatible
  `/v1/chat/completions` SSE endpoint (default `http://127.0.0.1:8080`).
- **Models:** multi-model registry (`data/models-state.json`), all GGUF Q4:
  `gemma-2-2b-it-Q4_K_M.gguf` (default, :8080, active), `qwen2.5-coder-3b-instruct`,
  `mistral-7b-instruct`, `Llama-3.2-3B-Instruct`. Model selection is dynamic —
  the active model's endpoint/model/apiKey is resolved per request, no restart.
- **Model format caveat (important):** this llama.cpp build reports
  `chat_format: Content-only`, so native OpenAI `tool_calls` never fire.
  Tool calling therefore relies on a structured **JSON-block contract** the
  system prompt teaches the model, plus a tolerant client-side extractor.
- **Frontend:** vanilla JS single-page app (`public/`), Gemini-inspired
  dark/light theme, Tailwind/marked/highlight.js from CDNs, SSE chat streaming,
  session list, file explorer, skills, models, and automations panels.
- **Storage:** flat JSON files under `data/` (no database).
  No vector DB — "memory" is session history plus the skills registry.
- **Scheduling:** built-in automations engine (cron/interval), 15s tick,
  never system cron.

## 2. Directory Structure

```
plife/
├── server.js                 # Express init, middleware, route mounting, listener,
│                             #   automation scheduler start/stop (entry only)
├── config.js                 # env-driven config: port, llama params, timeouts,
│                             #   queue limits, workRoot sandbox, tool-loop knobs
├── package.json              # express dependency, npm start/dev scripts
├── README.md                 # usage, API table, llama.cpp notes
├── architecture.md           # this document
│
├── routes/                   # thin HTTP endpoints (request/response only)
│   ├── health.js             #   GET /api/health — server + llama status, context
│   ├── chat.js               #   POST /api/chat — agentic tool loop + SSE proxy
│   ├── sessions.js           #   /api/sessions CRUD (JSON persistence)
│   ├── fs.js                 #   /api/fs/list, /api/fs/read (file explorer)
│   ├── skills.js             #   /api/skills CRUD, toggle, run
│   ├── models.js             #   /api/models CRUD, activate, status probes
│   ├── automations.js        #   /api/automations CRUD, run, logs
│   └── queue.js              #   GET /api/queue — LLM queue stats
│
├── services/                 # business logic (no HTTP)
│   ├── llamaClient.js        # payload build, streaming client, SSE parse,
│   │                         #   /health /props /slots probes, slot supervisor
│   ├── toolLoop.js           # tool registry dispatch, system-prompt builder,
│   │                         #   JSON tool-call extractor, automation enforcement
│   ├── requestQueue.js       # strict FIFO (limit 1) + transient retries/backoff
│   ├── sessionStore.js       # session persistence (data/sessions.json)
│   ├── modelManager.js       # model registry, active-model resolution
│   ├── skillManager.js       # SKILL.md registry, run/validate/migrate
│   └── automationManager.js  # cron/interval engine, script/skill/prompt actions
│
├── tools/                    # agent tool registry (uniform shape)
│   ├── fileTools.js          #   read_file / write_file / edit_file (sandboxed)
│   ├── shellTools.js         #   run_shell (timeout, destructive-command denylist)
│   ├── skillsTools.js        #   list/run/write/delete_skill
│   ├── automationsTools.js   #   create/list/run/delete_automation
│   └── index.js              #   registry = concat of the four (13 tools)
│
├── public/                   # frontend (no build step)
│   ├── index.html            #   single page, CDN Tailwind/marked/highlight.js
│   ├── css/styles.css        #   dark/light theme, sidebar accordions, panels
│   └── js/app.js             #   SSE chat, sessions, file explorer, skills,
│                             #   models, automations, queue/usage UI
│
├── data/                     # JSON persistence (gitignored state)
│   ├── sessions.json         #   chat sessions/messages
│   ├── models-state.json     #   model registry + activeId
│   ├── automations-state.json#   automations + logs (bounded 20)
│   └── skills-state.json     #   skill enabled/disabled state
│
├── skills/                   # workspace skills (user-authored, agent-runnable)
│   └── <name>/SKILL.md       #   YAML frontmatter (name/version/description/entry)
│                             #   + Markdown instructions; run via node run.js
│
└── scripts/                  # test harnesses / dev utilities
    ├── stall-cap-test.js     #   mock-upstream slot-stall scenarios
    ├── enforce-test.js       #   automation-enforcement unit cases
    └── automation-tool-smoke.js # automation API smoke test
```

## 3. Core Components & Modules

- **Agent Core / ReAct Loop** (`routes/chat.js` + `services/toolLoop.js`):
  Single SSE connection to the browser drives an agentic loop. Each turn sends
  an OpenAI `tools` array AND a system prompt that instructs the model to emit
  exactly one JSON object `{"tool":"<name>","args":{...}}` when a tool is
  needed. The loop: complete() -> collect calls (native `tool_calls`, if ever
  emitted, first; else the JSON-block extractor) -> execute via the registry ->
  feed results back as alternating assistant/user messages (this llama build
  rejects `role:"tool"`) -> repeat until a plain-text final answer or
  `toolMaxIterations` (default 10). `type:"status"` SSE events stream tool
  activity ("⚙ Writing file: …") live. `finish_reason:"length"` outputs are
  continued automatically (chunked continuation, up to 8 rounds) instead of
  being truncated — this also recovers JSON tool calls cut off mid-object.
  An automation-enforcement layer intercepts model explanations on
  automation-creation requests and forces/executes the `create_automation`
  call. A slot-aware supervisor polls llama.cpp `/slots` so slow prompt
  processing is never killed by a fixed timeout, while genuinely dead streams
  abort with a status event; SSE heartbeats keep long streams alive.

- **Tool-Calling System** (`tools/` + `services/toolLoop.js`): 13 registered
  tools in the registry (`tools/index.js`), each
  `{ name, description, parameters, execute }` — file tools (read/write/edit,
  sandboxed to `workRoot`, traversal-blocked), shell (timeout-clamped,
  destructive-command denylist), skills tools, and automations tools. The
  system prompt embeds the full JSON schema of every tool, and
  `toOpenAITools()` builds the parallel OpenAI `tools` array. The extractor
  (`extractToolCall`) recognizes, in order: fenced ` ```json ` blocks,
  `<tool_call>` blocks, a bare object with a `"tool"` key anywhere in the text,
  or whole-output pure JSON — each candidate must parse as valid JSON and name
  a registered tool (validation never throws; results come back as
  `{ok, …}` objects, so the loop always has something to feed back).
  Streaming robustness: native `tool_calls.arguments` fragments can split
  mid-token (`"scripts/c` + `urrent"`); `joinToolCallArgs` re-joins them on
  JSON token boundaries (quote re-balancing) so parsed args are not silently
  emptied. Per-execution safety rails live in `toolLoop.executeTool` + the
  chat loop: exact-duplicate calls (same name + canonical args, one chat
  request) are refused with a "duplicate tool call skipped" result —
  writable/side-effectful tools (file writes, automations CRUD) execute once —
  while `run_shell`/`run_skill`/`run_automation` stay exempt (repeatable on
  purpose); a tool that throws is converted to an `{ok:false}` result (never
  crashes the loop); and every call is schema-validated BEFORE execution
  (`validateArgs`): required parameters must be present, type-coerced
  (numeric strings like `"5"` become numbers), non-empty and free of
  placeholder tokens (`?`, `...`, `<path>`, `N/A`, `your_file_name`) — an
  invalid call is rejected with a corrective `invalidArgs` error that is fed
  back to the model for retry (never executed, never recorded in the dedup
  ledger), surfacing live as a "Tool call rejected" status event.

- **Memory & Storage** (`data/`, `services/sessionStore.js`,
  `services/skillManager.js`): flat JSON persistence — sessions (messages with
  per-message usage metadata), model registry (`models-state.json`,
  re-read per request; masked API keys), automations state + bounded logs, and
  per-skill enabled state (`skills-state.json`). Skills live as
  `skills/<name>/SKILL.md` (frontmatter + Markdown instructions) with an entry
  script run by `run_skill`; legacy `skill.json` skills auto-migrate. The
  config layer (`config.js`) is env-driven end to end (PORT, LLAMA_*,
  TOOL_CALLING, TOOL_MAX_ITERATIONS, QUEUE_*, PLIFE_WORK_ROOT, …). No vector
  database — retrieval is session history + the skills registry only.

- **Local LLM Integration** (`services/llamaClient.js` + `requestQueue.js` +
  `services/modelManager.js`): the client builds the OpenAI-compatible payload
  (system injection, role filtering, sampler overrides,
  `stream_options.include_usage` for real token counts), opens the upstream
  SSE stream, and parses it into `{content, toolCalls, usage, finishReason}`.
  All completions flow through a strict FIFO queue (`QUEUE_LIMIT=1` — parallel
  requests to a single-slot llama.cpp produce empty streams), with transient
  failures (hang-up/ECONNRESET/empty stream) re-queued at the back with
  backoff. Endpoints may be `http` or `https` (OpenRouter-style remotes work).
  Probes: `/health` (status), `/props` (context window), `/slots` (liveness).

- **Automations Engine** (`services/automationManager.js` +
  `routes/automations.js`): dependency-free 5-field cron engine with wall-clock
  aligned intervals (no drift/catch-up storms), 15s tick started from
  `server.js`. Actions: `script` (workspace-relative, `node`, traversal-blocked),
  `skill` (via skillManager), `prompt` (LLM completion with a directive task
  system prompt — the bare default makes small models emit whitespace).
  Logs bounded at 20 entries; runs are serialized through the request queue.
  Automation-creation enforcement: when the current user turn commands a
  creation, the loop intercepts explanations instead of `create_automation`
  calls (forced corrective rounds, then server-side creation inferred from the
  user's wording). A successful `create_automation` through the NORMAL tool
  path marks the request settled, so the model's legitimate final answer is
  never misread as an evasion (this false-positive previously burned the
  iteration budget and reported "max tool steps" for a task that had already
  succeeded).

- **Frontend** (`public/`): single-page vanilla JS app with a sidebar
  (SESSIONS accordion + TOOLS: File Explorer, Skills, Models, Automations),
  streaming chat with Markdown/highlight rendering, generation settings and
  context-budget popovers, stop-generation via AbortController, per-message
  ⚡ duration/token badges, and a queue-position status event. All panels are
  plain JS view toggles over the REST/SSE APIs — no build pipeline.

## 4. Data Flow

1. **User input:** the browser sends `POST /api/chat` (JSON `{messages,
   generation?}`) and holds an SSE connection open.
2. **Payload build** (`routes/chat.js` -> `services/llamaClient.js`): a system
   prompt is assembled (`toolLoop.buildSystemPrompt` = base prompt + tool
   instructions + embedded JSON schema of all 13 tools + automations guidance)
   and prepended to history; the OpenAI `tools` array is attached; sampler
   overrides from the UI's `generation` object are applied.
3. **Queue:** the call enters the strict FIFO request queue (limit 1); queue
   position is surfaced via `X-Queue-Position` and a status event.
4. **Upstream generation:** `complete()` -> `doComplete()` POSTs the payload to
   the active model's `/v1/chat/completions`, consumes the SSE stream, and
   resolves `{content, toolCalls, usage, finishReason}` (chunks are also
   forwarded live for the non-tool path). The slot supervisor and SSE
   heartbeats keep the stream alive.
5. **Tool detection & execution:** if native `tool_calls` or an
   extractable JSON block is found, `toolLoop.executeTool` runs the tool; the
   call is recorded as an assistant message and the result fed back as a user
   message; the loop repeats (step 4) with the extended history.
6. **Answer:** when the model replies with plain text and no further call, the
   text is streamed to the browser as OpenAI-format content chunks, followed by
   a usage chunk (`usage.elapsedMs` badge) and `data: [DONE]`.
7. **Persistence & UI:** the exchange is saved to `data/sessions.json` via
   `sessionStore`; the frontend renders the transcript with Markdown/syntax
   highlighting and updates the context/token budget display.

(Note: while debugging tool-call formatting, a diagnostic dump in
`services/llamaClient.js` appended the exact upstream payload and raw response
chunks to `/tmp/plife-dump.log`. The investigation concluded — root causes:
fragmented native tool-call arguments silently parsing to `{}`, no duplicate-
call guard, and the automation-enforcement false-positive — and the dump is
now opt-in via `PLIFE_DEBUG_DUMP=1` (`config.debugDump`).)