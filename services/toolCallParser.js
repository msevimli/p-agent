/**
 * services/toolCallParser.js — tolerant fallback for MISFORMATTED tool calls
 * + the no-tool guard retry.
 *
 * Background: on some llama.cpp builds (e.g. local Qwen2.5-Coder) the model
 * answers "what is the current Solana price? use curl" by printing the call
 * wrapped in an XML tag — <tools>…</tools> (Qwen2.5) or
 * <function-calls>…</function-calls> — that the server does NOT parse into
 * message.tool_calls. These helpers detect that shape in the ASSISTANT's own
 * content and convert it into the same native tool-call the loop executes —
 * with strict rules so injected text can never trigger a call.
 *
 * SAFETY CONTRACT:
 *  - Only the assistant's own completion content is ever parsed. Tool
 *    results, user messages and retrieved text are NEVER parsed (they can
 *    contain injected tags) — the route guarantees this by only calling
 *    parseFallbackToolCall(acc.content, …).
 *  - The tool name must EXACTLY match a registered tool. Both key shapes are
 *    accepted: OpenAI/Qwen { name, arguments } and the plife contract
 *    { tool, args } (arguments/args interchangeable; arguments may be an
 *    object or a JSON string; missing args → {}).
 *  - The call then goes through the exact same execution path as a native
 *    call (toolLoop.executeTool → validateArgs), so schema checks,
 *    placeholder rejection, dedup and side-effect guards all apply.
 *  - Invalid candidates are NEVER executed and their raw text stays in the
 *    message. Valid candidates are executed — one completion may carry
 *    several <tools> blocks or an array of calls (multi-call turns).
 *  - The tag/fence text of executed calls is removed from the stored/visible
 *    message.
 *
 * Everything here is a pure function — unit-testable without a server.
 */
'use strict';

// Stable retry instruction (step 3 of the task): fed back as a user message
// exactly once per user message when the model answered with a shell/curl
// description instead of a tool call. Kept as a constant so the prompt text
// (and hence the llama.cpp cache) never changes.
const GUARD_RETRY_MSG =
  'Call the appropriate tool now instead of describing the command. Do not ask the user to run anything — only the tool result matters.';

// Accepted tag variants — inner text must be one JSON object, an array of
// objects, or several bare objects; each call carries "name"+"arguments"
// (OpenAI/Qwen2.5 shape) or "tool"+"args" (plife contract).
const TAG_PATTERNS = [
  { variant: 'tools', re: /<tools>([\s\S]*?)<\/tools>/g },
  { variant: 'tool', re: /<tool>([\s\S]*?)<\/tool>/g },
  { variant: 'tool_call', re: /<tool_call>([\s\S]*?)<\/tool_call>/g },
  { variant: 'tool_calls', re: /<tool_calls>([\s\S]*?)<\/tool_calls>/g },
  { variant: 'function_call', re: /<function_call>([\s\S]*?)<\/function_call>/g },
  { variant: 'function_calls', re: /<function-calls>([\s\S]*?)<\/function-calls>/g },
  // Fenced JSON code block (``` or ```json). Other languages (```bash …)
  // are intentionally NOT candidates — they are shell blocks, handled by
  // the guard retry instead.
  { variant: 'json_fence', re: /```(?:json)?[ \t]*\n?[ \t]*([\s\S]*?)```/g },
];

/** Every tag/fence occurrence in the content, in document order. */
function findCandidates(content) {
  const candidates = [];
  const s = String(content || '');
  for (const { variant, re } of TAG_PATTERNS) {
    re.lastIndex = 0;
    for (const m of s.matchAll(re)) {
      candidates.push({ variant, payload: m[1], raw: m[0], index: m.index });
    }
  }
  return candidates;
}

/**
 * Balanced {...} JSON candidates inside a payload, in document order — used
 * for tags holding several bare objects (no enclosing array). String-aware
 * brace matching; fragments capped at 2000 chars, scan bounded to 8000.
 */
function findJsonFragments(text) {
  const out = [];
  const s = String(text || '').slice(0, 8000);
  let i = 0;
  while ((i = s.indexOf('{', i)) !== -1) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let j = i; j < s.length; j++) {
      const ch = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { end = j; break; }
      }
    }
    if (end > i && end - i <= 2000) out.push(s.slice(i, end + 1));
    i = end > i ? end + 1 : i + 1; // step past a found fragment, else advance
  }
  return out;
}

/**
 * One call object. Accepts the OpenAI/Qwen2.5 shape { name, arguments } and
 * the plife contract { tool, args }, keys interchangeable; `arguments` may
 * be an object or a JSON string; a missing args key defaults to {}. Null
 * when invalid (no exact registered name, or unparseable args).
 */
function validateCallObject(o, allowedNames) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const name = (typeof o.name === 'string' && o.name) || (typeof o.tool === 'string' && o.tool) || '';
  if (!name || !allowedNames.has(name)) return null; // exact registered name
  let args = o.arguments !== undefined ? o.arguments : o.args;
  if (args === undefined) args = {};
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      return null; // arguments as a JSON string must parse
    }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  return { name, args };
}

/** Parse a tag payload: one JSON doc (object|array) or several bare objects.
 *  Returns { calls, parsed } — parsed=false means the payload was NOT a
 *  single JSON document (the bare-object scan may still yield calls). */
function parsePayloadObjects(payload, names) {
  const calls = [];
  if (!payload) return { calls, parsed: false };
  try {
    const whole = JSON.parse(payload);
    const arr = Array.isArray(whole) ? whole : [whole];
    for (const o of arr) {
      const v = validateCallObject(o, names);
      if (v) calls.push(v);
    }
    return { calls, parsed: true };
  } catch { /* not one doc — try bare objects below */ }
  for (const frag of findJsonFragments(payload)) {
    try {
      const v = validateCallObject(JSON.parse(frag), names);
      if (v) calls.push(v);
    } catch { /* fragment is not a call */ }
  }
  return { calls, parsed: false };
}

/**
 * Parse misformatted tool calls from the assistant's content.
 *
 * The content may carry several tags (local Qwen2.5-Coder can emit multiple
 * <tools> blocks in one completion) and a tag may hold one object, an array,
 * or several bare objects. Every VALID candidate is returned in document
 * order; invalid candidates (unparseable JSON, unregistered tool name) are
 * skipped — nothing invalid is ever executed, and skipped raw text stays in
 * `cleaned`.
 *
 * @param {string} content raw assistant completion content
 * @param {string[]} allowedNames registered tool names (exact match required)
 * @returns {{ok:boolean, reason?:string, variant?:string, calls?:Array<{name:string,args:object}>, cleaned?:string}}
 *   ok=true ⇒ calls are ready for the normal execution path; `cleaned` is the
 *   content with the tags/fences of the executed calls removed (safe to
 *   store/display). ok=false ⇒ nothing valid found; treat as plain text.
 */
function parseFallbackToolCall(content, allowedNames) {
  const names = new Set(Array.isArray(allowedNames) ? allowedNames : []);
  const candidates = findCandidates(content).sort((a, b) => a.index - b.index);
  if (!candidates.length) return { ok: false, reason: 'no-tag' };

  const calls = [];
  const matched = []; // [start, end) ranges of candidates that produced calls
  let variant = null;
  let parsedAny = false;
  for (const c of candidates) {
    const found = parsePayloadObjects(String(c.payload || '').trim(), names);
    parsedAny = parsedAny || found.parsed;
    if (found.calls.length) {
      if (!variant) variant = c.variant;
      calls.push(...found.calls);
      matched.push([c.index, c.index + c.raw.length]);
    }
  }
  if (!calls.length) {
    return {
      ok: false,
      reason: parsedAny ? 'invalid-call' : 'invalid-json',
      variant: variant || candidates[0].variant,
      cleaned: String(content || ''),
    };
  }
  // Remove the raw tag/fence text of the executed calls (descending order
  // keeps the remaining indices valid); skipped candidates stay untouched.
  let cleaned = String(content || '');
  for (const [s, e] of matched.slice().reverse()) {
    cleaned = cleaned.slice(0, s) + cleaned.slice(e);
  }
  return { ok: true, variant, calls, cleaned: cleaned.trim() };
}

// ---------------------------------------------------------------------------
// Guard retry heuristics (step 3)
// ---------------------------------------------------------------------------

/** curl/wget command present in the reply (the model describing instead of
 *  acting), or a fenced shell block. */
function hasShellCommandText(content) {
  const t = String(content || '');
  if (/\bcurl\s/i.test(t) || /\bwget\s/i.test(t)) return true;
  for (const m of t.matchAll(/```([^\n`]*)\n([\s\S]*?)```/g)) {
    const lang = (m[1] || '').trim().toLowerCase();
    const body = m[2] || '';
    if (/^(bash|sh|shell|zsh|console|cmd|powershell)$/.test(lang)) return true;
    if (/\b(curl|wget|sudo|apt|npm|pip|df|ls|ps|systemctl|ping|git|python3?|echo|chmod|cat)\b/.test(body)) return true;
  }
  return false;
}

/** The user's request needs live data or an action (retry-worthy). */
const LIVE_DATA_RE =
  /\b(current|latest|live|now|today|price|rate|weather|status|check|find|look up|search|get|fetch|show|list|query|how (much|many)|is (it|there)\b|are (they|there)|uptime|load|usage|running|balance|market|quote|news|temperature|date|time|curl|wget|run|execute|call)\b/i;

function needsLiveData(userText) {
  return LIVE_DATA_RE.test(String(userText || ''));
}

/**
 * Guard-retry decision (step 3): the reply has no tool call (even after the
 * fallback parser), but contains a shell block / curl / wget, AND the user's
 * request needs live data or an action ⇒ retry ONCE with a stable
 * instruction (+ tool_choice:"required" when the route's config allows).
 * `guardRetried` is set by the route so this can never fire twice for the
 * same user message — the no-loop rule lives in this predicate too.
 */
function shouldGuardRetry({ content, userText, guardRetried }) {
  if (guardRetried) return false;
  if (!hasShellCommandText(content)) return false;
  if (!needsLiveData(userText)) return false;
  return true;
}

module.exports = {
  parseFallbackToolCall,
  findCandidates,
  findJsonFragments,
  shouldGuardRetry,
  hasShellCommandText,
  needsLiveData,
  GUARD_RETRY_MSG,
  LIVE_DATA_RE,
  TAG_PATTERNS,
};