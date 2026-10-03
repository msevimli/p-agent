# plife — Local AI Agent Dashboard

A modern, Gemini-inspired web dashboard for a local AI agent, powered by **llama.cpp**.
Clean dark/light theme, streaming responses, Markdown + syntax highlighting, and
persistent chat sessions.

## Quick start

```bash
cd /home/openclaw/plife
npm install
npm start          # → http://localhost:8888
```

> Frontend loads Tailwind, marked, and highlight.js from CDNs — an internet
> connection is needed for the UI styling on first load. Chat itself is fully local.

## Project structure

Modular backend — `server.js` is a lean entry point/router only; logic lives in
dedicated modules ready for tool-calling.

```
plife/
├── server.js              # Express init, middleware, route mounting, listener
├── config.js              # env-driven config (port, llama, paths, sandbox)
├── routes/                # HTTP endpoints (thin request/response)
│   ├── health.js          #   GET /api/health
│   ├── chat.js            #   POST /api/chat (streaming proxy)
│   └── sessions.js        #   /api/sessions CRUD
├── services/              # business logic (no HTTP)
│   ├── llamaClient.js     # llama.cpp client: payload build, SSE parse, probes
│   ├── sessionStore.js    # session persistence (JSON file)
│   └── toolLoop.js        # tool registry dispatch (executeTool, listTools)
└── tools/                 # agent tools, uniform {name,description,parameters,execute}
    ├── fileTools.js       # read_file / write_file / edit_file (sandbox-guarded)
    ├── shellTools.js      # run_shell (timeout + safety denylist)
    └── index.js           # tool registry (consumed by toolLoop)
```

- **File tools** are restricted strictly to `config.workRoot` (default the plife
  project directory) — path traversal and absolute-size escapes are rejected.
- **Shell tool** runs in the workspace with a 30s timeout and blocks
  destructive commands (`shutdown`, `mkfs`, raw-disk writes, fork bombs, etc.).
- **Tool loop** (`services/toolLoop.js`) drives the agentic loop: the chat
  route sends the OpenAI `tools` array plus a system prompt teaching the model
  a structured JSON-block call (`{"tool":"<name>","args":{...}}`). Tool calls
  are intercepted and executed via the registry; results are fed back as
  alternating assistant/user messages (template-safe), and the loop runs up to
  `TOOL_MAX_ITERATIONS` (default 10) until the model gives a final answer.
  Live `type:"status"` SSE events ("Reading file: …", "Running command: …")
  stream to the frontend so the UI shows what the agent is doing.
  Disable with `TOOL_CALLING=false` (falls back to plain single-shot chat).

## Connecting to llama.cpp

The server proxies to llama.cpp's OpenAI-compatible endpoint at
`http://localhost:8080` by default. Start llama.cpp first:

```bash
llama-server -m /path/to/model.gguf --port 8080
```

Override endpoint / model / sampling with env vars:

```bash
LLAMA_BASE_URL=http://127.0.0.1:8080 LLAMA_MODEL=qwen2.5-1.5b-instruct-q4_0.gguf npm start
```

All sampling params are env-configurable: `LLAMA_TEMPERATURE`, `LLAMA_TOP_P`,
`LLAMA_TOP_K`, `LLAMA_MIN_P`, `LLAMA_REPEAT_PENALTY` (default 1.2; 1.0 = off),
`LLAMA_REPEAT_LAST_N`, `LLAMA_MAX_TOKENS` (default 2048), `LLAMA_SYSTEM_PROMPT`.

### Fixing repetition / corrupted output

- The llama-server on :8080 may be stuck in `Content-only` mode and unable to
  apply a chat template to `/v1/chat/completions`. This server builds a raw
  ChatML prompt string itself (system first, then alternating user/assistant
  history, ending with an open `<|im_start|>assistant\n` turn) and sends it to
  the raw `/completion` endpoint, bypassing llama.cpp's broken template
  parser. Response chunks are re-shaped into the OpenAI streaming form the
  frontend already consumes.
- A system message is always prepended, and full history is carried in the
  prompt.
- Use `repeat_penalty` / `repeat_last_n` (already defaulted) to break loops;
  llama.cpp does not reliably honor OpenAI's `frequency_penalty`.
- If responses are still **incoherent at temperature 0** (greedy decoding), the
  fault is the model file or server runtime, not this server: a correct ChatML
  prompt to `/completion` should produce grammatical, on-topic text. Corrupted
  or truncated `.gguf` files produce exactly this "knows the words, can't
  assemble them" garbage — re-download/verify the model and restart
  llama-server.

## Frontend

Gemini-style dark/light dashboard. Near the prompt bar:

- **Context budget button** (left) opens a popover showing active-session token
  usage vs the model's context window, a fill % progress bar, and the latest
  run's Input/Output token split. Uses real usage statics from llama.cpp
  (`stream_options.include_usage`) when available; falls back to a
  ~4 chars/token estimate otherwise.
- **Generation settings button** (right) opens a popover with live
  Temperature, Top-P, and Max-tokens controls, sent per-request as a
  `generation` object to `/api/chat`. Click-away or Escape closes the popovers.
- **Delete confirmation**: clicking ✕ on a session swaps it to an inline
  Confirm (✓) / Cancel (✕) state; the session is only removed once confirmed.
- **Stop generation**: while a response streams, the send button becomes a
  red pulsing Stop. Clicking it aborts the fetch via an `AbortController`,
  freezes the partial response in the chat (persisted with a "stopped" note),
  and restores the send button.

## API

| Method | Route            | Description                              |
|--------|------------------|------------------------------------------|
| GET    | `/api/health`    | Server + llama.cpp connection status     |
| POST   | `/api/chat`      | Proxy chat to llama.cpp (SSE streaming)  |
| GET    | `/api/sessions`  | List saved sessions                      |
| POST   | `/api/sessions`  | Create / update a session                |
| DELETE | `/api/sessions/:id` | Delete a session                      |

## Structure

```
plife/
├── server.js            # Express server, llama.cpp proxy, session persistence
├── package.json
└── public/
    ├── index.html       # Dashboard shell (Tailwind markup)
    ├── css/styles.css   # Custom styling, markdown, theming
    └── js/app.js        # Chat, streaming, sessions, sidebar, theme logic
```

Sessions are stored in `data/sessions.json` (gitignored).