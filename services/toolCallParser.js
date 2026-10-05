/**
 * services/toolCallParser.js — tolerant fallback for MISFORMATTED tool calls
 * + the no-tool guard retry.
 *
 * Background: on some llama.cpp builds the model answers "what is the
 * current Solana price? use curl" by printing the call wrapped in a tag
 * (<function-calls>…</function-calls>) that the server does NOT parse into
 * message.tool_calls. These helpers detect that shape in the ASSISTANT's own
 * content and convert it into the same native tool-call the loop executes —
 * with strict rules so injected text can never trigger a call.
 *
 * SAFETY CONTRACT:
 *  - Only the assistant's own completion content is ever parsed. Tool
 *    results, user messages and retrieved text are NEVER parsed (they can
 *    contain injected tags) — the route guarantees this by only calling
 *    parseFallbackToolCall(acc.content, …).
 *  - The tool name must EXACTLY match a registered tool.
 *  - The arguments must be valid JSON (object, or string that parses to an
 *    object); the call then goes through the exact same execution path as a
 *    native call (toolLoop.executeTool → validateArgs), so schema checks,
 *    placeholder rejection, dedup and side-effect guards all apply.
 *  - Ambiguity/invalidity ⇒ no execution, message stays plain text.
 *  - The matched tag/fence text is removed from the stored/visible message.
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

// Accepted tag variants — inner text must be a JSON object (or array of
// objects) with "name" and "arguments".
const TAG_PATTERNS = [
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

/** One call object: { name, arguments }. Null when invalid. */
function validateCallObject(o, allowedNames) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const { name, arguments: argsRaw } = o;
  if (typeof name !== 'string' || !allowedNames.has(name)) return null; // exact registered name
  let args = argsRaw;
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

/**
 * Parse a misformatted tool call from the assistant's content.
 *
 * @param {string} content raw assistant completion content
 * @param {string[]} allowedNames registered tool names (exact match required)
 * @returns {{ok:boolean, reason?:string, variant?:string, calls?:Array<{name:string,args:object}>, cleaned?:string}}
 *   ok=true ⇒ calls are ready for the normal execution path; `cleaned` is the
 *   content with the matched tag/fence removed (safe to store/display).
 *   ok=false ⇒ treat the message as plain text, execute nothing.
 */
function parseFallbackToolCall(content, allowedNames) {
  const names = new Set(Array.isArray(allowedNames) ? allowedNames : []);
  const candidates = findCandidates(content);
  if (!candidates.length) return { ok: false, reason: 'no-tag' };
  // Strictness: more than one tag/fence ⇒ ambiguous ⇒ execute nothing.
  if (candidates.length > 1) return { ok: false, reason: 'ambiguous', cleaned: String(content || '') };

  const c = candidates[0];
  let json = null;
  try {
    json = JSON.parse(c.payload.trim());
  } catch {
    return { ok: false, reason: 'invalid-json', variant: c.variant, cleaned: String(content || '') };
  }

  const cleaned = (String(content || '').slice(0, c.index) + String(content || '').slice(c.index + c.raw.length)).trim();

  if (Array.isArray(json)) {
    if (!json.length) return { ok: false, reason: 'empty-array', variant: c.variant, cleaned };
    const calls = json.map((o) => validateCallObject(o, names));
    if (calls.some((x) => !x)) return { ok: false, reason: 'invalid-call', variant: c.variant, cleaned };
    return { ok: true, variant: c.variant, calls, cleaned };
  }

  const call = validateCallObject(json, names);
  if (!call) return { ok: false, reason: 'invalid-call', variant: c.variant, cleaned };
  return { ok: true, variant: c.variant, calls: [call], cleaned };
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
  shouldGuardRetry,
  hasShellCommandText,
  needsLiveData,
  GUARD_RETRY_MSG,
  LIVE_DATA_RE,
  TAG_PATTERNS,
};