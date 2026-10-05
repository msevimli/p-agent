/**
 * historyManager.js — deterministic tool-result truncation + cache-friendly
 * history compaction.
 *
 * PROMPT-CACHE CONTRACT (llama.cpp):
 *  - A tool result is truncated EXACTLY ONCE, when it is serialized into the
 *    conversation, so its text never changes on a later turn (re-truncating
 *    differently would change the prompt and invalidate the KV cache).
 *  - Compaction is a pure function of the message list: the same raw history
 *    always compacts to the same text, so every request reproducibly sends
 *    the same compacted prefix and the cache stays valid across turns.
 *  - Compaction uses watermarks (high/low), NOT trim-one-message-per-turn:
 *    removing a message every turn would shift the whole history and
 *    invalidate the cache on every single request.
 *  - Never involves the model (no summarization — too slow on this CPU).
 */

const config = require('../config');
const crypto = require('crypto');

// --- token estimation -------------------------------------------------------

// Conservative chars-per-token (Qwen2 measures ~3.9–4.5 for the prompt text;
// 3.4 overestimates tokens, which is the safe direction for a context budget).
const CHARS_PER_TOKEN = 3.4;
// Per-message template overhead estimated from the Qwen chat template
// (im_start/im_end/role tokens, ~8–13 tokens per small message).
const MSG_OVERHEAD_TOKENS = 8;

/** Cheap deterministic token estimate: chars/3.4 (+ per-message overhead). */
function estimateTokens(text) {
  return Math.ceil((String(text || '').length / CHARS_PER_TOKEN) + MSG_OVERHEAD_TOKENS);
}

/** Token estimate of a whole message list (excludes the system prompt). */
function historyTokens(messages) {
  let n = 0;
  for (const m of messages || []) {
    if (!m || m.role === 'system') continue; // prefix is budgeted separately
    n += estimateTokens(m.content);
  }
  return n;
}

// --- deterministic truncation ----------------------------------------------

const SPLIT_STRATEGIES = {
  // Errors and results usually land at the end of shell output: keep mostly
  // the tail, plus a short head for context.
  run_shell: { headPct: 0.15, tailPct: 0.85 },
};
const DEFAULT_SPLIT = { headPct: 0.5, tailPct: 0.5 };

/** Per-tool char budget: TOOL_OUTPUT_MAX_CHARS, overridable per tool via
 * TOOL_OUTPUT_MAX_CHARS_<NAME_UPPER> (e.g. TOOL_OUTPUT_MAX_CHARS_RUN_SHELL). */
function maxCharsFor(toolName) {
  const key = 'TOOL_OUTPUT_MAX_CHARS_' + String(toolName || '').toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v > 0 ? v : config.toolOutputMaxChars;
}

/**
 * Truncate a serialized tool result string to maxChars, keeping head + tail
 * with a clear marker in the middle. Pure function of (text, budget): the
 * same input always yields the same output.
 */
function truncateForHistory(toolName, text, maxChars) {
  const s = String(text || '');
  const cap = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : maxCharsFor(toolName);
  if (s.length <= cap) return s;
  const split = SPLIT_STRATEGIES[toolName] || DEFAULT_SPLIT;
  const removed = s.length - cap;
  const hint =
    toolName === 'run_shell'
      ? 'Re-run with output redirected to a file or use a narrower command to see more.'
      : 'Use read_file with offset and limit to read a specific range.';
  const marker = `\n…[truncated ${removed} chars. ${hint}]…\n`;
  // The marker is part of the stored text, so head+tail share the remaining
  // budget — total length is exactly `cap`, deterministically.
  const body = Math.max(0, cap - marker.length);
  const headLen = Math.floor(body * split.headPct);
  const tailLen = body - headLen;
  return s.slice(0, headLen) + marker + s.slice(s.length - tailLen);
}

/**
 * Build the '[Tool results]' history message for one tool-loop round.
 * Each result is serialized ONCE and truncated ONCE here (key order of
 * JSON.stringify is per-tool stable, so the stored text is deterministic).
 */
function formatToolResults(results) {
  const lines = (results || []).map((r) => {
    const text = JSON.stringify(r.result);
    return `${r.name}: ${truncateForHistory(r.name, text)}`;
  });
  return '[Tool results]\n' + lines.join('\n') + '\nContinue working; use more tools if needed, then reply with your final answer.';
}

/** Error classification: did llama.cpp reject for context overflow? */
function isContextError(err) {
  const msg = String((err && err.message) || err);
  return /context|n_ctx|too (long|large)|exceed/i.test(msg);
}

// --- context budget ---------------------------------------------------------

let lastCtxTokens = null;
let lastCtxFetch = 0;

/**
 * Per-slot context size, read from the server (/slots → n_ctx), cached 60s,
 * falling back to config (server value always wins when reachable).
 */
async function contextTokens() {
  const now = Date.now();
  if (lastCtxTokens !== null && now - lastCtxFetch < 60000) return lastCtxTokens;
  try {
    const { llamaClient } = require('./llamaClient');
    const n = await llamaClient.getContextWindow(); // GET /props (read-only)
    if (Number.isFinite(n) && n > 0) {
      lastCtxTokens = n;
      lastCtxFetch = now;
      return n;
    }
  } catch { /* server unreachable — fall through to fallback */ }
  lastCtxTokens = config.contextWindowFallback;
  lastCtxFetch = now;
  return lastCtxTokens;
}

/** Budget = ctx − prefix − reply reserve − safety% × ctx. */
function budgetFor(ctxTokens, prefixTokens) {
  const ctx = ctxTokens || config.contextWindowFallback;
  const prefix = prefixTokens || config.promptPrefixTokens;
  const budget = ctx - prefix - config.contextReserveTokens - Math.round((ctx * config.contextSafetyPct) / 100);
  const high = Math.round((budget * config.contextCompactHighPct) / 100);
  const low = Math.round((budget * config.contextCompactLowPct) / 100);
  return { ctx, prefix, budget, high, low };
}

// --- compaction -------------------------------------------------------------

const TOOL_RESULTS_PREFIX = '[Tool results]';
const STUB_TEXT = '[old tool result removed to save context]';

/** Indices of messages that START a user turn: user-role messages that are
 *  NOT tool-result blocks (a turn runs from such a message up to, but not
 *  including, the next one, so tool calls and their results always share a
 *  turn and are dropped together). */
function turnBoundaries(messages) {
  const starts = [];
  for (let i = 0; i < (messages || []).length; i++) {
    const m = messages[i];
    if (m && m.role === 'user' && !String(m.content || '').startsWith(TOOL_RESULTS_PREFIX) && String(m.content || '') !== STUB_TEXT) starts.push(i);
  }
  return starts;
}

/**
 * One compaction event: deterministic stub + drop pass over a working list
 * until its estimated tokens are <= low. Leaves the protected window (the
 * last `keepTurns` user turns plus the current in-flight turn) untouched and
 * never splits a tool call from its result (a turn is dropped whole).
 */
function compactOnce(work, low, keepTurns) {
  if (historyTokens(work) <= low) return { work, removed: [] };
  const removed = [];

  const starts = turnBoundaries(work);
  const protectFrom =
    starts.length > keepTurns
      ? starts[starts.length - keepTurns]
      : (starts.length > 0 ? starts[0] : 1);

  // Phase 1 — stub the oldest tool-result messages OUTSIDE the protected
  // window (keeps the assistant's tool-call and reply; the result itself is
  // text the model no longer needs verbatim).
  for (let i = 1; i < work.length && i < protectFrom && historyTokens(work) > low; i++) {
    const m = work[i];
    if (!m || m.role !== 'user') continue;
    if (typeof m.content === 'string' && m.content.startsWith(TOOL_RESULTS_PREFIX)) {
      const oldLen = String(m.content).length;
      removed.push(`stubbed tool result (user msg ${i}, ${oldLen} chars -> stub)`);
      work[i] = { role: 'user', content: STUB_TEXT };
    }
  }

  // Phase 2 — drop the oldest complete turns still outside the protected
  // window. A turn = one non-tool-result user message plus everything up to
  // the next one, so a tool call and its result are always dropped together;
  // the system prompt (index 0) can never be dropped. Stub messages are NOT
  // turn boundaries (they replace a results block inside an existing turn),
  // so this can never strand a stub without its turn. starts/dropUntil are
  // recomputed every iteration: splices shift indices and the stale absolute
  // dropUntil would let the loop cut into the protected window.
  let cut = 1;
  while (historyTokens(work) > low) {
    const starts = turnBoundaries(work);
    const dropUntil = starts.length > keepTurns ? starts[starts.length - keepTurns] : 1;
    if (cut >= dropUntil) break; // only the protected window remains
    const next = starts.find((s) => s > cut);
    const end = next === undefined ? work.length : next;
    if (end <= cut) break; // safety: no progress
    const dropped = work.slice(cut, end);
    removed.push(`dropped turn ${cut}..${end - 1}: ${dropped.map((m) => m.role).join('+')} (${dropped.reduce((n, m) => n + String(m.content || '').length, 0)} chars)`);
    work.splice(cut, end - cut);
  }

  return { work, removed };
}

/**
 * Deterministic history compaction via REPLAY of the conversation.
 *
 * Because the server has no session store, the route rebuilds history from
 * the client's raw messages on every request. Compacting "the raw history
 * from scratch" every request would advance the cut by one turn each time
 * (after an event the state sits just below the low watermark, and the next
 * appended turn pushes it over again) — the boundary would shift on every
 * turn and the llama.cpp KV cache would be re-processed for a growing chunk
 * on every request.
 *
 * Instead we replay the conversation turn by turn from the start with the
 * FIXED estimator (chars/3.4 + 8/msg — never the per-request usage
 * calibration): turns are appended to a running state and a compaction event
 * fires only when the running estimate crosses the HIGH watermark. The state
 * is carried forward, so the cut is STICKY: between events the compacted
 * prefix is byte-identical across requests, and a boundary moves only on a
 * real compaction event. Deterministic by construction (fixed estimator,
 * fixed rule, same turn order), so request N's replay reproduces request
 * N-1's compacted prefix exactly.
 *
 * opts: { high, low, keepTurns, force }. `high` defaults to 0 (compact on
 * every step — used by the context-exceeded retry path and by callers that
 * pass only a low watermark); `force` is accepted for readability of those
 * call sites.
 */
function compactHistory(messages, opts) {
  const keepTurns = Math.max(0, (opts && opts.keepTurns) || config.contextKeepLastTurns);
  if (!Array.isArray(messages) || messages.length === 0) return { messages: messages || [], removed: [], before: 0, after: 0 };

  const low = (opts && opts.low) || 0;
  const high = opts && Number.isFinite(opts.high) && opts.high > 0 ? opts.high : 0;

  const starts = turnBoundaries(messages);
  const head = messages.slice(0, starts.length ? starts[0] : messages.length); // system + any pre-first-turn msgs: never compacted
  const spans = [];
  starts.forEach((s, i) => {
    const e = i + 1 < starts.length ? starts[i + 1] : messages.length;
    spans.push(messages.slice(s, e));
  });

  const state = head.slice();
  let removed = [];
  let before = 0;
  for (const span of spans) {
    state.push(...span);
    const est = historyTokens(state);
    if (est > high) {
      const r = compactOnce(state, low, keepTurns);
      if (r.removed.length) {
        if (!removed.length) before = est; // estimate at the FIRST mutation
        for (const m of r.removed) removed.push(m);
      }
    }
  }
  return { messages: state, removed, before, after: historyTokens(state) };
}

/**
 * Index of the first message where two lists differ (role or content), or
 * min(a.length, b.length) when one is a prefix of the other, or b.length
 * when they are identical. Used to tell "boundary moved" from "only the
 * trailing messages changed" across requests.
 */
function firstDiffIndex(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i].role === b[i].role && String(a[i].content || '') === String(b[i].content || '')) i++;
  return i;
}

/**
 * Estimated tokens that llama.cpp must re-process when `output` is sent
 * after `input` was cached: prompt tokens from the FIRST CHANGED MESSAGE to
 * the end of the output (message roles+contents compared index-wise). 0 when
 * the text is identical. This is what a re-prefill actually costs — NOT the
 * number of removed tokens (the tail after the cut must be re-read too).
 */
function repreffillTokens(inputMessages, outputMessages) {
  const i = firstDiffIndex(inputMessages || [], outputMessages || []);
  const b = outputMessages || [];
  if (i === (inputMessages || []).length && i === b.length) return 0;
  let tokens = 0;
  for (let j = i; j < b.length; j++) tokens += estimateTokens(b[j].content);
  return tokens;
}

// The compacted message list of the previous request in this process, so a
// compaction that only re-applies the same stubs (no boundary move) is not
// reported as a fresh event and the re-prefill estimate is computed against
// the prompt llama.cpp actually has cached. The estimate is best-effort
// after a process restart (llama's KV cache may outlive us; a stale memo
// only over-approximates the first logged re-prefill).
let lastCompactOutput = null;
function rememberLastCompactOutput(messages) {
  lastCompactOutput = messages && messages.length ? messages.slice() : null;
}

/**
 * Re-prefill estimate for the current request: tokens after the first
 * changed position vs the PREVIOUS request's compacted history (the cached
 * prompt), or vs the raw input when nothing was cached yet. Plus a flag
 * whether the compaction boundary actually MOVED (the output diverges from
 * the previous output before its trailing messages), which is what the log
 * and the UI notice should announce — re-applying identical stubs to the
 * same raw history is a cache no-op and must stay quiet.
 */
function compactionDelta(inputMessages, outputMessages) {
  const out = outputMessages || [];
  const rePrefill = lastCompactOutput
    ? repreffillTokens(lastCompactOutput, out)
    : repreffillTokens(inputMessages || [], out);
  const idx = lastCompactOutput ? firstDiffIndex(lastCompactOutput, out) : -1;
  const prevLen = lastCompactOutput ? lastCompactOutput.length : -1;
  const moved = !lastCompactOutput || idx < prevLen - 1;
  return { rePrefill, moved, firstDiffIndex: idx < 0 ? 0 : idx };
}

// --- prefix hash (Change 1 verification) -----------------------------------

// Short hash of the serialized prefix (system prompt + tools). Each llamaClient
// completion logs `prefix=<hash>`; a change mid-process (tools/config edited at
// runtime) raises a warning. The hash is computed from the payload actually
// sent, so warm-up and real requests must agree by construction.
let lastPrefixHash = null;
let prefixHashWarned = false;

function prefixHashFor(systemText, toolsJson) {
  const s = String(systemText || '') + '\u0000' + String(toolsJson || '[]');
  const h = crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
  if (lastPrefixHash !== null && lastPrefixHash !== h && !prefixHashWarned) {
    console.warn(`[prefix] WARNING: prompt prefix hash changed mid-process: ${lastPrefixHash} -> ${h}. ` +
      'The llama.cpp KV cache is now invalid (tools or system prompt mutated at runtime).');
    prefixHashWarned = true;
  }
  lastPrefixHash = h;
  return h;
}

module.exports = {
  estimateTokens,
  historyTokens,
  truncateForHistory,
  maxCharsFor,
  formatToolResults,
  isContextError,
  contextTokens,
  budgetFor,
  compactHistory,
  repreffillTokens,
  firstDiffIndex,
  compactionDelta,
  rememberLastCompactOutput,
  prefixHashFor,
  STUB_TEXT,
};