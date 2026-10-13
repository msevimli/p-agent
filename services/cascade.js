/**
 * cascade — two-stage model cascade orchestration (fast router -> heavy primary).
 *
 * Roles (configured in data/models-state.json on each local model entry):
 *   role: "router"   — fast model doing stage 1: intent classification and
 *                      tool-call emission (also answers simple chat directly).
 *   role: "primary"  — heavy model doing stage 2: final generation after tool
 *                      results, plus all escalated heavy reasoning/coding.
 *
 * Chat flow (routes/chat.js) when a cascade is enabled:
 *   stage 'route'   -> completion against the ROUTER endpoint (router system
 *                      prompt + full tools array). The router either
 *                       - emits tool call(s)          -> tools execute, stage 2
 *                       - replies with the ROUTE_MARKER-> stage 2 (heavy work)
 *                       - answers directly            -> final answer (fast path)
 *   stage 'primary' -> completion against the PRIMARY endpoint with the
 *                      accumulated context (tool results included); the
 *                      primary may itself emit more tool calls (multi-hop).
 *   Fallback: any router failure (unreachable, empty stream, error) escalates
 *   the round to the primary — the turn never dies on the fast model.
 *
 * The router system prompt is the PRIMARY system prompt + a byte-stable
 * ROUTER_ADDENDUM (PROMPT-CACHE CONTRACT: no dates/ids/dynamic content), so
 * router warm-up (modelLifecycle) prefills the exact same prefix real requests
 * send, and the primary's own prefix cache is untouched by the cascade.
 */
const config = require('../config');
const modelManager = require('./modelManager');
const toolLoop = require('./toolLoop');

// Router replies with EXACTLY this string to defer a request to the heavy
// model. Kept short and caps-free so a small model can emit it reliably.
const ROUTE_MARKER = 'ROUTE_TO_PRIMARY';

/**
 * Static router instructions appended to the primary system prompt.
 * Byte-stable by contract — never interpolate request-specific content here.
 * (ROUTE_MARKER is a constant, so templating it is still byte-stable.)
 */
const ROUTER_ADDENDUM =
  'You are the fast routing stage of a two-model cascade: a small, quick model that ' +
  'decides where each request goes. You do exactly one of THREE things, in priority order:\n' +
  '1. If the user concretely asks for an ACTION on files or the system (read a file, write/edit ' +
  'a file, list a directory, run a shell command) — emit that tool call now, exactly like a ' +
  'normal agent would. Do not answer from memory.\n' +
  'Never use a tool to explain, research, compare or investigate a topic — that is reasoning, ' +
  'and comes under rule 2.\n' +
  `2. EVERYTHING else that needs reasoning, coding, refactoring, debugging, multi-step ` +
  `analysis, a long answer, automations, skills, or Library access — reply with EXACTLY the ` +
  `single line ${ROUTE_MARKER} and nothing else. It is plain text, NOT a tool call: never wrap ` +
  `it in JSON, tool-call syntax, quotes, or code fences.\n` +
  '3. Otherwise, if it is a simple conversational exchange — answer it directly with a ' +
  'short plain-text reply.\n' +
  'Never write real code or long solutions yourself: that is the primary model\'s job. ' +
  'Never invent tool results. When in doubt between 2 and 3, choose 2.\n' +
  'Skills, automations and Library items are user-managed, NOT built-in: creating, editing, ' +
  'running or DELETING one is always a primary-model job — never answer such requests yourself ' +
  'and never claim they are unmodifiable or part of core functionality. Reply ' +
  `${ROUTE_MARKER} instead.\n` +
  'FILES vs SKILLS: a workspace name with a file extension (.txt, .py, .js, .json, .md, .sh) or ' +
  'any path (./, workspace-relative or absolute) is a FILE — never a skill. Deleting, removing, ' +
  'editing or creating files is rule-1 core work (run_shell, write_file and the other file ' +
  'tools). Skills live only inside the skills/ directory and are managed exclusively by the ' +
  'primary model — a word without a file extension is NOT automatically a skill. When unsure ' +
  'whether something is a skill or a file, treat it as a file action (rule 1).\n' +
  'You NEVER confirm actions: after you emit a tool call, the primary model takes over and you ' +
  'never see the result — so any reply like "done", "deleted", "removed", "success" or ' +
  '"successfully" is a fabrication. Never write one. If a request is not a clear rule-1 call, ' +
  `reply ${ROUTE_MARKER} only.`;

/**
 * Router stage tool set: ONLY the five core file/shell tools. Automation,
 * Library, skills and everything rarer are deliberately NOT offered to the
 * router — a request needing them escalates to the primary model, which
 * carries the full tool registry. (A small model given every tool will
 * misfire on harmless questions; a small set keeps stage-1 fast and safe.)
 * Byte-stable ordering (sorted names) — PROMPT-CACHE CONTRACT.
 */
function routerTools() {
  const names = toolLoop.coreToolNames();
  return toolLoop
    .listTools()
    .filter((t) => names.includes(t.name))
    .map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
}

/** Router system prompt: the full agent prompt + the routing addendum. */
function routerSystemPrompt(base) {
  return toolLoop.buildSystemPrompt(base) + '\n\n' + ROUTER_ADDENDUM;
}

/** Local loopback check — the cascade only coordinates local llama.cpp servers. */
function isLoopback(url) {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])([:/]|$)/i.test(String(url || ''));
}

/** Resolve { baseUrl, model, apiKey } for one registry model. */
function targetFor(m) {
  if (!m) return null;
  return {
    baseUrl: String(m.endpoint || '').replace(/\/+$/, ''),
    model: m.model || m.modelId || '',
    apiKey: modelManager.resolveApiKey(m.id) || '',
  };
}

/**
 * Pure role resolution from a registry state snapshot (unit-testable without
 * touching the registry file or network):
 *   enabled  — a 'router' AND a 'primary' exist, they are distinct entries,
 *              the router endpoint is a local loopback, the global switch is
 *              on, AND the user's selected (active) model IS the configured
 *              primary. Selecting any other model — or switching the global
 *              flag off — bypasses the router stage entirely (single-model
 *              mode straight to the selected model).
 *   primary  — the ACTIVE (UI-selected) model always wins as the stage-2
 *              target; the 'primary'-role model is only the fallback when
 *              nothing is selected. If the selected model itself is the
 *              router-role entry, the whole cascade is off and it serves
 *              single-model.
 *   escalate — inherited cascade escalation mode ('marker'|'always'|'never').
 */
function resolveFrom(state, opts = {}) {
  const models = Array.isArray(state && state.models) ? state.models : [];
  const activeId = (state && state.activeId) || null;
  const active = models.find((m) => m && m.id === activeId) || null;
  const router = models.find((m) => m && m.role === 'router') || null;
  const explicitPrimary = models.find((m) => m && m.role === 'primary') || null;
  // The UI dropdown selection ALWAYS wins as the stage-2 (primary) target —
  // a selection overrides role defaults. Role-based fallback applies only
  // when no model is selected.
  const primary = active || explicitPrimary || models[0] || null;
  const flag = opts.enabled !== undefined ? !!opts.enabled : config.twoStageCascade !== false;
  // The two-stage cascade runs only while the selected model IS the
  // configured primary: selecting any other model (Gemma, a remote, or the
  // router-role model itself) means the user wants that single model, with
  // NO router stage — the fix for "UI selection never overrides the router".
  const activeIsConfiguredPrimary = !active
    ? true
    : !!(explicitPrimary && active.id === explicitPrimary.id);
  const enabled = !!(
    flag &&
    router &&
    primary &&
    activeIsConfiguredPrimary &&
    router.id !== primary.id &&
    isLoopback(router.endpoint)
  );
  return {
    enabled,
    activeId,
    router,
    primary,
    escalate: String(opts.escalate || config.cascadeEscalate || 'marker').toLowerCase(),
  };
}

/**
 * Resolve the live cascade from the current registry state (per-request call:
 * models-state.json is re-read on every read, so role edits apply instantly).
 * Returns the resolved config plus ready-to-use completion targets and the
 * router system prompt. targets/routerSystem are null when disabled.
 */
function resolve() {
  const r = resolveFrom(modelManager.getState());
  if (!r.enabled) return { ...r, targets: null, routerSystem: null };
  return {
    ...r,
    targets: { router: targetFor(r.router), primary: targetFor(r.primary) },
    routerSystem: routerSystemPrompt(config.llamaSystemPrompt),
  };
}

/**
 * True when a router completion carries escalation intent. Strict exact
 * marker first (trimmed, optional fences/quotes/trailing punctuation), then
 * a tolerant phrase match on 'route to primary' so the small model's natural
 * variants qualify too — a fenced JSON {"name":"route_to_primary"}, or a
 * plain "please route to primary" — while ordinary prose answers ("...route
 * this to the primary model...") do not.
 */
function markerMatch(content) {
  const t = String(content || '')
    .trim()
    .replace(/^```[a-zA-Z]*\s*/, '')
    .replace(/```$/, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[.!;]+$/, '')
    .trim();
  if (!t) return false;
  if (t.toUpperCase() === ROUTE_MARKER) return true;
  // Tolerant pass: lowercase, collapse non-alphanumerics to spaces, then
  // look for the routing phrase. The marker must be the ONLY routing signal —
  // a phrase like "route this to the primary model" (extra words between)
  // stays a plain answer.
  const norm = String(t).toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  return norm.includes('route to primary');
}

/**
 * Router-stage safety net: true when a no-call router reply still LOOKS like
 * a tool attempt (fenced/code block, XML tool tags, or a bare JSON object
 * opening with a tool-ish key, with tool-ish JSON keys) — e.g. a
 * hallucinated {"tool":"documentation",...} or bare {"tool":"run_skill",...}
 * that the parser correctly refused because the name is not in the (core-5)
 * registry. Such a reply is never served as the final answer; chat.js
 * escalates it to the primary model instead (graceful degradation).
 */
const TOOL_ATTEMPT_RE =
  /```|<(tool|tools|tool_call|tool_calls|function_call|function-calls)[\s>]|\{\s*["']?(tool|name|function)["']?\s*:/i;
const TOOL_KEYS_RE = /["']?(tool|name|args|arguments)["']?\s*:/i;
function looksLikeToolAttempt(content) {
  const t = String(content || '');
  return TOOL_ATTEMPT_RE.test(t) && TOOL_KEYS_RE.test(t);
}

// ---------------------------------------------------------------------------
// Fabricated-confirmation guard (router stage)
//
// The router never sees tool results: after it emits a core-5 call, the
// primary takes over. So ANY no-call router reply that asserts an action
// succeeded — "Skill removed successfully", "done", "deleted", etc. — is a
// hallucination, even when the user's message used action words (a common
// 3B pattern: "remove greeting.txt" → "Skill removed successfully", which
// then blocks the real file operation entirely).
//
// Escalate such replies to the primary instead of serving them as the final
// answer: the primary has the full registry and re-does the actual work.
// Requires BOTH an action-ish user request AND a confirmation-shaped reply,
// so conversational exchanges ("ok, done" to "hi") never escalate.
// ---------------------------------------------------------------------------
const USER_ACTION_RE = /\b(?:delete|remove|erase|rm|unlink|move|rename|create|write|edit|modify|clear|clean|set up|fix)\b/i;
const CONFIRMATION_RE = /\b(?:removed|deleted|erased|completed|cleaned? up|handled|taken care of|done|success)\w*\b/i;
function looksLikeFabricatedConfirmation(content, userText) {
  if (!USER_ACTION_RE.test(String(userText || ''))) return false;
  if (!CONFIRMATION_RE.test(String(content || ''))) return false;
  // A genuinely short conversational acknowledgment ("ok done") after an
  // action request is still safer escalated than trusted.
  return true;
}

/**
 * Stage decision for a router completion that produced NO tool call:
 *   escalate — the round must be re-run on the primary model, or
 *   answer   — the router's plain reply is the final answer.
 * Mode (config.cascadeEscalate):
 *   'marker'  — escalate only on the ROUTE_MARKER (default).
 *   'always'  — every non-tool router reply escalates (correctness-first).
 *   'never'   — router replies are always final unless tools were involved.
 */
function decideNoCall(content, mode) {
  const m = String(mode || 'marker').toLowerCase();
  if (m === 'always') return 'escalate';
  if (m === 'never') return 'answer';
  return markerMatch(content) ? 'escalate' : 'answer';
}

/** systemd user unit name for a registry model id (launch/management).
 *  The cascade pair uses stable role names (llama-router.service /
 *  llama-primary.service — see the unit files); any OTHER local model uses
 *  an id-derived name (llama-<id>.service). */
function unitNameFor(m) {
  if (!m) return 'llama-model.service';
  const role = String(m.role || '');
  if (role === 'router' || role === 'primary') return `llama-${role}.service`;
  const id = String(m.id || 'model').toLowerCase();
  return `llama-${id}.service`;
}

module.exports = {
  ROUTE_MARKER,
  ROUTER_ADDENDUM,
  routerSystemPrompt,
  routerTools,
  resolve,
  resolveFrom,
  looksLikeToolAttempt,
  looksLikeFabricatedConfirmation,
  targetFor,
  isLoopback,
  markerMatch,
  decideNoCall,
  looksLikeToolAttempt,
  unitNameFor,
};