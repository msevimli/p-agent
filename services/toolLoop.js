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
const path = require('path');
const jsonRepair = require('./jsonRepair');
const agentPaths = require('./agentPaths');

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
// calls return a corrective error the model can act on, and the corrected
// retry executes normally.

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
 * File-argument normalization — applied BEFORE schema validation.
 *
 * Small models routinely emit file paths under alias keys ('file',
 * 'filepath', 'filename', 'src', 'target') or as a bare unkeyed string
 * instead of the schema's 'path' key, and the rejected call then gets
 * repeated unchanged. Normalizing here makes the call EXECUTE; repeated
 * reads after an edit then hit the real path and return fresh state.
 */
const FILE_PATH_TOOLS = new Set(['read_file', 'write_file', 'edit_file', 'delete_file', 'list_files']);
const FILE_PATH_ALIASES = ['file', 'filepath', 'file_path', 'filename', 'src', 'target'];
// Exact JSON shape expected for each tool — appended to rejection errors so
// the model corrects its payload instead of re-emitting (file tools + run_shell).
const ARG_FORMATS = {
  read_file: '{"path": "relative/file/path.ext"}',
  write_file: '{"path": "relative/file/path.ext", "content": "file text"}',
  edit_file: '{"path": "relative/file/path.ext", "old_text": "exact existing text", "new_text": "replacement text"}',
  delete_file: '{"path": "relative/file/path.ext"}',
  list_files: '{"path": "relative/directory"}',
  run_shell: '{"command": "your_shell_command_here"}',
};
/**
 * Normalize run_shell arguments the same way file tools are normalized:
 * small models (Gemma 4B etc.) emit the command under alias keys (cmd, exec,
 * script, c, shell_command) or as a bare unkeyed string instead of the
 * schema's 'command' key, and the rejected call then gets repeated unchanged.
 * Normalizing here makes the call EXECUTE with the canonical command.
 */
const SHELL_COMMAND_ALIASES = ['cmd', 'exec', 'script', 'c', 'shell_command'];
function normalizeShellToolArgs(name, args) {
  if (name !== 'run_shell') return args;
  // Bare unkeyed string as the whole args value: run_shell "free -h".
  if (typeof args === 'string' && args.trim() !== '') return { command: args.trim() };
  // Alias keys: first present alias with a real string value becomes command.
  if (args && typeof args === 'object' && !Array.isArray(args) && !Object.prototype.hasOwnProperty.call(args, 'command')) {
    for (const alias of SHELL_COMMAND_ALIASES) {
      if (Object.prototype.hasOwnProperty.call(args, alias) && typeof args[alias] === 'string' && args[alias].trim() !== '') {
        const out = { ...args };
        out.command = args[alias].trim();
        delete out[alias];
        return out;
      }
    }
  }
  return args;
}

function normalizeFileToolArgs(name, args) {
  if (!FILE_PATH_TOOLS.has(name)) return args;
  // Agent workspace zoning (idempotent): bare relative paths default to the
  // agent workspace (workspaces/ inside the project root); paths starting
  // with "../" are explicitly project-root-relative; absolute paths stay
  // rejected (zonePath returns undefined -> the strict escape rejection).
  // PLACEHOLDER-shaped paths ('?', '<path>', 'your_..._here') are zoned
  // LAST (after validation) — the placeholder gate must see the RAW value:
  // zoning '?' -> 'workspaces/?' would make the gate miss it.
  const zone = (p) => {
    if (PLACEHOLDER_RE.test(String(p))) return p;
    const z = agentPaths.zonePath(p);
    return z === undefined ? p : z;
  };
  // Bare unkeyed string as the whole args value: read_file "scripts/x.py".
  if (typeof args === 'string' && args.trim() !== '') return { path: zone(args.trim()) };
  // Alias keys: first present alias with a real string value becomes path.
  if (args && typeof args === 'object' && !Array.isArray(args) && !Object.prototype.hasOwnProperty.call(args, 'path')) {
    for (const alias of FILE_PATH_ALIASES) {
      if (Object.prototype.hasOwnProperty.call(args, alias) && typeof args[alias] === 'string' && args[alias].trim() !== '') {
        const out = { ...args };
        out.path = zone(args[alias].trim());
        delete out[alias];
        return out;
      }
    }
  }
  if (args && typeof args === 'object' && !Array.isArray(args) && typeof args.path === 'string' && args.path !== '') {
    const zoned = zone(args.path);
    if (zoned !== args.path) return { ...args, path: zoned };
  }
  return args;
}

/**
 * Execute one tool by name. Always resolves (never rejects) to a result.
 *
 * 1. Schema validation first: required params must be present, non-empty and
 *    free of placeholder tokens; invalid calls are rejected with a corrective
 *    message (invalidArgs:true) and NEVER run — so write_file can't create a
 *    junk file named '?' or write an empty file, and the corrected retry
 *    executes normally.
 * 2. There is NO duplicate suppression: every call executes as emitted, no
 *    matter how often the same (name, args) was already run in this request.
 *    A re-run of a read/grep after an edit returns FRESH state (the reported
 *    workflow — verification must never be blocked). There is NO round
 *    ceiling and no repetition detection: the loop ends only when the
 *    model answers in plain text (or the repeated-invalid-call freeze in
 *    routes/chat.js trips on 3× identical broken emissions); the static
 *    anti-spam guardrails (chmod-on-.py, missing-logs hint) live in the
 *    tools themselves.
 */
async function executeTool(name, args) {
  const tool = getTool(name);
  if (!tool) return { ok: false, error: `unknown tool: ${name}` };
  let norm = normalizeShellToolArgs(name, normalizeFileToolArgs(name, args));
  // Agent-workspace default for listings: list_files with NO path lists the
  // agent workspace (explicit "../" lists the project root). The File
  // Explorer routes bypass executeTool, so the root listing there is
  // unaffected.
  if (name === 'list_files' && (!norm || norm.path === undefined || norm.path === '')) {
    norm = { ...(norm || {}), path: 'workspaces' };
  }
  const v = validateArgs(name, norm);
  if (!v.ok) {
    const fmt = ARG_FORMATS[name];
    return {
      ok: false,
      invalidArgs: true,
      error: `invalid arguments for ${name}: ${v.error}${fmt ? ` Expected format: ${fmt}` : ''}`,
    };
  }
  const nargs = v.args;
  try {
    const result = await Promise.resolve(tool.execute(nargs));
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

/**
 * Parse a tool-call `arguments` string (may be empty/partial). Never throws.
 * Falls back to the auto-repair cascade for LLM-mangled JSON (unescaped
 * quotes/newlines in inline commands, single quotes, unquoted keys…);
 * every repaired candidate is parse-verified in services/jsonRepair.js.
 */
function safeParseArgs(str) {
  if (!str) return {};
  if (typeof str !== 'string') return str || {};
  const p = jsonRepair.parseJsonRepaired(str);
  if (p.ok) {
    if (p.repaired) {
      console.log(`[tool-call] repaired malformed JSON args (${(p.steps || []).join(',')}) — ${String(str).slice(0, 90).replace(/\n/g, '\n')}`);
    }
    const j = p.value;
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  }
  return {};
}

/**
 * Normalize a parsed call object. Accepts the plife JSON contract ({tool,
 * args}), the OpenAI/Qwen2.5 shapes ({name, arguments} and its echoed
 * variants {"function": <name>, "arguments": {...}} / {"function":
 * {"name": …, "arguments": …}}), with the args keys interchangeable
 * (args | arguments). A missing args key inside an explicit tool tag/fence
 * (or for the {tool,…} contract) defaults to {}; `outsideTags` (bare JSON in
 * prose / whole-output) additionally requires an explicit arguments/args key
 * for name-shaped objects, so stray JSON that merely mentions a registered
 * tool name never fires. The registered tool name must match exactly in
 * every case. Returns { tool, args } or null.
 */
function normalizeCallObject(o, outsideTags) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  // OpenAI-native wrapper echo: {"function": {"name": …, "arguments": …}}.
  const fnObj =
    o.function && typeof o.function === 'object' && !Array.isArray(o.function)
      ? o.function
      : null;
  const name =
    (typeof o.tool === 'string' && o.tool) ||
    (typeof o.function === 'string' && o.function) ||
    (fnObj && typeof fnObj.name === 'string' && fnObj.name) ||
    (typeof o.name === 'string' && o.name) ||
    '';
  if (!name || !hasTool(name)) return null;
  const hasToolKey = typeof o.tool === 'string';
  const hasArgsKey =
    o.args !== undefined ||
    o.arguments !== undefined ||
    !!(fnObj && fnObj.arguments !== undefined);
  if (outsideTags && !hasToolKey && !hasArgsKey) return null; // mere name mention
  const raw =
    fnObj && fnObj.arguments !== undefined
      ? fnObj.arguments
      : o.args !== undefined
        ? o.args
        : o.arguments !== undefined
          ? o.arguments
          : {};
  if (typeof raw === 'string') {
    // arguments may arrive double-encoded as a JSON string
    const p = jsonRepair.parseJsonRepaired(raw);
    if (p.ok && p.value && typeof p.value === 'object' && !Array.isArray(p.value)) {
      return { tool: name, args: p.value };
    }
    return null;
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { tool: name, args: raw };
  return null;
}

/**
 * Detect a tool call inside model text: a fenced ```json block, an explicit
 * XML-style tool tag (<tools>, <tool>, <tool_call>, <tool_calls>,
 * <function_call>, <function-calls> — Qwen2.5-Coder wraps calls in
 * <tools>…</tools>), a bare JSON object ({"tool":<name>,"args":{}} or
 * {"name":<name>,"arguments":{}}), or an embedded JSON object anywhere in
 * the text. Requires a valid, guarded object (well-formed JSON with a
 * registered tool name), so plain prose is never mistaken for a call.
 * Malformed-but-repairable JSON (unescaped quotes/newlines, single quotes,
 * unquoted keys…) is auto-repaired and still executed.
 * Returns { tool, args } or null.
 */
function tryParseTool(t, outsideTags) {
  const p = jsonRepair.parseJsonRepaired(t);
  if (p.ok) {
    if (p.repaired) {
      console.log(`[tool-call] repaired malformed tool-call JSON (${(p.steps || []).join(',')}) — ${String(t).slice(0, 90).replace(/\n/g, '\n')}`);
    }
    const c = normalizeCallObject(p.value, outsideTags);
    if (c) return c;
  }
  return null;
}

// XML-style tool tags (Qwen2.5-Coder's <tools>…</tools> wrapper plus the
// legacy <tool_call>/<function-calls> family). Each capture group holds one
// tag's inner payload.
const TOOL_TAG_RE =
  /<tools>([\s\S]*?)<\/tools>|<tool>([\s\S]*?)<\/tool>|<tool_call>([\s\S]*?)<\/tool_call>|<tool_calls>([\s\S]*?)<\/tool_calls>|<function_call>([\s\S]*?)<\/function_call>|<function-calls>([\s\S]*?)<\/function-calls>/gi;

/**
 * Parse the payload of one tool tag/fence into call objects: a single JSON
 * object, an ARRAY of objects, or several bare objects separated by
 * whitespace/newlines. Every candidate is validated against the registry;
 * invalid ones are skipped (never executed). Never throws.
 */
function parseCallPayloads(payload) {
  const out = [];
  const t = String(payload || '').trim();
  if (!t) return out;
  // Whole payload first: object or array of objects (repair-friendly).
  const p = jsonRepair.parseJsonRepaired(t);
  if (p.ok) {
    const whole = p.value;
    const arr = Array.isArray(whole) ? whole : [whole];
    let any = false;
    for (const o of arr) {
      const c = normalizeCallObject(o, false);
      if (c) { out.push(c); any = true; }
    }
    if (any) return out; // at least one valid call — the payload was one doc
  }
  // Multiple bare JSON objects inside one tag (whitespace/newline separated).
  for (const frag of findJsonObjects(t)) {
    const fp = jsonRepair.parseJsonRepaired(frag);
    if (fp.ok) {
      const c = normalizeCallObject(fp.value, false);
      if (c) out.push(c);
    }
  }
  return out;
}

/**
 * Every tool call embedded in model text, in document order ([] when none).
 * Priority mirrors the legacy single-call extractor: fenced JSON blocks,
 * then XML-style tool tags, then a bare JSON object, then whole-output JSON.
 */
function extractToolCalls(text) {
  const out = [];
  const s = String(text || '');
  const t = s.trim();
  if (!t) return out;

  // 1) fenced ```json (or bare ```) block anywhere in the output
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const m of t.matchAll(fenceRe)) {
    for (const c of parseCallPayloads(m[1])) out.push(c);
  }
  if (out.length) return out;

  // 2) explicit XML-style tool tags (Qwen2.5-Coder <tools>…</tools>, …)
  for (const m of t.matchAll(TOOL_TAG_RE)) {
    const payload = m.slice(1).find((g) => g !== undefined);
    for (const c of parseCallPayloads(payload)) out.push(c);
  }
  if (out.length) return out;

  // 3) bare JSON object anywhere (covers "`{\"tool\":...}` + trailing prose"
  //    and Qwen's {"name":…,"arguments":…} object without the wrapper)
  const bare = findBareToolObject(t);
  if (bare) return [bare];

  // 4) whole-output pure JSON
  if (t.startsWith('{')) {
    const hit = tryParseTool(t, true);
    if (hit) return [hit];
  }
  return out;
}

/** First tool call embedded in model text ({ tool, args } or null). */
function extractToolCall(text) {
  return extractToolCalls(text)[0] || null;
}

function findBareToolObject(text) {
  // Object-start candidates: any of the key markers that can open a call
  // object — "tool" for the plife contract, "name"+"arguments"/"args" for
  // the OpenAI/Qwen shape, and "function" for the OpenAI-echo shape
  // (name-shaped objects require an args key, so a prose mention of a tool
  // name alone never fires).
  const keys = ['"tool"', '"function"', '"name"', '"arguments"', '"args"'];
  const hits = [];
  for (const key of keys) {
    let i = text.indexOf(key);
    while (i !== -1) { hits.push({ i, key }); i = text.indexOf(key, i + 1); }
  }
  hits.sort((a, b) => a.i - b.i);
  let lastEnd = -1;
  for (const { i, key } of hits) {
    if (i <= lastEnd) continue; // already inside a scanned candidate
    const start = text.lastIndexOf('{', i);
    if (start === -1) continue;
    let depth = 0;
    for (let k = start; k < text.length; k++) {
      const ch = text[k];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          lastEnd = k;
          const hit = tryParseTool(text.slice(start, k + 1), key !== '"tool"');
          if (hit) return hit;
          break;
        }
      }
    }
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
  'create_automation, list_automations, run_automation, delete_automation, ' +
  'set_automation_enabled and set_automations_paused. ' +
  'When the user asks to create an automation or schedule something recurring, ' +
  'use them yourself — never suggest OS cron jobs. ' +
  'To stop or pause: set_automation_enabled (id, enabled:false) disables one rule; ' +
  'set_automations_paused (paused:true) stops the whole scheduler — neither deletes ' +
  'rules and manual run_automation still works. ' +
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
    'To call a tool, output a JSON object of the form {"tool": "<tool_name>", "args": {...}}.\n' +
    'EMIT SEVERAL INDEPENDENT CALLS IN ONE REPLY: when a task has multiple steps that do not ' +
    'depend on each other (e.g. writing two files, creating a script and scheduling an ' +
    'automation), output one JSON object per call in the same reply (several ```json blocks) — ' +
    'they are all executed together, which saves round trips. Only wait for a result when a ' +
    'later call depends on an earlier one (running a file you just wrote, reading a file before ' +
    'replying, checking output before continuing). Complete, real values only — no placeholders ' +
    'Calls with missing or placeholder arguments are rejected. ' +
        'You MAY re-run a read, list or grep to verify after an edit — re-reading is cheap and ' +
        'returns fresh state. What you must not do is redo finished side-effectful work: do not ' +
        'create an automation or append to a log twice because you forgot it already ran — check ' +
        'the results you have and proceed.\n' +
    'PLAN multi-step work BEFORE calling tools: decide the exact file names, skill names and ' +
    'arguments once, then emit the independent calls together. NEVER churn: do not re-create, ' +
    're-write or delete-and-recreate what a tool result already created — if a call reports ' +
    '"already exists" or a name collision, use the existing item or pick a NEW name and move on. ' +
    'Never delete something you created earlier in the same task, and do not repeat similar ' +
    'calls with only trivial changes. Paths are ' +
    'workspace-relative: write scripts into the workspace (e.g. scripts/...), never absolute ' +
    'system paths like /workspace or /tmp.\n' +
    'WORKSPACE ACCESS: you ALWAYS have direct, live access to the workspace and every file in ' +
    'it — list_files, read_file, write_file, edit_file, delete_file and run_shell operate ' +
    'there. NEVER claim you cannot see or check the workspace, and NEVER tell the user to ' +
    'inspect files or run commands manually in a terminal — use your tools and answer from ' +
    'their real output. Automation scripts run with the PROJECT ROOT as their working directory, ' +
    'so relative log paths land in the root logs/ directory — inspect them as ../logs/.... ' +
    'When a user asks ' +
    'where a file or log is, or whether it exists, locate it with list_files/read_file and ' +
    'report the actual result.\n' +
    'FILE TOOL PAYLOADS — exact argument shapes, copy these: read_file: {"tool":"read_file","args":{"path":"scripts/get_solana_price.py"}}; ' +
    'write_file: {"tool":"write_file","args":{"path":"scripts/new.py","content":"print(1)"}}; ' +
    'edit_file: {"tool":"edit_file","args":{"path":"scripts/x.py","old_text":"exact existing text","new_text":"replacement text"}}; ' +
    'delete_file: {"tool":"delete_file","args":{"path":"scripts/old.py"}}; ' +
    'list_files: {"tool":"list_files","args":{"path":"scripts"}}. ' +
    'The path key is ALWAYS required — never use another key (file, filename, src), never a bare ' +
    'string, never a placeholder; pass the path exactly as it appears in list_files output. ' +
    'run_shell: {"tool":"run_shell","args":{"command":"free -h"}} — the command key is ALWAYS ' +
    'required: never use cmd/exec/script/shell_command, never a bare string, never a placeholder ' +
    '("your_shell_command_here" is a placeholder example, not a value you should send); one ' +
    'command at a time, single line, no pipes-to-nowhere.\n' +
    'WORKSPACE ZONES — your default working directory is the AGENT WORKSPACE, the "workspaces/" ' +
    'folder inside the project root. BARE relative paths (e.g. "scripts/foo.py") target the ' +
    'workspace — generated scripts, reports and dynamic files belong there. Paths starting with ' +
    '"../" are explicitly PROJECT-ROOT-relative (e.g. "../routes/fs.js") and may read/write ' +
    'anywhere in the project root; never use absolute paths (rejected). list_files with no path ' +
    'lists the workspace; use list_files ../ for the project root. run_shell starts in the ' +
    'workspace ("cd .." reaches the project root).\n' +
    'SCRIPT & AUTOMATION TASKS — strict order, each step EXACTLY ONCE: (1) write the script ' +
    'file once; (2) create the automation pointing to that script once; (3) list the ' +
    'automations once to confirm; (4) STOP and give the final answer. NEVER read output log ' +
    'files in the same task — logs are only written when the automation runs on its schedule ' +
    'LATER, so a missing log right after creation is NORMAL, not an error. NEVER run chmod on ' +
    '.py files (the python runner does not need the executable bit). NEVER rewrite a script ' +
    'you just wrote, and NEVER re-create an automation that already exists. If a call failed, ' +
    'fix it and retry; if something already exists, use it or pick a new name — never re-create. \n' +
    'SHELL URL QUOTING — MANDATORY: any URL containing a query string (? or &) passed to curl ' +
    'or wget MUST be enclosed in DOUBLE QUOTES: `curl -s "https://api.example.com/v1/price?ids=solana&vs_currencies=usd"`. ' +
    'An unquoted & is a shell background/separator operator, so the request breaks or truncates. ' +
    'For JSON APIs, embedding a small python3 one-liner is often more reliable: ' +
    '`python3 -c "import urllib.request,json; d=json.load(urllib.request.urlopen(\'https://api.example.com/v1/price?ids=solana&vs_currencies=usd\')); print(d)"`. ' +
    'If a fetch failed, retry the corrected quoted command.\n' +
    'INLINE vs SCRIPT FILES: keep run_shell commands SHORT and single-line. For anything multi-line ' +
    'or containing quotes (node -e, python3 -c, awk, heredocs, nested "quotes in quotes"), write a ' +
    'script file FIRST (write_file to scripts/, e.g. scripts/tmp_check.js) and then run it with ' +
    '`node scripts/tmp_check.js` or `bash scripts/tmp_check.sh`. Inline one-liners with nested ' +
        'quotes are fragile — their JSON escapes get corrupted mid-task — while a script file has no ' +
        'quote-nesting problem at all. Do not re-write the same script; reuse what is already there.\n' +
        'JSON-ARGUMENT QUOTE RULE: whenever code or file text is embedded in a tool-call JSON string ' +
        '(write_file content, write_skill files, run_shell commands), every internal double quote MUST ' +
        'be escaped as \\" — e.g. the code line data["solana"]["usd"] must be sent as data[\\"solana\\"][\\"usd\\"], ' +
        'and f"{x}" as f\\"{x}\\". Write code with single quotes inside (Python: data[\'solana\']; JS: \'solana\') ' +
        'where possible — single quotes need no escaping. NEVER emit backtick-fenced, raw multi-line code ' +
        'inside a JSON string value. For multiple script files, prefer sequential write_file calls (one ' +
        'file each) over nesting many unescaped code blocks in a deep files map — a single malformed quote ' +
        'rejects the whole call.\n' +
    'If a call fails, fix it and retry once, then keep going. After the tool results, work until ' +
    'the task is done, then reply with a short plain-text final answer.\n' +
    'You execute shell commands yourself with the run_shell tool and have internet access through curl. ' +
    'When the user needs live data or system information, call the tool and answer from its output — ' +
    'never ask the user to run commands.\n' +
    'Automations: creating, scheduling, enabling/disabling and pausing/resuming automations is done ' +
        'with the automation tools — never suggest OS crontab entries. To stop one rule use ' +
        'set_automation_enabled (enabled:false); to stop ALL rules at once use set_automations_paused ' +
        '(paused:true); both keep the rules and allow manual run_automation. Re-enable with ' +
        'enabled:true / paused:false.\n' +
    'Library: attached files are usually inlined in your input; use the library tools to list, ' +
        'read or save documents.\n' +
        'MEMORY: you have TWO persistent memory layers. (1) WORKSPACE memory: requests carry a ' +
        '<workspace_memory> block (when MEMORY.md exists) with project facts/conventions — read it ' +
        'and follow it; maintain it with update_workspace_memory (append, never rewrite history unless ' +
        'asked; keep entries short). (2) GLOBAL memory: requests carry a <global_user_memory> block ' +
        'with the user\'s semantically-retrieved long-term facts — treat them as instructions; add ' +
        'durable user preferences/coding-style facts with manage_global_memory when they surface ' +
        'during a task, delete only what the user explicitly wants forgotten, and never claim you ' +
        '"remember" something that is not in these blocks — absent blocks mean empty memory.\n' +
    'Skills: skills are plain user-managed folders in the workspace skills/ directory — they are ' +
    'NOT built-in tools or core functionality. List them with list_skills, create or update them ' +
    'with write_skill, run them with run_skill, and permanently DELETE any user skill with ' +
    'delete_skill when the user asks. A delete request never needs an exemption — just call the ' +
    'tool; only report failure when the tool returns an error (invalid name or skill not found).\n'
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
const CORE_TOOL_NAMES = ['delete_file', 'edit_file', 'list_files', 'read_file', 'run_shell', 'write_file'];

const TOPIC_TOOLS = [
  {
    topic: 'skills',
    re: /skill/i,
    tools: ['delete_skill', 'list_skills', 'run_skill', 'write_skill'],
  },
  {
    topic: 'automations',
    re: /automation|schedul|recurr|remind|cron|every\s+\d+\s*(min|hour|day|week)|daily|hourly|weekly|monthly|periodic/i,
    tools: ['create_automation', 'delete_automation', 'list_automations', 'run_automation', 'set_automation_enabled', 'set_automations_paused'],
  },
  {
    topic: 'library',
    re: /library|attach|upload|stored file/i,
    tools: ['list_library_files', 'read_library_file', 'upload_library_file'],
  },
  {
    topic: 'memory',
    re: /memor|rememb|forget|recall/i,
    tools: ['manage_global_memory', 'update_workspace_memory'],
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

// ---------------------------------------------------------------------------
// Parallel-safe grouping for one round's tool calls
//
// chat.js executes a round's calls group-by-group: calls INSIDE a group may
// run concurrently, groups run in emission order. The conflict rules below
// guarantee that concurrency can never corrupt state:
//   - exec tools (run_shell, run_skill, run_automation) run arbitrary code →
//     they serialize with EVERYTHING (including each other);
//   - file tools conflict only on path overlap (same file, or a listing of a
//     directory that contains the other call's target) — different paths are
//     safe to parallelize;
//   - automation/skills/library tools share a JSON state store → they
//     serialize within their class;
//   - unknown tools are conservative: serialize with everything.
// An exact-duplicate call pair can never land in the same group (identical
// args ⇒ same target ⇒ conflict ⇒ split across groups ⇒ sequential order).
// ---------------------------------------------------------------------------
function callClass(name) {
  if (name === 'run_shell' || name === 'run_skill' || name === 'run_automation') return 'exec';
  if (['read_file', 'write_file', 'edit_file', 'delete_file', 'list_files'].includes(name)) return 'file';
  if (name.includes('automation')) return 'store-auto';
  if (name.includes('skill')) return 'store-skill';
  if (name.includes('library')) return 'store-library';
  return 'other';
}
function normPath(p) {
  return path
    .resolve(String(p == null ? '.' : p))
    .replace(/[\/\\]+$/, '');
}
function pathsOverlap(a, b) {
  if (a === b) return true;
  return a.startsWith(b + '/') || b.startsWith(a + '/');
}
function callsConflict(a, b) {
  const ca = callClass(a && a.name);
  const cb = callClass(b && b.name);
  if (ca === 'exec' || cb === 'exec' || ca === 'other' || cb === 'other') return true;
  if (ca === 'file' && cb === 'file') {
    return pathsOverlap(normPath(a.args && a.args.path), normPath(b.args && b.args.path));
  }
  // same shared-state store class (or different classes entirely: file vs
  // store classes touch disjoint storage → no conflict)
  return ca === cb;
}
function groupIndependent(calls) {
  const groups = [];
  outer: for (const c of calls) {
    for (const g of groups) {
      if (!g.some((x) => callsConflict(x, c))) {
        g.push(c);
        continue outer;
      }
    }
    groups.push([c]);
  }
  return groups;
}

module.exports = {
  listTools,
  getTool,
  executeTool,
  registry,
  validateArgs,
  toOpenAITools,
  hasTool,
  safeParseArgs,
  extractToolCall,
  extractToolCalls,
  normalizeCallObject,
  buildSystemPrompt,
  selectTools,
  coreToolNames,
  AUTOMATIONS_GUIDANCE,
  AUTOMATION_INTENT_RE,
  isAutomationCreationRequest,
  findAutomationPayload,
  inferAutomationFromUser,
  groupIndependent,
  callClass,
  pathsOverlap,
  normalizeFileToolArgs,
};