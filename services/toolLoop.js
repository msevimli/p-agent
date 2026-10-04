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

const DEDUP_EXEMPT = new Set(['run_automation', 'run_skill', 'run_shell']);
// Per-chat-request execution ledger: { name, argsKey } of every executed call.
const seenCalls = [];

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
    return await Promise.resolve(tool.execute(nargs));
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
 * Guidance injected into every chat system prompt (tool and non-tool paths):
 * automations live in the plife dashboard, not in the OS crontab.
 */
const AUTOMATIONS_GUIDANCE =
  'Built-in automations: this server has an Automations engine with dedicated ' +
  'tools: create_automation, list_automations, run_automation, delete_automation. ' +
  'When the user asks to create an automation, schedule a task, or run something ' +
  'periodically, CALL create_automation yourself with the schedule and action the ' +
  'user wants — you execute the creation; do not just explain how. Include ALL ' +
  'required fields: name, schedule_type, interval_minutes or cron, action_type, ' +
  'and the matching script/skill/prompt value. After creating, ' +
  'call list_automations to confirm. If the automation already exists, do NOT ' +
  'create it again — confirm the existing one instead. Fallback: if the dedicated tools are missing, ' +
  'use run_shell with curl POST http://127.0.0.1:8888/api/automations (same JSON ' +
  'body as create_automation). NEVER suggest system-level Unix cron jobs or ' +
  'external OS crontabs — use the built-in Automations engine.\n';

/**
 * Build the system prompt that teaches the model how/when to emit a tool call.
 * Appended to the base system prompt. Kept schema-driven so adding a tool
 * later needs no edits here.
 */
function buildSystemPrompt(base) {
  const schema = registry.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
  return (
    `${base}\n\n` +
    'You have access to tools that let you inspect and modify files and run shell ' +
    'commands when helpful.\n' +
    'To list directory contents or see what files exist in the project, call list_files ' +
    '(never read_file on a directory). To read a specific file, use read_file.\n' +
    AUTOMATIONS_GUIDANCE +
    'When you decide a tool is needed, respond with EXACTLY one JSON object on its ' +
    'own (no code fences, no other text), in this shape:\n' +
    '{"tool": "<tool_name>", "args": { ...arg names and values for that tool }}\n' +
    'The JSON object must be the FIRST thing you output — no introductory sentences ' +
    'before it, no explanations around it. If you output any text before the JSON ' +
    'object, the call is not executed. You may explain only AFTER the tool results ' +
    'come back.\n' +
    'Every required argument MUST be a complete, real value — a full string literal ' +
    'or a real number. Never leave arguments empty, and never use placeholders like ' +
    '?, ..., <path>, N/A, TODO or your_file_name. Calls with missing or placeholder ' +
    'arguments are rejected without executing; if a call is rejected, re-issue it ' +
    'with the complete values.\n' +
    'After the tool result comes back, continue working until the task is done, ' +
    'then reply with a normal final answer (plain text). If a tool call fails, try ' +
    'to recover and finish anyway. Do not repeat a tool call that already succeeded ' +
    'with the same arguments — the result is already in your history; move on.\n' +
    'Tool-first policy: when a tool fits the request, you MUST call it — never ' +
    'answer with instructions, steps, links, or raw JSON examples for the user to ' +
    'run manually. Explanatory text is allowed only AFTER the tools have done the ' +
    'work. If you intend to call a tool, the JSON object MUST appear in your output.\n' +
    'Tools:\n' +
    JSON.stringify(schema, null, 2)
  );
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
  validateArgs,
  toOpenAITools,
  hasTool,
  safeParseArgs,
  extractToolCall,
  buildSystemPrompt,
  AUTOMATIONS_GUIDANCE,
  AUTOMATION_INTENT_RE,
  isAutomationCreationRequest,
  findAutomationPayload,
  inferAutomationFromUser,
};