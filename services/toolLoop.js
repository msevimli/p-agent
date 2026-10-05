/**
 * Tool-loop orchestration service.
 *
 * This is the primitive the agentic loop (tool-calling) will use: it resolves
 * a tool from the registry by name and executes it with a plain, serializable
 * result object — so tool outcome messages can be fed back into the LLM
 * conversation when function-calling is wired up.
 *
 * Nothing here talks to the model; the loop itself will live alongside this
 * and call llamaClient. Kept out of the HTTP layer on purpose.
 */
const registry = require('../tools');

function listTools() {
  return registry.map(({ name, description, parameters }) => ({
    name,
    description,
    parameters,
  }));
}

function getTool(name) {
  return registry.find((t) => t.name === name) || null;
}

// ---------------------------------------------------------------------------
// Tool-call deduplication
// ---------------------------------------------------------------------------
//
// Small models (and chunked-continuation loops) frequently re-issue the same
// call — e.g. write_file to the same path with identical content — after the
// result was already fed back, because the tool result is compressed to a
// short summary in history. Re-running such calls is wasteful at best and
// harmful at worst (duplicate automations, append-amplified log files,
// clobbered state). We therefore track every executed call per session and
// refuse exact repeats: the FIRST execution wins, a duplicate is reported as
// a no-op result the model can understand and move on from.
//
// Non-idempotent tools are exempt so legitimate repeated triggers still work:
// run_automation, run_skill and run_shell may be intentionally repeated
// (running a script twice on purpose must not be blocked). Every other tool
// (file reads/writes/edits, listings, automations CRUD, skills writes) is
// deduplicated by (name, canonical JSON args).
//
// run_shell additionally carries a CONSECUTIVE-duplicate guard: a shell
// command that just succeeded is not executed again back-to-back with the
// same (quotes/whitespace-normalized) command — small models often re-emit
// the same curl/script in the next loop round, and each re-run is redundant
// (result already in history) and may have side effects. A repeat after
// other steps in between still executes, so intentional double runs remain
// possible; a repeat of a FAILED command also still executes (recovery).

const DEDUP_EXEMPT = new Set(['run_automation', 'run_skill', 'run_shell']);
// Per-chat-request execution ledger: { name, argsKey } of every executed call.
const seenCalls = [];

// Normalized key of the last successfully executed shell command (null when
// none yet / after the ledger reset). Reset with resetSeenCalls().
let lastShellCommandKey = null;

/**
 * Normalize a shell command into a comparison key: tokenize on whitespace
 * (respecting quotes), canonicalize quote characters, and strip quotes from
 * fully-quoted single tokens — so `curl -s 'URL'`, `curl -s "URL"` and
 * `curl -s URL` compare equal, while `echo "a b"` and `echo a b` stay
 * distinct (quoted whitespace is semantically meaningful).
 */
function normalizeShellCommandKey(cmd) {
  if (typeof cmd !== 'string') return '';
  const s = cmd.trim();
  if (!s) return '';
  const tokens = [];
  let cur = '';
  let q = null;
  const flush = () => { if (cur !== '') { tokens.push(cur); cur = ''; } };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { cur += ch; if (ch === q) q = null; }
    else if (ch === '"' || ch === "'") { q = ch; cur += ch; }
    else if (/\s/.test(ch)) flush();
    else cur += ch;
  }
  flush();
  return tokens
    .map((t) => {
      const tok = t.replace(/"/g, "'"); // canonical quote char
      const inner = tok.slice(1, -1);
      if (tok.length >= 2 && tok[0] === "'" && tok[tok.length - 1] === "'" && !inner.includes("'") && !/\s/.test(inner)) {
        return inner; // fully-quoted single token: quotes are cosmetic here
      }
      return tok;
    })
    .join(' ');
}

/** Stable key for an args object: sorted keys, stable-JSON, trimmed. */
function canonicalArgsKey(args) {
  if (args === null || args === undefined) return '';
  if (typeof args !== 'object') return String(args);
  const walk = (v) => {
    if (Array.isArray(v)) return `[${v.map(walk).join(',')}]`;
    if (v && typeof v === 'object') {
      return `{${Object.keys(v)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${walk(v[k])}`)
        .join(',')}}`;
    }
    if (typeof v === 'string') return JSON.stringify(v.trim());
    return JSON.stringify(v);
  };
  return walk(args);
}

/** True if this exact (name, args) pair was already executed this session. */
function wasCallExecuted(name, args) {
  const key = canonicalArgsKey(args);
  return seenCalls.some((c) => c.name === name && c.argsKey === key);
}

/** Forget all recorded calls (start of a new chat request). */
function resetSeenCalls() {
  seenCalls.length = 0;
  lastShellCommandKey = null;
}

/** Remember an executed (name, args) pair. */
function recordCall(name, args) {
  seenCalls.push({ name, argsKey: canonicalArgsKey(args) });
}

// ---------------------------------------------------------------------------
// Strict pre-execution argument validation
// ---------------------------------------------------------------------------
//
// Small models frequently emit tool calls whose arguments are missing,
// corrupted, or stuffed with placeholders ('?', '...', '<path>', 'N/A',
// 'your_file_name') instead of real values. Executing such calls is harmful:
// write_file would create a junk file named '?' or overwrite a real file with
// an empty string; create_automation would fail validation mid-loop. So every
// call is schema-checked BEFORE execution: required parameters must be
// present, type-coerced, non-empty and free of placeholder tokens; rejected
// calls return a corrective error the model can act on (and never poison the
// dedup ledger, so the corrected retry runs normally).

// Placeholder tokens small models substitute for real values they cannot
// decide: '?', '...', '<path>', 'N/A', 'TODO', 'your_file_name', 'null' as a
// string, etc.
const PLACEHOLDER_RE =
  /^\s*(?:<[^>]*>|\?+|\.{3,}|…|n\/?a|tbd|todo|xxx+|null|undefined|placeholder|none|your\s*\w*[\s_]*\w*n?a?m?e?)\s*$/i;

/**
 * Coerce a raw argument value to its schema type. Returns
 * { ok, v } with the normalized value, or { ok:false, why }.
 * Numeric strings ('5') become numbers; booleans accept 'true'/'false';
 * arrays (write_file content) are joined into the string the tool would
 * produce, so emptiness checks see the real content.
 */
function coerceArg(value, types) {
  const ts = Array.isArray(types) ? types : [types];
  if (ts.includes('number')) {
    if (typeof value === 'number' && Number.isFinite(value)) return { ok: true, v: value };
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      return { ok: true, v: Number(value) };
    }
    return { ok: false, why: `expected a number, got ${JSON.stringify(value)}` };
  }
  if (ts.includes('boolean')) {
    if (typeof value === 'boolean') return { ok: true, v: value };
    if (value === 'true') return { ok: true, v: true };
    if (value === 'false') return { ok: true, v: false };
    return { ok: false, why: `expected a boolean, got ${JSON.stringify(value)}` };
  }
  if (ts.includes('array') && !ts.includes('string')) {
    if (Array.isArray(value)) return { ok: true, v: value };
    return { ok: false, why: `expected an array, got ${JSON.stringify(value).slice(0, 40)}` };
  }
  if (ts.includes('object')) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return { ok: true, v: value };
    return { ok: false, why: `expected an object, got ${JSON.stringify(value).slice(0, 40)}` };
  }
  // string, or composite ['string','array'] (write_file content): any scalar
  // or array normalizes to the string the tool would write.
  if (Array.isArray(value)) {
    return { ok: true, v: value.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n') };
  }
  if (typeof value === 'string') return { ok: true, v: value };
  return { ok: true, v: JSON.stringify(value) };
}

/**
 * Validate + normalize args against the tool's declared schema. Never throws.
 * Returns { ok:true, args } (normalized: coerced types, joined arrays) or
 * { ok:false, error } with a corrective message naming the offending argument.
 */
function validateArgs(name, args) {
  const tool = getTool(name);
  if (!tool) return { ok: false, error: `unknown tool: ${name}` };
  const schema = tool.parameters && typeof tool.parameters === 'object' ? tool.parameters : null;
  const props = schema && schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const required = schema && Array.isArray(schema.required) ? schema.required : [];
  const raw = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const out = {};
  const errors = [];

  for (const key of required) {
    const has = Object.prototype.hasOwnProperty.call(raw, key);
    if (!has) {
      errors.push(`missing required argument '${key}'`);
      continue;
    }
    const value = raw[key];
    if (value === null || value === undefined) {
      errors.push(`invalid value null for required argument '${key}': provide a real value`);
      continue;
    }
    if (typeof value === 'string' && PLACEHOLDER_RE.test(value)) {
      errors.push(`invalid value '${value.slice(0, 30)}' for required argument '${key}': placeholder values are not allowed`);
      continue;
    }
    const types = (props[key] && props[key].type) || 'string';
    const coerced = coerceArg(value, types);
    if (!coerced.ok) {
      errors.push(`invalid argument '${key}': ${coerced.why}`);
      continue;
    }
    // Post-coercion emptiness — a required string must actually carry content.
    if (typeof coerced.v === 'string' && coerced.v.trim() === '') {
      errors.push(`invalid argument '${key}': must be a non-empty value`);
      continue;
    }
    if (Array.isArray(coerced.v) && coerced.v.length === 0) {
      errors.push(`invalid argument '${key}': must not be an empty array`);
      continue;
    }
    out[key] = coerced.v;
  }

  // Optional and unknown params: pass through (coerced when the value parses
  // cleanly, raw otherwise — the tool itself still guards its behavior).
  // Placeholder TOKENS are rejected everywhere, not just in required fields:
  // a cron of '???' or a script of '<script>' must never reach the engine.
  for (const [key, value] of Object.entries(raw)) {
    if (Object.prototype.hasOwnProperty.call(out, key)) continue;
    if (typeof value === 'string' && PLACEHOLDER_RE.test(value)) {
      errors.push(`invalid placeholder value '${value.slice(0, 30)}' for argument '${key}': not allowed`);
      continue;
    }
    if (props[key] && props[key].type && value !== null && value !== undefined) {
      const coerced = coerceArg(value, props[key].type);
      out[key] = coerced.ok ? coerced.v : value;
    } else {
      out[key] = value;
    }
  }

  if (errors.length) {
    return {
      ok: false,
      error:
        errors.join('; ') +
        ' — provide valid JSON arguments with complete, non-placeholder values and retry the call',
    };
  }
  return { ok: true, args: out };
}

/**
 * Execute one tool by name. Always resolves (never rejects) to a result.
 *
 * 1. Schema validation first: required params must be present, non-empty and
 *    free of placeholder tokens; invalid calls are rejected with a corrective
 *    message (invalidArgs:true) and NEVER run — so write_file can't create a
 *    junk file named '?' or write an empty file. Rejected calls are also not
 *    recorded, so the corrected retry executes normally.
 * 2. Deduplication guard: an exact repeat of a previously executed call (same
 *    tool, same canonical args) is short-circuited and reported as an already-
 *    done no-op instead of executing again — unless the tool is in
 *    DEDUP_EXEMPT (intentionally repeatable: run_automation, run_skill,
 *    run_shell). The guard applies per chat request (resetSeenCalls).
 */
async function executeTool(name, args) {
  const tool = getTool(name);
  if (!tool) return { ok: false, error: `unknown tool: ${name}` };
  const v = validateArgs(name, args);
  if (!v.ok) {
    return { ok: false, invalidArgs: true, error: `invalid arguments for ${name}: ${v.error}` };
  }
  const nargs = v.args;
  // Consecutive-duplicate guard for shell commands: if the SAME command
  // (quotes/whitespace-normalized) just executed successfully, a back-to-back
  // repeat is a redundant model re-emission — skip it with a corrective note
  // instead of re-running side-effectful shell. Repeats after other steps,
  // and repeats of FAILED commands (recovery), still execute.
  if (name === 'run_shell' && typeof nargs.command === 'string') {
    const key = normalizeShellCommandKey(nargs.command);
    if (key && key === lastShellCommandKey) {
      return {
        ok: false,
        error:
          `duplicate shell command skipped: "${nargs.command.slice(0, 90)}" was just executed with the same command — ` +
          'do NOT run it again; interpret the existing result and continue towards the final answer',
        skippedDuplicate: true,
      };
    }
  }
  if (!DEDUP_EXEMPT.has(name)) {
    if (wasCallExecuted(name, nargs)) {
      return {
        ok: false,
        error:
          `duplicate tool call skipped: ${name} was already executed with these exact arguments in this request — ` +
          'do NOT call it again; interpret the original result and continue towards the final answer',
        skippedDuplicate: true,
      };
    }
    recordCall(name, nargs);
  }
  try {
    const result = await Promise.resolve(tool.execute(nargs));
    if (name === 'run_shell' && result && result.ok) {
      lastShellCommandKey = normalizeShellCommandKey(nargs.command);
    }
    return result;
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Tool-calling support
// ---------------------------------------------------------------------------

/** OpenAI-compatible `tools` array for /v1/chat/completions (native calls). */
function toOpenAITools() {
  return registry.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/** True if `name` is a registered tool. */
function hasTool(name) {
  return registry.some((t) => t.name === name);
}

/** Parse a tool-call `arguments` string (may be empty/partial). Never throws. */
function safeParseArgs(str) {
  if (!str) return {};
  if (typeof str !== 'string') return str || {};
  try {
    const j = JSON.parse(str);
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

/**
 * Detect a tool call inside model text: a fenced ```json block, a
 * <tool_call>…</tool_call> block, a bare JSON object {"tool":<name>,"args":{}},
 * or an embedded JSON object anywhere in the text. Requires a valid, guarded
 * object (well-formed JSON with a registered tool name), so plain prose is
 * never mistaken for a call. Returns { tool, args } or null.
 */
function tryParseTool(t) {
  try {
    const o = JSON.parse(t);
    if (o && typeof o.tool === 'string' && hasTool(o.tool)) {
      return { tool: o.tool, args: safeParseArgs(o.args) };
    }
  } catch { /* not JSON */ }
  return null;
}

function findBareToolObject(text) {
  const idx = text.indexOf('"tool"');
  if (idx === -1) return null;
  const start = text.lastIndexOf('{', idx);
  if (start === -1) return null;
  let depth = 0;
  for (let k = start; k < text.length; k++) {
    const ch = text[k];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return tryParseTool(text.slice(start, k + 1));
    }
  }
  return null;
}

function extractToolCall(text) {
  if (!text) return null;
  let t = text.trim();
  if (!t) return null;

  // 1) fenced ```json (or bare ```) block anywhere in the output
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const m of t.matchAll(fenceRe)) {
    const hit = tryParseTool(m[1].trim());
    if (hit) return hit;
  }

  // 2) <tool_call>…</tool_call> block
  const block = t.match(/<tool_call>([\s\S]*?)<\/tool_call>/);
  if (block) {
    const hit = tryParseTool(block[1].trim());
    if (hit) return hit;
  }

  // 3) bare JSON object anywhere (covers "`{\"tool\":...}` + trailing prose")
  const bare = findBareToolObject(t);
  if (bare) return bare;

  // 4) whole-output pure JSON
  if (t.startsWith('{')) {
    const hit = tryParseTool(t);
    if (hit) return hit;
  }
  return null;
}

/**
 * Guidance injected into non-tool chat paths (TOOL_CALLING=false): automations
 * live in the plife dashboard, not in the OS crontab. Kept compact — it is an
 * edge path; the tool-enabled system prompt carries the short rule inline.
 */
const AUTOMATIONS_GUIDANCE =
  'Automations: this server has a built-in Automations engine with tools ' +
  'create_automation, list_automations, run_automation, delete_automation. ' +
  'When the user asks to create an automation or schedule something recurring, ' +
  'use them yourself — never suggest OS cron jobs. ' +
  'Include all required fields: name, schedule_type (interval|cron), ' +
  'interval_minutes or cron, action_type (script|skill|prompt), and the matching ' +
  'script/skill/prompt value. Confirm with list_automations after creating. ' +
  'Fallback without tools: run_shell with curl -X POST http://127.0.0.1:8888/api/automations ' +
  '(same JSON body as create_automation).\n';

/**
 * Build the system prompt that teaches the model how/when to emit a tool call.
 * Appended to the base system prompt.
 *
 * PROMPT-CACHE CONTRACT: this text is part of the stable prompt prefix and is
 * therefore 100% static — no dates, no request ids, no session ids, no
 * per-request content. Dynamic content (retrieved memory, session info, the
 * current date) must NEVER be injected here; it belongs after the prefix
 * (near/inside the current user message). The tool descriptions are NOT
 * embedded here any more (they live in the payload `tools` array, which the
 * OpenAI-compatible server renders into the context) — that alone removed
 * ~3,400 tokens of duplicated schema from the prefix.
 */
function buildSystemPrompt(base) {
  return (
    `${base}\n\n` +
    'You are the plife dashboard agent. Use the provided tools to inspect and modify files, ' +
    'run shell commands, and manage automations, skills and the file Library.\n' +
    'To call a tool, output exactly ONE JSON object as the very first thing, nothing before it:\n' +
    '{"tool": "<tool_name>", "args": {...}}\n' +
    'Complete, real values only — no placeholders (?, ..., <path>, N/A, TODO). Calls with ' +
    'missing or placeholder arguments are rejected. Never repeat a tool call that already succeeded.\n' +
    'If a call fails, fix it and retry once, then keep going. After the tool results, work until ' +
    'the task is done, then reply with a short plain-text final answer.\n' +
    'You execute shell commands yourself with the run_shell tool and have internet access through curl. ' +
    'When the user needs live data or system information, call the tool and answer from its output — ' +
    'never ask the user to run commands.\n' +
    'Automations: creating/scheduling/running/removing automations is done with the automation ' +
    'tools — never suggest OS crontab entries.\n' +
    'Library: attached files are usually inlined in your input; use the library tools to list, ' +
    'read or save documents.\n'
  );
}

// ---------------------------------------------------------------------------
// Lazy tool selection  (EXPERIMENTAL — off by default, LAZY_TOOLS=true)
// ---------------------------------------------------------------------------
//
// The production default (routes/chat.js) sends ALL tools on every request:
// the full 16-tool array is only ~1,900 tokens, it is cached after warm-up,
// and — crucially — it never changes mid-conversation, so the llama.cpp KV
// cache stays valid for the whole conversation. Lazy selection was tried
// first (round 1 of the prompt-cache work) and its flaw is structural: a
// topic tool group added mid-conversation sits in the middle of the prefix
// and forces llama-server to re-process the ENTIRE conversation, which costs
// minutes on this CPU. Kept behind the flag for experiments.
//
// If enabled: sends a small CORE set plus the tools relevant to the
// conversation. The chosen set is a UNION over ALL user messages, so:
//  - it can only grow, never shrink → once a topic appears, its tools stay
//    (stable within a conversation, cache stays valid),
//  - a brand-new topic mid-conversation grows the set exactly once (one
//    one-time cache invalidation, then stable again),
//  - the result is sorted by name → deterministic serialization.
const CORE_TOOL_NAMES = ['edit_file', 'list_files', 'read_file', 'run_shell', 'write_file'];

const TOPIC_TOOLS = [
  {
    topic: 'skills',
    re: /skill/i,
    tools: ['delete_skill', 'list_skills', 'run_skill', 'write_skill'],
  },
  {
    topic: 'automations',
    re: /automation|schedul|recurr|remind|cron|every\s+\d+\s*(min|hour|day|week)|daily|hourly|weekly|monthly|periodic/i,
    tools: ['create_automation', 'delete_automation', 'list_automations', 'run_automation'],
  },
  {
    topic: 'library',
    re: /library|attach|upload|stored file/i,
    tools: ['list_library_files', 'read_library_file', 'upload_library_file'],
  },
];

/**
 * Deterministically select the OpenAI `tools` array for a request.
 * `messages` is the full conversation (all rounds of the tool loop included).
 * opts.force: tool names that must be present (e.g. automation enforcement).
 * opts.attachments: true when the request carries library attachments →
 * library tools are needed (attachment truncation notes point at
 * read_library_file).
 */
function selectTools(messages, opts = {}) {
  const { force = [], attachments = false } = opts;
  const set = new Set(CORE_TOOL_NAMES);
  const text = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && m.role === 'user' && typeof m.content === 'string')
    .map((m) => m.content)
    .join('\n');
  for (const topic of TOPIC_TOOLS) {
    if (topic.re.test(text)) for (const t of topic.tools) set.add(t);
  }
  // Explicit tool-name mention in any user message (e.g. "use run_skill X").
  for (const t of registry) {
    if (text.includes(t.name)) set.add(t.name);
  }
  for (const name of force) if (hasTool(name)) set.add(name);
  if (attachments) {
    for (const t of TOPIC_TOOLS.find((x) => x.topic === 'library').tools) set.add(t);
  }
  return [...set].sort().map((name) => {
    const t = getTool(name);
    return {
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    };
  });
}

/** Tool names in the default (core) set — used by warm-up. */
function coreToolNames() {
  return [...CORE_TOOL_NAMES];
}

// =====================================================================
// Automation-tool enforcement — for models that explain instead of calling
// create_automation. Used by the chat loop to intercept such answers.
// =====================================================================

// Imperative creation intent (NOT "how do I ..."): the current user request
// must command an automation/scheduling creation for interception to engage.
// The interrogative lookahead blocks questions ("how/what/why", self-asking
// "can i", "do i") while still allowing "can you create ...".
const AUTOMATION_INTENT_RE =
  /^\s*(?![^.!?\n]{0,60}\b(?:how|what|why|can\s+i|could\s+i|do\s+i|should\s+i|is\s+it|does\s+it)\b)[\s\S]{0,200}?\b(?:create|make|set up|setup|add|schedule|register|build|run)\b[^.!?\n]{0,90}\b(?:automation|recurring|every\s*\d+|daily|hourly|weekly|monthly|cron|periodic)\b/i;

function isAutomationCreationRequest(text) {
  return !!text && AUTOMATION_INTENT_RE.test(String(text).slice(0, 400));
}

/** Extract balanced {...} JSON candidates from text (fenced or bare prose). */
function findJsonObjects(text) {
  const out = [];
  const s = String(text || '').slice(0, 8000);
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue;
    let depth = 0, inStr = false, esc = false, end = -1;
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
      else if (ch === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end > i && end - i <= 2000) out.push(s.slice(i, end + 1));
  }
  return out;
}

/**
 * Normalize an automation BODY ({"name", "schedule":{...}, "action":{...}},
 * or flattened {name, cron|intervalMinutes, actionType|script|skill|prompt})
 * into create_automation args. Null unless name + schedule + action are all
 * present and complete — so narration with a full curl body gets executed,
 * while unrelated JSON (examples of other tools) never fires.
 */
function normalizeAutomationBody(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const sched = o.schedule && typeof o.schedule === 'object' && !Array.isArray(o.schedule) ? o.schedule : o;
  const act = o.action && typeof o.action === 'object' && !Array.isArray(o.action) ? o.action : o;
  const scheduleType =
    sched.type === 'cron' ? 'cron'
      : sched.type === 'interval' ? 'interval'
        : typeof sched.cron === 'string' ? 'cron'
          : Number.isFinite(Number(sched.intervalMinutes)) ? 'interval'
            : null;
  const actionType = ['script', 'skill', 'prompt'].includes(act.type)
    ? act.type
    : ['script', 'skill', 'prompt'].includes(act.actionType) ? act.actionType : null;
  if (typeof o.name !== 'string' || !o.name.trim() || !scheduleType || !actionType) return null;

  const args = { name: o.name.trim(), schedule_type: scheduleType, action_type: actionType };
  if (typeof o.description === 'string' && o.description.trim()) args.description = o.description.trim();
  if (scheduleType === 'cron') {
    if (typeof sched.cron !== 'string' || !sched.cron.trim()) return null;
    args.cron = sched.cron.trim();
  } else {
    if (!Number.isFinite(Number(sched.intervalMinutes))) return null;
    args.interval_minutes = Math.max(1, Math.floor(Number(sched.intervalMinutes)));
  }
  if (actionType === 'script') {
    if (typeof act.script !== 'string' || !act.script.trim()) return null;
    args.script = act.script.trim();
  } else if (actionType === 'skill') {
    if (typeof act.skill !== 'string' || !act.skill.trim()) return null;
    args.skill = act.skill.trim();
  } else {
    if (typeof act.prompt !== 'string' || !act.prompt.trim()) return null;
    args.prompt = act.prompt.trim();
  }
  if (Array.isArray(act.args)) args.args = act.args.map(String).filter(Boolean).slice(0, 20);
  return args;
}

/** Find a complete automation-body payload anywhere in the model's text. */
function findAutomationPayload(text) {
  for (const frag of findJsonObjects(String(text || ''))) {
    try {
      const args = normalizeAutomationBody(JSON.parse(frag));
      if (args) return args;
    } catch { /* not JSON */ }
  }
  return null;
}

/**
 * Infer create_automation args from the USER's wording alone — grounded only:
 * schedule and action must be explicitly stated, nothing is invented. Returns
 * null when either cannot be determined.
 */
function inferAutomationFromUser(text) {
  const t = String(text || '').slice(0, 1000);
  let scheduleType = null, cron = null, intervalMinutes = null;

  // Explicit clock time first ("at 9am", "at 21:30") — more specific than a
  // bare "daily"/"hourly" word, so it wins the schedule decision.
  const at = t.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (at) {
    let h = parseInt(at[1], 10);
    const mnt = at[2] !== undefined ? parseInt(at[2], 10) : 0;
    const mer = at[3] ? at[3].toLowerCase() : null;
    if (mer === 'pm' && h < 12) h += 12;
    if (mer === 'am' && h === 12) h = 0;
    if (h >= 0 && h <= 23 && mnt >= 0 && mnt <= 59 && (mer || at[2] !== undefined || at[1].length >= 2)) {
      cron = `${mnt} ${h} * * *`;
      scheduleType = 'cron';
    }
  }

  const every = t.match(/every\s+(\d+)\s*(minute|minutes|min|mins|hour|hours|hr|hrs|day|days)\b/i);
  if (!scheduleType && every) {
    const n = Math.max(1, parseInt(every[1], 10));
    const unit = every[2].toLowerCase();
    intervalMinutes = unit.startsWith('day') ? n * 1440
      : (unit.startsWith('hour') || unit.startsWith('hr')) ? n * 60 : n;
    scheduleType = 'interval';
  } else if (!scheduleType && /\bhourly\b/i.test(t)) { intervalMinutes = 60; scheduleType = 'interval'; }
  else if (!scheduleType && /\bdaily\b/i.test(t)) { intervalMinutes = 1440; scheduleType = 'interval'; }
  else if (!scheduleType && /\bweekly\b/i.test(t)) { intervalMinutes = 10080; scheduleType = 'interval'; }
  else if (!scheduleType && /\bmonthly\b/i.test(t)) { intervalMinutes = 43200; scheduleType = 'interval'; }

  const script = t.match(/\b([A-Za-z0-9_][A-Za-z0-9._/-]*\.js)\b/);
  const skill = t.match(/(?:skill\s+([A-Za-z0-9][A-Za-z0-9_-]*)|([A-Za-z0-9][A-Za-z0-9_-]*)\s+skill)\b/i);
  let actionType = null, scriptPath = null, skillName = null;
  if (script) { actionType = 'script'; scriptPath = script[1]; }
  else if (skill) { actionType = 'skill'; skillName = skill[1] || skill[2]; }
  else if (/\b(?:ask|query|run)\s+(?:the\s+)?(?:llm|model|ai)\b|\bprompt\b/i.test(t)) actionType = 'prompt';

  if (!scheduleType || !actionType) return null; // never invent schedule or action

  const args = { name: 'scheduled task', schedule_type: scheduleType, action_type: actionType };
  if (scheduleType === 'interval') args.interval_minutes = intervalMinutes;
  else args.cron = cron;
  if (scriptPath) {
    args.script = scriptPath;
    args.name = `scheduled ${scriptPath.split('/').pop().replace(/\.js$/, '')} run`;
  }
  if (skillName) args.skill = skillName;
  return args;
}

module.exports = {
  listTools,
  getTool,
  executeTool,
  registry,
  resetSeenCalls,
  canonicalArgsKey,
  normalizeShellCommandKey,
  validateArgs,
  toOpenAITools,
  hasTool,
  safeParseArgs,
  extractToolCall,
  buildSystemPrompt,
  selectTools,
  coreToolNames,
  AUTOMATIONS_GUIDANCE,
  AUTOMATION_INTENT_RE,
  isAutomationCreationRequest,
  findAutomationPayload,
  inferAutomationFromUser,
};