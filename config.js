/**
 * Central application configuration for plife.
 * Every value is overridable via environment variables.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// --- dependency-free .env loader ------------------------------------------
// Reads <project>/.env (KEY=VALUE lines; '#' comments; optional quotes) into
// process.env WITHOUT overriding variables that are already set — so a real
// shell export or a systemd/container env still wins. .env is gitignored and
// is the home for secrets like LLAMA_API_KEY, keeping them out of
// data/models-state.json (where the Models UI would otherwise store them in
// plaintext) and out of the repository.
(function loadDotEnv() {
  const envFile = process.env.PLIFE_DOTENV_FILE || path.join(__dirname, '.env');
  let raw;
  try { raw = fs.readFileSync(envFile, 'utf8'); } catch { return; }
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (k && process.env[k] === undefined) process.env[k] = v;
  }
})();

// Project root = the directory that holds server.js (/home/hermesai/p-agent).
const ROOT_DIR = path.resolve(__dirname);

module.exports = {
  // --- server ---------------------------------------------------------------
  port: Number(process.env.PORT || 8888),
  publicDir: path.join(ROOT_DIR, 'public'),
  // Secrets live in <root>/.env (gitignored). PLIFE_DOTENV_FILE overrides the
  // path (tests, containers).
  dotEnvFile: process.env.PLIFE_DOTENV_FILE || path.join(ROOT_DIR, '.env'),

  // --- llama.cpp client -----------------------------------------------------
  // Checkout whose build/bin/llama-server generates launch units from
  // templates (defaults to ~/llama.cpp; override with LLAMA_CPP_DIR).
  llamaCppDir: process.env.LLAMA_CPP_DIR || path.join(os.homedir(), 'llama.cpp'),
  llamaBaseUrl: (process.env.LLAMA_BASE_URL || 'http://127.0.0.1:8080').replace(/\/+$/, ''),
  llamaModel: process.env.LLAMA_MODEL || 'gemma-2-2b-it-Q4_K_M.gguf',
  // Optional bearer token for remote OpenAI-compatible endpoints (local llama.cpp needs none).
  llamaApiKey: process.env.LLAMA_API_KEY || '',
  llamaTemperature: Number(process.env.LLAMA_TEMPERATURE || 0.7),
  llamaTopP: Number(process.env.LLAMA_TOP_P || 0.95),
  // Native llama.cpp sampler params; ~1.1 breaks repetition loops.
  llamaRepeatPenalty: Number(process.env.LLAMA_REPEAT_PENALTY || 1.1),
  llamaRepeatLastN: Number(process.env.LLAMA_REPEAT_LAST_N || 256),
  // Caps per-turn generation so a stream always terminates at [DONE].
  // Bumped for heavy code outputs; length-capped streams are completed by
  // the chat loop's chunked continuation (see continuationMaxRounds).
  llamaMaxTokens: Number(process.env.LLAMA_MAX_TOKENS || 4096),
  // No-data grace period (ms) for upstream streams, PRE-first-byte and as the
  // backstop when /slots is unavailable: a silent llama.cpp (no SSE bytes at
  // all, incl. time-to-first-token) is aborted after this instead of hanging
  // the SSE forever. Default 5 min so a cold-start prefill on a slow CPU
  // (~10 tok/s × ~2,000-token prefix ≈ 3+ min) is never cut off by the clock;
  // while /slots is available the slot supervisor self-extends anyway. After
  // the first byte, liveness is decided dynamically by polling GET /slots
  // (see llamaSlotPollMs / llamaSlotCheckSilenceMs): while any slot reports
  // processing, generation is allowed to run indefinitely; a slot confirmed
  // idle without a result aborts the stream.
  llamaStallTimeoutMs: Number(process.env.LLAMA_STALL_TIMEOUT_MS || 1200000),
  // Timeout (ms) for a single model warm-up completion (POST /api/models/warmup).
  // The warm-up shares the request queue with chat, so queue wait is not part
  // of this budget — it bounds the upstream HTTP call itself. Long enough for
  // a full cold prefill of the static prefix on a CPU server.
  warmupTimeoutMs: Number(process.env.WARMUP_TIMEOUT_MS || 1200000),
  // Pre-warm the active model on agent startup (one max_tokens=1 completion
  // containing only the static system prompt + all tools, so the prefix is
  // already in the llama.cpp KV cache before the first real message).
  autoWarmup: process.env.AUTO_WARMUP !== 'false',
  // Tool selection: default = ALL tools, always, in a fixed (name-sorted)
  // order, so the tools block is byte-identical across requests and the
  // warm-up cache always matches real requests. LAZY_TOOLS=true re-enables
  // the topic-based subset (kept for experiments; breaks the prefix cache
  // when a tool group appears mid-conversation).
  lazyTools: process.env.LAZY_TOOLS === 'true',

  // --- context budget & history compaction (see services/historyManager.js)
  // Reserve (tokens) kept for the reply, safety margin (% of context), and
  // the high/low watermarks (% of the budget) at which history is compacted.
  contextReserveTokens: Number(process.env.CONTEXT_RESERVE_TOKENS || 1024),
  contextSafetyPct: Number(process.env.CONTEXT_SAFETY_PCT || 5),
  contextCompactHighPct: Number(process.env.CONTEXT_COMPACT_HIGH_PCT || 75),
  contextCompactLowPct: Number(process.env.CONTEXT_COMPACT_LOW_PCT || 50),
  // Number of most recent user turns never touched by compaction.
  contextKeepLastTurns: Number(process.env.CONTEXT_KEEP_LAST_TURNS || 3),
  // Estimate of the static prefix (system prompt + tools rendering) used for
  // the budget math until the server reports the real cached prefix. The
  // real server-rendered value measures ~2,390 with all 16 tools (warm-up
  // prompt_tokens minus the 44-token "ping" message + template; +44 tokens
  // since the run_shell/curl sentence was added to the system prompt);
  // llama.cpp's tool template renders ~400 tokens more than the bare JSON sim
  // (1,922 tokens).
  promptPrefixTokens: Number(process.env.PROMPT_PREFIX_TOKENS || 2450),
  // Fallback context window when /slots is unreachable (server value wins).
  contextWindowFallback: Number(process.env.CONTEXT_WINDOW_FALLBACK || 16384),

  // --- tool output limits (applied once, at history insertion)
  // Max characters of a serialized tool result stored in the conversation.
  toolOutputMaxChars: Number(process.env.TOOL_OUTPUT_MAX_CHARS || 4000),
  // Default max characters read_file returns in one call (offset/limit allow
  // reading large files in pieces).
  readFileMaxChars: Number(process.env.READ_FILE_MAX_CHARS || 6000),
  // Max entries list_files returns in one call (the rest is counted, not
  // listed, to keep the prompt small).
  listFilesMaxEntries: Number(process.env.LIST_FILES_MAX_ENTRIES || 200),
  // File explorer (dashboard) write cap: the editor refuses to save larger
  // payloads than this (bytes). The agentic write_file tool is unaffected.
  // 32 MiB — matches the read caps so anything viewable is editable, and
  // server.js's express.json({limit:'64mb'}) stays well above the worst-case
  // JSON escaping of a payload this size.
  fsWriteMaxChars: Number(process.env.FS_WRITE_MAX_CHARS || 33554432),
  // File explorer read cap (bytes): both the plain view and the editor load
  // the WHOLE file (no preview truncation since 2026-10-29; the agentic
  // read_file tool keeps its own smaller cap + offset/limit for context
  // protection). Only files larger than this refuse loudly (413).
  fsReadFullMaxChars: Number(process.env.FS_READ_FULL_MAX_CHARS || 33554432),
  // How often the slot-liveness supervisor polls GET /slots during stream
  // silence (ms).
  llamaSlotPollMs: Number(process.env.LLAMA_SLOT_POLL_MS || 4000),
  // Minimum stream silence (ms) before the supervisor consults /slots at all.
  llamaSlotCheckSilenceMs: Number(process.env.LLAMA_SLOT_CHECK_SILENCE_MS || 15000),
  // How many extra rounds a length-capped (max_tokens hit) generation may
  // continue for before giving up on the truncated tail.
  continuationMaxRounds: Number(process.env.LLAMA_CONTINUATION_MAX_ROUNDS || 8),
  // Corrective rounds the tool loop may force when a model answers an
  // automation-creation request with instructions instead of a create_automation
  // tool call (see toolLoop automation-enforcement helpers).
  maxAutomationForcedRounds: Number(process.env.AUTOMATION_FORCED_ROUNDS || 2),
  // SSE keep-alive: comment-line heartbeat sent to the browser every interval
  // of stream inactivity, so proxies/connections never drop a long-running
  // generation (queue waits, tool steps, slow TTFT) while work is alive.
  sseHeartbeatMs: Number(process.env.SSE_HEARTBEAT_MS || 15000),
  llamaSystemPrompt: process.env.LLAMA_SYSTEM_PROMPT || 'You are a helpful AI assistant.',
  // Tool calling: enable/disable the agentic loop. There is NO iteration
  // cap — the loop ends only on a plain-text final answer, a lost client,
  // a manual stop, or the repeated-invalid-call freeze in routes/chat.js.
  toolCallingEnabled: process.env.TOOL_CALLING !== 'false',
  // Guard retry (step 3): when the model answers with a shell/curl description
  // instead of a tool call, retry once with tool_choice:"required". Requires a
  // llama.cpp build that accepts the field on the OpenAI-compat API; set
  // GUARD_RETRY_TOOL_CHOICE=false for servers that reject it.
  guardRetryToolChoice: process.env.GUARD_RETRY_TOOL_CHOICE !== 'false',

  // --- two-stage model cascade (services/cascade.js) --------------------------
  // Route stage 1 (intent + tool selection) to a fast 'router' model and
  // stage 2 (final generation) to a heavy 'primary' model. Effective only when
  // BOTH roles exist in models-state.json (and the router is a local loopback
  // endpoint); otherwise chat uses the active model exactly as before.
  twoStageCascade: process.env.TWO_STAGE_CASCADE !== 'false',
  // Escalation mode for non-tool router replies:
  //   'marker'  — escalate only when the router replies ROUTE_TO_PRIMARY (default)
  //   'always'  — every non-tool router reply is re-generated by the primary
  //   'never'   — router replies are final unless tools were involved
  cascadeEscalate: String(process.env.CASCADE_ESCALATE || 'marker').toLowerCase(),
  // Router output cap: tool-call JSON / marker / short direct answers. Keeps
  // stage 1 tiny and fast; the primary handles anything longer.
  routerMaxTokens: Number(process.env.ROUTER_MAX_TOKENS || 1024),
  // Sampler for routing decisions: near-greedy keeps tool selection stable.
  routerTemperature: Number(process.env.ROUTER_TEMPERATURE || 0.1),
  // Boot-time model management: auto-start the cascade servers (systemd user
  // units llama-router/llama-primary) and warm both prefixes on p-agent start.
  autoManageModels: process.env.AUTO_MANAGE_MODELS !== 'false',
  // Diagnostic: when true, llamaClient appends the exact upstream payload and
  // raw SSE chunks to /tmp/plife-dump.log (was unconditional while debugging
  // tool-call formatting; off by default — it writes a lot).
  debugDump: process.env.PLIFE_DEBUG_DUMP === '1',

  // --- automations ------------------------------------------------------------
  // Per-run timeout (ms) for scheduled/on-demand automation actions
  // (workspace scripts, skills, and LLM prompt tasks).
  automationTimeoutMs: Number(process.env.AUTOMATION_TIMEOUT_MS || 60000),

  // --- Telegram channel ---------------------------------------------------------
  // Base URL for the Telegram Bot API (override in tests to a local mock).
  telegramApiBase: (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, ''),
  // Long-poll seconds per getUpdates call (max 50).
  telegramPollTimeoutSec: Number(process.env.TELEGRAM_POLL_TIMEOUT || 50),
  // HTTP request timeout for Telegram API calls (ms).
  telegramRequestTimeoutMs: Number(process.env.TELEGRAM_REQUEST_TIMEOUT_MS || 60000),
  // Max characters per outbound Telegram message (API hard cap 4096).
  telegramMaxReplyChars: Number(process.env.TELEGRAM_MAX_REPLY_CHARS || 4000),

  // --- request queue ------------------------------------------------------------
  // Max concurrent upstream LLM/heavy requests (1 = strict serialization, right
  // for a single-slot llama.cpp). Raise for multi-slot servers.
  queueLimit: Number(process.env.QUEUE_LIMIT || 1),
  // Extra attempts for queued items that fail transiently (network/timeouts/
  // empty streams); the item re-enters the FIFO at the back.
  queueRetries: Number(process.env.QUEUE_RETRIES || 2),

  // --- storage & tool sandbox -----------------------------------------------
  dataDir: path.join(ROOT_DIR, 'data'),
  // Persistent file Library: uploaded blobs live here, metadata in
  // data/library-index.json (both under data/*, i.e. gitignored runtime state).
  libraryDir: path.join(ROOT_DIR, 'data', 'library'),
  // Per-upload cap for the Library API (bytes; 413 beyond it).
  libraryMaxUploadBytes: Number(process.env.LIBRARY_MAX_UPLOAD_MB || 50) * 1048576,
  sessionsFile: path.join(ROOT_DIR, 'data', 'sessions.json'),
  // File/shell tools may operate strictly inside this sandbox root
  // (defaults to the plife project directory; override with PLIFE_WORK_ROOT).
  workRoot: path.resolve(process.env.PLIFE_WORK_ROOT || ROOT_DIR),

  // --- semantic memory -----------------------------------------------------
  // Two-tier memory: (1) WORKSPACE memory = MEMORY.md inside the AGENT
  // WORKSPACE (project facts; injected into every prompt while present);
  // (2) GLOBAL vector memory = SQLite store of (fact, category, embedding)
  // with local embeddings, top-k retrieved per turn.
  // SQLite DB path (node:sqlite; env-redirectable for tests).
  vectorMemoryDb: process.env.VECTOR_MEMORY_DB || path.join(ROOT_DIR, 'data', 'vector-memory.db'),
  // Embedding provider: auto | xenova | ollama | hash.
  //  - xenova: @xenova/transformers all-MiniLM-L6-v2 (local, 384-dim,
  //    ~90 MB weights downloaded to the HF cache on first use)
  //  - ollama: POST /api/embeddings on OLLAMA_URL (default localhost:11434)
  //  - hash: built-in deterministic 384-dim n-gram hashing (no deps; the
  //    offline/CI fallback — keyword-overlap similarity, not semantic)
  //  - auto: xenova when importable, else ollama if reachable, else hash.
  memoryEmbedder: process.env.VECTOR_MEMORY_EMBEDDER || 'auto',
  memoryEmbedderOllamaUrl: process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
  // How many global facts the per-turn context injection may include.
  memoryTopK: Number(process.env.MEMORY_TOP_K || 3),
  // MEMORY.md cap — the file is injected into EVERY request, so it must
  // stay small (writes/append beyond this are rejected; reads capped too).
  memoryFileMaxChars: Number(process.env.MEMORY_FILE_MAX_CHARS || 49152),
  // Active workspace memory file: MEMORY.md inside the agent workspace by
  // default (env override is for tests only).
  workspaceMemoryFile: path.join(
    path.resolve(process.env.WORKSPACE_DIR || path.join(path.resolve(process.env.PLIFE_WORK_ROOT || ROOT_DIR), 'workspaces')),
    process.env.WORKSPACE_MEMORY_FILE || 'MEMORY.md'
  ),
  // Agent workspace: the default working directory for agent file tools and
  // run_shell (bare paths land here; "../"-prefixed paths are project-root-
  // relative). The hard sandbox stays workRoot — zoning only picks where
  // inside the project a bare path lands.
  workspaceDir: path.resolve(process.env.WORKSPACE_DIR || path.join(path.resolve(process.env.PLIFE_WORK_ROOT || ROOT_DIR), 'workspaces')),
  // Skills store: agent-managed skills live inside the agent workspace.
  skillsRoot: path.join(
    path.resolve(process.env.WORKSPACE_DIR || path.join(path.resolve(process.env.PLIFE_WORK_ROOT || ROOT_DIR), 'workspaces')),
    'skills'
  ),
};