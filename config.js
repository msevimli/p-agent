/**
 * Central application configuration for plife.
 * Every value is overridable via environment variables.
 */
const fs = require('fs');
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

// Project root = the directory that holds server.js (/home/openclaw/plife).
const ROOT_DIR = path.resolve(__dirname);

module.exports = {
  // --- server ---------------------------------------------------------------
  port: Number(process.env.PORT || 8888),
  publicDir: path.join(ROOT_DIR, 'public'),
  // Secrets live in <root>/.env (gitignored). PLIFE_DOTENV_FILE overrides the
  // path (tests, containers).
  dotEnvFile: process.env.PLIFE_DOTENV_FILE || path.join(ROOT_DIR, '.env'),

  // --- llama.cpp client -----------------------------------------------------
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
  // the SSE forever. After the first byte, liveness is decided dynamically by
  // polling GET /slots (see llamaSlotPollMs / llamaSlotCheckSilenceMs): while
  // any slot reports processing, generation is allowed to run indefinitely;
  // a slot confirmed idle without a result aborts the stream.
  llamaStallTimeoutMs: Number(process.env.LLAMA_STALL_TIMEOUT_MS || 120000),
  // Timeout (ms) for a single model warm-up completion (POST /api/models/warmup).
  // The warm-up shares the request queue with chat, so queue wait is not part
  // of this budget — it bounds the upstream HTTP call itself.
  warmupTimeoutMs: Number(process.env.WARMUP_TIMEOUT_MS || 120000),
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
  // Tool calling: enable/disable the agentic loop and cap its iterations so a
  // runaway model can't loop forever.
  toolCallingEnabled: process.env.TOOL_CALLING !== 'false',
  toolMaxIterations: Number(process.env.TOOL_MAX_ITERATIONS || 10),
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
};