/**
 * automationManager — scheduled automation engine for plife.
 *
 * Rules persist in <dataDir>/automations-state.json:
 *   { automations: [ {
 *       id, name, description, enabled,
 *       schedule: { type: 'cron', cron } | { type: 'interval', intervalMinutes },
 *       action:   { type: 'script', script, args? }
 *               | { type: 'skill',  skill, args? }
 *               | { type: 'prompt', prompt, maxTokens? },
 *       nextRunAt, lastRunAt, lastStatus, logs: [{ at, status, summary, detail }],
 *       createdAt, updatedAt
 *     } ] }
 *
 * Scheduling uses a dependency-free 5-field cron engine (minute hour dom month
 * dow) plus wall-clock-aligned intervals. An in-process tick (started from
 * server.js) checks for due jobs, executes them out-of-band, and records
 * bounded execution logs. The state file is re-read on every operation so
 * external edits (or the UI/API) are picked up immediately.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const config = require('../config');
const skillManager = require('./skillManager');
const { buildChatPayload, complete } = require('./llamaClient');
const { enqueue } = require('./requestQueue');

const STATE_FILE = path.join(config.dataDir, 'automations-state.json');
const TICK_MS = 15000; // how often the scheduler checks for due jobs
const MAX_LOGS = 20; // execution log entries kept per automation
const CRON_SCAN_CAP = 366 * 24 * 60; // minutes: how far ahead cron search may look

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SCRIPT_RE = /^[A-Za-z0-9._/-]+$/; // workspace-relative script paths only
const ACTION_TYPES = ['script', 'skill', 'prompt'];
const SCHEDULE_TYPES = ['cron', 'interval'];

// =====================================================================
// Minimal 5-field cron engine (no external deps).
// Fields: minute(0-59) hour(0-23) dom(1-31) month(1-12) dow(0-7, Sun=0|7).
// Supports `*`, `*/n`, `a-b`, `a-b/n`, comma lists, `?` and @aliases.
// =====================================================================
const CRON_ALIASES = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

const CRON_FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day-of-week', min: 0, max: 7 },
];

/** Parse one comma/step/range cron field into a sorted array of allowed values. */
function parseCronField(expr, min, max) {
  const values = new Set();
  const addRange = (a, b, step) => {
    for (let v = a; v <= b; v += step) values.add(v);
  };
  for (const part of String(expr).split(',')) {
    const p = part.trim();
    if (!p || p === '?' || p === '*') {
      addRange(min, max, 1);
      continue;
    }
    const [base, stepStr] = p.split('/');
    const step = stepStr === undefined ? 1 : parseInt(stepStr, 10);
    if (!Number.isFinite(step) || step < 1) throw new Error(`bad step in "${p}"`);
    if (base === '*' || base === '?') {
      addRange(min, max, step);
    } else {
      const m = base.match(/^(\d+)(?:-(\d+))?$/);
      if (!m) throw new Error(`bad value "${p}"`);
      const a = parseInt(m[1], 10);
      const b = m[2] ? parseInt(m[2], 10) : a;
      if (a < min || b > max || a > b) throw new Error(`value out of range in "${p}"`);
      addRange(a, b, step);
    }
  }
  return [...values].sort((x, y) => x - y);
}

/**
 * Compile a 5-field cron expression. Throws with a readable message on any
 * syntax/range error; returns { fields: [[...],...], domRestricted, dowRestricted }.
 */
function parseCron(expr) {
  let e = String(expr || '').trim();
  if (CRON_ALIASES[e]) e = CRON_ALIASES[e];
  const parts = e.split(/\s+/).filter(Boolean);
  if (parts.length !== 5) {
    throw new Error(`cron must have 5 fields (minute hour dom month dow), got ${parts.length}`);
  }
  const fields = parts.map((p, i) => parseCronField(p, CRON_FIELDS[i].min, CRON_FIELDS[i].max));
  return {
    fields,
    // vixie-cron semantics: when both dom and dow are restricted they act as OR.
    domRestricted: !(fields[2].length === 31),
    dowRestricted: !(fields[4].length === 8),
  };
}

/** Does the compiled cron match this Date (to the minute)? */
function cronMatches(compiled, date) {
  const f = compiled.fields;
  const min = date.getMinutes();
  const hour = date.getHours();
  const dom = date.getDate();
  const mon = date.getMonth() + 1;
  const dow = date.getDay(); // 0-6
  if (!f[0].includes(min) || !f[1].includes(hour) || !f[2].includes(dom) || !f[3].includes(mon)) {
    return false;
  }
  if (compiled.domRestricted && compiled.dowRestricted) {
    return f[2].includes(dom) || f[4].includes(dow) || f[4].includes(7);
  }
  return !compiled.dowRestricted || f[4].includes(dow) || f[4].includes(7);
}

/** Next date (minute-granular) strictly after `from` that matches the cron. */
function cronNextRun(compiled, from) {
  const probe = new Date(from.getTime());
  probe.setSeconds(0, 0);
  probe.setMinutes(probe.getMinutes() + 1);
  for (let i = 0; i < CRON_SCAN_CAP; i++) {
    if (cronMatches(compiled, probe)) return new Date(probe.getTime());
    probe.setMinutes(probe.getMinutes() + 1);
  }
  return null; // no match inside the scan horizon
}

// =====================================================================
// State store
// =====================================================================
function loadState() {
  let raw = null;
  try { raw = fs.readFileSync(STATE_FILE, 'utf8'); } catch { /* first run */ }
  let o = {};
  if (raw) {
    try { o = JSON.parse(raw); } catch { o = {}; }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) o = {};
  if (!Array.isArray(o.automations)) o.automations = [];
  return o;
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

/** Public shape sent to the client (logs bounded, times ISO strings). */
function publicAutomation(a) {
  return {
    id: a.id,
    name: a.name,
    description: a.description || '',
    enabled: a.enabled !== false,
    schedule: a.schedule,
    action: a.action,
    nextRunAt: a.nextRunAt || null,
    lastRunAt: a.lastRunAt || null,
    lastStatus: a.lastStatus || null,
    lastSummary: a.lastSummary || null,
    logs: Array.isArray(a.logs) ? a.logs.slice(0, MAX_LOGS) : [],
    createdAt: a.createdAt || null,
    updatedAt: a.updatedAt || null,
  };
}

// Parse-cache so list() doesn't re-parse crons every tick.
const cronCache = new Map(); // id -> { sig, compiled, error }
function compiledCron(id, cron) {
  const hit = cronCache.get(id);
  if (hit && hit.sig === cron) return hit;
  const entry = { sig: cron, compiled: null, error: null };
  try { entry.compiled = parseCron(cron); } catch (e) { entry.error = e.message; }
  cronCache.set(id, entry);
  return entry;
}

// =====================================================================
// Next-run computation
// =====================================================================
/** Aligned wall-clock slot for intervals: every N minutes on fixed boundaries. */
function intervalNextRun(intervalMinutes, fromMs, afterRunAtMs) {
  const step = Math.max(1, Math.floor(intervalMinutes)) * 60000;
  const from = afterRunAtMs || fromMs;
  const slot = Math.floor(from / step) + 1;
  const next = slot * step;
  return next > fromMs ? next : fromMs + step;
}

function computeNextRun(a, nowMs) {
  const s = a.schedule || {};
  const now = new Date(nowMs);
  if (s.type === 'interval') {
    return new Date(intervalNextRun(Number(s.intervalMinutes) || 1, nowMs)).toISOString();
  }
  const entry = compiledCron(a.id, s.cron || '');
  if (entry.error || !entry.compiled) return null;
  const next = cronNextRun(entry.compiled, now);
  return next ? next.toISOString() : null;
}

/** Recompute nextRunAt for every enabled automation, persisting only changes. */
function refreshNextRuns() {
  const state = loadState();
  const now = Date.now();
  let dirty = false;
  for (const a of state.automations) {
    const wants = a.enabled !== false ? computeNextRun(a, now) : null;
    if (a.nextRunAt !== wants) { a.nextRunAt = wants; dirty = true; }
  }
  if (dirty) saveState(state);
  return state;
}

// =====================================================================
// Validation
// =====================================================================
function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function validate(body) {
  const b = body && typeof body === 'object' ? body : {};
  const errs = [];

  let id = typeof b.id === 'string' && b.id.trim() ? b.id.trim() : slugify(b.name);
  if (!id || !ID_RE.test(id)) errs.push('id (letters/digits/dot/dash/underscore) is required');

  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) errs.push('name is required');

  const sched = b.schedule && typeof b.schedule === 'object' ? b.schedule : b;
  const schedule = {
    type: sched.type === 'cron' ? 'cron' : 'interval',
  };
  if (schedule.type === 'cron') {
    schedule.cron = String(sched.cron ?? b.cron ?? '').trim();
    if (!schedule.cron) errs.push('cron expression is required');
    else {
      try { parseCron(schedule.cron); } catch (e) { errs.push(`invalid cron: ${e.message}`); }
    }
  } else {
    const mins = Number(sched.intervalMinutes ?? b.intervalMinutes);
    schedule.intervalMinutes = Number.isFinite(mins) && mins >= 1 ? Math.floor(mins) : null;
    if (schedule.intervalMinutes === null) errs.push('intervalMinutes must be a positive number');
  }

  const at = b.action && typeof b.action === 'object' ? b.action : {};
  const actionType = ACTION_TYPES.includes(at.type ?? b.actionType) ? (at.type ?? b.actionType) : null;
  if (!actionType) errs.push(`action type must be one of: ${ACTION_TYPES.join(', ')}`);
  const action = { type: actionType };
  if (actionType === 'script') {
    action.script = String(at.script ?? b.script ?? '').trim();
    if (!action.script || !SCRIPT_RE.test(action.script)) {
      errs.push('script must be a workspace-relative path (letters/digits/dot/dash/slash/underscore)');
    }
  } else if (actionType === 'skill') {
    action.skill = String(at.skill ?? b.skill ?? '').trim();
    if (!action.skill || !skillManager.loadSkill(action.skill)) {
      errs.push(`skill not found: ${action.skill || '(empty)'}`);
    }
  } else if (actionType === 'prompt') {
    action.prompt = String(at.prompt ?? b.prompt ?? '').trim();
    if (!action.prompt) errs.push('prompt text is required');
    const mt = Number(at.maxTokens ?? b.maxTokens);
    action.maxTokens = Number.isFinite(mt) && mt > 0 ? Math.min(8192, Math.floor(mt)) : 512;
  }
  const args = Array.isArray(at.args) ? at.args.map(String).filter((x) => x.trim()) : [];
  if (args.length > 20) errs.push('too many arguments (max 20)');
  else if (args.some((x) => x.length > 500)) errs.push('argument too long (max 500 chars)');
  if (actionType === 'script' || actionType === 'skill') action.args = args;

  const description = typeof b.description === 'string' ? b.description.trim() : '';
  if (errs.length) return { ok: false, errors: errs };
  return { ok: true, id, name, description, schedule, action };
}

// =====================================================================
// Action execution
// =====================================================================
/** Resolve a workspace-relative script path, refusing traversal/absolute escapes. */
function resolveScript(rel) {
  const root = path.resolve(config.workRoot);
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

function clip(text, n) {
  const s = String(text || '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/** Run a workspace script with `node` in a bounded subprocess. */
function runScript(script, args, timeoutMs) {
  return new Promise((resolve) => {
    const abs = resolveScript(script);
    if (!abs) return resolve({ ok: false, status: 'error', summary: `script escapes workspace: ${script}`, detail: '' });
    let child;
    try {
      child = spawn(process.execPath, [abs, ...(args || [])], { cwd: path.dirname(abs) });
    } catch (e) {
      return resolve({ ok: false, status: 'error', summary: `could not start script: ${e.message}`, detail: '' });
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* gone */ }
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => resolve({ ok: false, status: 'error', summary: e.message, detail: '' }));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return resolve({ ok: false, status: 'error', summary: `script timed out after ${timeoutMs}ms`, detail: clip(stderr, 800) });
      const ok = code === 0;
      resolve({ ok, status: ok ? 'success' : 'error', summary: clip(stdout.trim().split('\n')[0] || (ok ? 'exit 0' : `exit ${code}`), 200), detail: clip((ok ? stdout : stdout + stderr).trim(), 1200) });
    });
  });
}

/** Run a skill via skillManager's bounded subprocess runner. */
function runSkillAction(skill, args, timeoutMs) {
  return skillManager.runSkill(skill, args || [], { timeoutMs }).then((r) => {
    if (!r.ok) return { ok: false, status: 'error', summary: r.error || 'skill failed', detail: '' };
    if (r.timedOut) return { ok: false, status: 'error', summary: `skill timed out after ${timeoutMs}ms`, detail: clip(r.stderr, 800) };
    const ok = r.code === 0;
    return {
      ok,
      status: ok ? 'success' : 'error',
      summary: clip(r.stdout.trim().split('\n')[0] || (ok ? 'exit 0' : `exit ${r.code}`), 200),
      detail: clip((r.stdout + r.stderr).trim(), 1200),
    };
  });
}

/** Ask the active local LLM to perform the prompt (stream fully, then record). */
const PROMPT_TASK_SYSTEM =
  'You are an automated assistant executing a scheduled task. Complete the task below and reply with the final result only.';
function runPrompt(promptText, maxTokens, timeoutMs) {
  const payload = buildChatPayload(
    [{ role: 'user', content: promptText }],
    { temperature: 0.3, max_tokens: maxTokens || 512 },
    { system: PROMPT_TASK_SYSTEM }
  );
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`prompt timed out after ${timeoutMs}ms`)), timeoutMs);
    complete({ payload })
      .then((acc) => {
        clearTimeout(timer);
        const content = (acc.content || '').trim();
        if (!content) return resolve({ ok: false, status: 'error', summary: 'empty response from model', detail: '' });
        const usage = acc.usage && acc.usage.total_tokens ? ` [${acc.usage.total_tokens} tokens]` : '';
        resolve({ ok: true, status: 'success', summary: clip(content.split('\n')[0], 200), detail: clip(content, 1200) + usage });
      })
      .catch((e) => {
        clearTimeout(timer);
        reject(e);
      });
  });
}

/**
 * Execute one automation's action. Never throws; returns { ok, status, summary, detail }.
 * Script/skill spawns go through the FIFO request queue (heavy subprocesses);
 * prompt actions must NOT be enqueued here — llamaClient.complete() already
 * owns its queue slot and double-wrapping would deadlock the queue.
 */
async function execute(a) {
  const act = a.action || {};
  const timeoutMs = config.automationTimeoutMs;
  if (act.type === 'script') {
    return enqueue(() => runScript(act.script, act.args, timeoutMs), { label: `script:${act.script}` }).promise;
  }
  if (act.type === 'skill') {
    if (!skillManager.loadSkill(act.skill)) {
      return { ok: false, status: 'error', summary: `skill not found: ${act.skill}`, detail: '' };
    }
    return enqueue(() => runSkillAction(act.skill, act.args, timeoutMs), { label: `skill:${act.skill}` }).promise;
  }
  if (act.type === 'prompt') {
    try {
      return await runPrompt(act.prompt, act.maxTokens, timeoutMs);
    } catch (e) {
      return { ok: false, status: 'error', summary: e.message || 'prompt failed', detail: '' };
    }
  }
  return { ok: false, status: 'error', summary: `unknown action type: ${String(act.type)}`, detail: '' };
}

/** Append a run record to an automation's log (bounded), persisted. */
function recordRun(automationId, result) {
  const state = loadState();
  const a = state.automations.find((x) => x.id === automationId);
  if (!a) return;
  const entry = {
    at: new Date().toISOString(),
    status: result.status,
    summary: result.summary || '',
    detail: result.detail || '',
  };
  a.lastRunAt = entry.at;
  a.lastStatus = entry.status;
  a.lastSummary = entry.summary;
  a.logs = [entry, ...(Array.isArray(a.logs) ? a.logs : [])].slice(0, MAX_LOGS);
  // Schedule the next occurrence (interval slots continue from the run time).
  if (a.enabled !== false) {
    const next = computeNextRun(a, Date.now());
    if (next) a.nextRunAt = next;
    else a.nextRunAt = null;
  }
  saveState(state);
}

// =====================================================================
// Public API
// =====================================================================
const running = new Set(); // automation ids with an execution in flight

function list() {
  const state = refreshNextRuns();
  return state.automations.map(publicAutomation);
}

function get(id) {
  const state = refreshNextRuns();
  const a = state.automations.find((x) => x.id === id);
  return a ? publicAutomation(a) : null;
}

function create(body) {
  const v = validate(body);
  if (!v.ok) return { ok: false, errors: v.errors };
  const state = loadState();
  if (state.automations.some((a) => a.id === v.id)) {
    return { ok: false, errors: [`automation already exists: ${v.id}`] };
  }
  const now = new Date().toISOString();
  const entry = {
    id: v.id,
    name: v.name,
    description: v.description,
    enabled: true,
    schedule: v.schedule,
    action: v.action,
    nextRunAt: null,
    lastRunAt: null,
    lastStatus: null,
    lastSummary: null,
    logs: [],
    createdAt: now,
    updatedAt: now,
  };
  entry.nextRunAt = computeNextRun(entry, Date.now());
  state.automations.push(entry);
  saveState(state);
  return { ok: true, automation: publicAutomation(entry) };
}

function update(id, body) {
  const state = loadState();
  const idx = state.automations.findIndex((a) => a.id === id);
  if (idx === -1) return { ok: false, error: `automation not found: ${id}` };
  const existing = state.automations[idx];
  const patch = validate({ ...existing, ...(body || {}), id });
  if (!patch.ok) return { ok: false, errors: patch.errors };
  // Replace scheduling/action wholesale but keep id + run history.
  const merged = {
    ...existing,
    name: patch.name,
    description: patch.description,
    schedule: patch.schedule,
    action: patch.action,
    enabled: body && typeof body.enabled === 'boolean' ? body.enabled : existing.enabled !== false,
    updatedAt: new Date().toISOString(),
  };
  merged.nextRunAt = merged.enabled !== false ? computeNextRun(merged, Date.now()) : null;
  state.automations[idx] = merged;
  cronCache.delete(id);
  saveState(state);
  return { ok: true, automation: publicAutomation(merged) };
}

function setEnabled(id, enabled) {
  const state = loadState();
  const a = state.automations.find((x) => x.id === id);
  if (!a) return { ok: false, error: `automation not found: ${id}` };
  a.enabled = enabled !== false;
  a.nextRunAt = a.enabled ? computeNextRun(a, Date.now()) : null;
  a.updatedAt = new Date().toISOString();
  saveState(state);
  return { ok: true, automation: publicAutomation(a) };
}

function remove(id) {
  const state = loadState();
  const idx = state.automations.findIndex((a) => a.id === id);
  if (idx === -1) return { ok: true, deleted: false, error: `automation not found: ${id}` };
  state.automations.splice(idx, 1);
  cronCache.delete(id);
  saveState(state);
  return { ok: true, deleted: true, id };
}

/** Manual on-demand trigger. Returns immediately; the run completes in the
 * background and its outcome lands in the automation's log. Works while paused. */
async function runNow(id) {
  const state = loadState();
  const a = state.automations.find((x) => x.id === id);
  if (!a) return { ok: false, error: `automation not found: ${id}` };
  if (running.has(id)) return { ok: false, error: 'automation is already running' };
  running.add(id);
  // Fire and forget: log the outcome asynchronously.
  execute(a)
    .then((result) => {
      recordRun(id, result);
      running.delete(id);
    })
    .catch((e) => {
      recordRun(id, { ok: false, status: 'error', summary: e.message || 'run failed', detail: '' });
      running.delete(id);
    });
  return { ok: true, started: true, id };
}

/** Check the store for due jobs and launch them (used by the tick and tests). */
function checkDue(nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const state = loadState();
  for (const a of state.automations) {
    if (a.enabled === false) continue;
    if (!a.nextRunAt || new Date(a.nextRunAt).getTime() > now) continue;
    if (running.has(a.id)) continue;
    running.add(a.id);
    Promise.resolve()
      .then(() => execute(a))
      .then((result) => { recordRun(a.id, result); running.delete(a.id); })
      .catch((e) => { recordRun(a.id, { ok: false, status: 'error', summary: e.message || 'run failed', detail: '' }); running.delete(a.id); });
  }
}

let tickTimer = null;
function start() {
  if (tickTimer) return;
  tickTimer = setInterval(() => checkDue(Date.now()), TICK_MS);
  tickTimer.unref?.();
}
function stop() {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
}

module.exports = {
  STATE_FILE,
  list,
  get,
  create,
  update,
  setEnabled,
  remove,
  runNow,
  checkDue,
  execute,
  start,
  stop,
  // cron engine (exported for unit tests)
  parseCron,
  cronMatches,
  cronNextRun,
};