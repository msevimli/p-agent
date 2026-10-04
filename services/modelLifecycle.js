/**
 * modelLifecycle — Model lifecycle & status management for plife.
 *
 * Solves the "cold start" visibility problem for local llama.cpp models:
 * the dashboard header shows a live lifecycle badge (unloaded | loading |
 * ready | error) with memory footprint and lets the user explicitly
 * Warm-up (background pre-load/prefill) or Eject (free weights from memory).
 *
 * Lifecycle states:
 *   unloaded — the model is not resident in memory (server down, or a
 *              router-mode llama-server with no model loaded)
 *   loading  — an explicit warm-up is in flight, or a request is in the
 *              prefill phase (cold start: prompt tokens being processed)
 *   ready    — model loaded and responsive (may be busy generating)
 *   error    — the last lifecycle operation failed; auto-clears once a
 *              subsequent probe sees the server healthy again
 *
 * Probing is endpoint-specific (per model registry entry), NOT tied to the
 * active model, so a 4-port local setup (gemma/qwen/mistral/llama) reports
 * each server independently. Signals used:
 *   GET  /health            server up + (single-model mode) model loaded
 *   GET  /v1/models         loaded-model list (model router mode)
 *   GET  /slots             prefill/busy detection + context capacity
 *
 * Eject (freeing weights) is capability-tiered because llama.cpp can only
 * unload at runtime when started as a model router:
 *   1. POST /models/unload (model-router mode)  -> true unload, 200/204
 *   2. POST /slots/:id?action=erase (--slot-save-path) -> KV cache freed,
 *      weights stay resident (degraded but honest)
 *   3. neither available -> ok:true + degraded:true + guidance; the
 *      lifecycle stays 'ready' because the weights are still resident.
 *
 * Warm-up runs through the same FIFO request queue as chat (never two
 * concurrent connections into a single-slot llama.cpp) and sends a
 * max_tokens=1 completion, which loads the model and prefills the KV cache.
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('../config');
const modelManager = require('./modelManager');
const requestQueue = require('./requestQueue');

// ---------------------------------------------------------------- state
/** id -> { lifecycle, since, phase, detail, online, busy, memory, op, opError } */
const lifecycles = new Map();

function lc(id) {
  let e = lifecycles.get(id);
  if (!e) {
    e = { lifecycle: null, since: null, phase: null, detail: null, online: false, busy: false, memory: null, op: null, opError: null, slotSig: null, slotStreak: 0 };
    lifecycles.set(id, e);
  }
  return e;
}

/** Persist a lifecycle transition (with timestamp). */
function setLifecycle(id, lifecycle, { phase = null, detail = null } = {}) {
  const e = lc(id);
  if (e.lifecycle !== lifecycle || e.detail !== detail) e.since = new Date().toISOString();
  e.lifecycle = lifecycle;
  e.phase = phase;
  e.detail = detail;
  if (lifecycle !== 'error') e.opError = null;
}

/** Mark an explicit operation (warm-up etc.) as in flight for a model. */
function setOp(id, kind, phase, detail) {
  const e = lc(id);
  e.op = { kind, phase, since: new Date().toISOString(), detail };
}

function clearOp(id) {
  lc(id).op = null;
}

// ---------------------------------------------------------------- urls + http
/** Strip trailing slashes. */
function stripSlash(url) {
  return String(url || '').replace(/\/+$/, '');
}

/** Server root for llama.cpp-native (non-OpenAI) endpoints: strip a
 * trailing /v1 and/or /chat/completions so /models/unload, /slots etc.
 * never double their path segments. */
function rootUrl(base) {
  return stripSlash(base)
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/v1$/i, '');
}

/** OpenAI chat-completions URL for a base endpoint (mirrors llamaClient). */
function chatCompletionsUrl(base) {
  const b = stripSlash(base).replace(/\/chat\/completions$/i, '');
  return /\/v1$/i.test(b) ? `${b}/chat/completions` : `${b}/v1/chat/completions`;
}

/** Best-effort GET returning { code, body } (body = raw text). */
function httpGetJson(url, { timeout = 4000, apiKey = '' } = {}) {
  return new Promise((resolve) => {
    const client = /^https:/i.test(url) ? https : http;
    const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    let req;
    try {
      req = client.get(url, { timeout, headers }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ code: res.statusCode || 0, body }));
      });
    } catch {
      return resolve({ code: 0, body: '' });
    }
    req.on('timeout', () => { req.destroy(); resolve({ code: 0, body: '' }); });
    req.on('error', () => resolve({ code: 0, body: '' }));
  });
}

/** Best-effort POST (JSON body) returning { code, body }. */
function httpPostJson(url, data, { timeout = 10000, apiKey = '' } = {}) {
  return new Promise((resolve) => {
    const client = /^https:/i.test(url) ? https : http;
    const payload = JSON.stringify(data === undefined ? {} : data);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    let req;
    try {
      req = client.request(url, { method: 'POST', timeout, headers }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ code: res.statusCode || 0, body }));
      });
    } catch {
      return resolve({ code: 0, body: '' });
    }
    req.on('timeout', () => { req.destroy(); resolve({ code: 0, body: '' }); });
    req.on('error', () => resolve({ code: 0, body: '' }));
    req.write(payload);
    req.end();
  });
}

/** Local llama.cpp endpoints are the only ones with lifecycle controls. */
function isLocal(model) {
  if (model && model.provider === 'local') return true;
  const url = String((model && model.endpoint) || '');
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])([:/]|$)/i.test(url);
}

// ---------------------------------------------------------------- memory
/**
 * Approximate the weights footprint by locating the GGUF on disk:
 *   1. the model string itself (absolute or workRoot-relative),
 *   2. ~/models/<basename>, 3. <llama.cpp>/models/<basename>,
 *   4. <workRoot>/models/<basename>.
 * Returns MiB (float) or null when the file can't be found.
 */
function resolveModelMiB(modelStr) {
  if (!modelStr) return null;
  const base = String(modelStr).replace(/^[./]+/, '');
  const candidates = [];
  const add = (p) => { if (p) candidates.push(p); };
  add(String(modelStr));
  add(path.isAbsolute(String(modelStr)) ? null : path.join(config.workRoot, String(modelStr)));
  add(path.join(os.homedir(), 'models', path.basename(String(modelStr))));
  const llamaCppDir = '/home/openclaw/llama.cpp';
  if (fs.existsSync(llamaCppDir)) add(path.join(llamaCppDir, 'models', path.basename(String(modelStr))));
  add(path.join(config.workRoot, 'models', path.basename(String(modelStr))));
  for (const p of candidates) {
    try {
      const st = fs.statSync(p);
      if (st.isFile() && st.size > 0) return Math.round((st.size / 1048576) * 10) / 10;
    } catch { /* next candidate */ }
  }
  return null;
}

// ---------------------------------------------------------------- probing
/**
 * Probe one model entry and derive its lifecycle from live signals.
 * Resolves to the public status object fed to /api/models/status.
 * `isActive` tells the probe whether this model owns the request queue
 * (queue activity == the model is working) — computed once per sweep.
 */
async function probeModel(m, isActive) {
  const id = m.id;
  const apiKey = modelManager.resolveApiKey(id);
  const e = lc(id);

  // Explicit operation in flight (warm-up) — it owns the lifecycle until it settles.
  if (e.op && e.op.kind === 'warmup') {
    return {
      ...publicStatus(m),
      lifecycle: 'loading',
      phase: e.op.phase,
      since: e.op.since,
      detail: e.op.detail,
      online: true,
      busy: false,
      memory: e.memory || null,
    };
  }
  // A failed op pins the 'error' state until the server proves healthy again.
  if (e.opError) {
    const healthy = await modelManager.probeStatus(m.endpoint, apiKey);
    if (healthy !== 'online') {
      return { ...publicStatus(m), lifecycle: 'error', phase: 'op-failed', since: e.since, detail: e.opError, online: false, busy: false, memory: null };
    }
    e.opError = null;
  }

  if (!isLocal(m)) {
    const st = await modelManager.probeStatus(m.endpoint, apiKey);
    const online = st === 'online';
    return {
      ...publicStatus(m),
      lifecycle: online ? 'ready' : 'error',
      phase: null,
      since: e.since,
      detail: online
        ? 'remote endpoint — model is provider-side, no local weights to manage'
        : `endpoint unreachable (${st})`,
      online,
      busy: false,
      memory: null,
      ejectSupported: false,
    };
  }

  // ---- local llama.cpp ----
  const st = await modelManager.probeStatus(m.endpoint, apiKey);
  if (st !== 'online') {
    setLifecycle(id, 'unloaded', { detail: `llama.cpp server not reachable (${st}) — model not in memory` });
    return { ...publicStatus(m), lifecycle: 'unloaded', phase: null, since: e.since, detail: e.detail || `server not reachable (${st})`, online: false, busy: false, memory: null };
  }

  // Server up: is a model actually loaded? (model-router servers may serve
  // HTTP with zero models loaded.)
  const models = await httpGetJson(modelManager.probeUrlFor(m.endpoint), { apiKey });
  let loaded = true;
  try {
    const parsed = JSON.parse(models.body);
    if (Array.isArray(parsed.data) && parsed.data.length === 0) loaded = false;
  } catch { /* unparseable — trust /health */ }

  // Slots: working/prefill detection + context capacity. Two signals are
  // combined because llama.cpp builds differ wildly:
  //  - is_processing / n_prompt_tokens_processed: populated on modern
  //    builds; VERIFIED ABSENT on the production gemma build (never true
  //    during a live 44s prompt prefill), so it cannot be the only signal.
  //  - slot-state drift (id_task / n_prompt_tokens advancing between
  //    probes): universal — a changed task id means work happened since the
  //    last poll. Task "tombstones" persist after completion (id_task stays
  //    set), so a 2-probe debounce rides out a finished task without
  //    flipping the badge mid-generation.
  //  - the plife request queue: the exact "a completion is in flight"
  //    signal for the ACTIVE model (every chat / automation / warm-up runs
  //    through it), covering the whole generation duration.
  const slots = await httpGetJson(`${rootUrl(m.endpoint)}/slots`, { apiKey });
  let processing = false; // is_processing flagged by the server (modern builds)
  let prefilling = false; // prompt tokens partially processed (modern builds)
  let mutated = false;    // any slot state changed since the last probe
  let hasTask = false;
  let promptTotal = 0;
  let promptDone = 0;
  let ctxTokens = 0;
  let slotCount = 0;
  try {
    const list = JSON.parse(slots.body);
    if (Array.isArray(list)) {
      slotCount = list.length;
      const sigs = {};
      const prev = e.slotSig || {};
      for (const s of list) {
        if (!s) continue;
        if (Number(s.n_ctx)) ctxTokens += Number(s.n_ctx);
        if (s.is_processing === true) processing = true;
        const total = Number(s.n_prompt_tokens) || 0;
        const done = Number(s.n_prompt_tokens_processed) || 0;
        sigs[s.id] = `${s.id_task || s.task_id || 0}:${total}:${done}`;
        if (prev[s.id] !== undefined && prev[s.id] !== sigs[s.id]) mutated = true;
        if (total > 0) promptTotal += total;
        if (s.is_processing === true && total > 0 && done < total) {
          prefilling = true;
          promptDone += done;
        }
      }
      e.slotSig = sigs;
      hasTask = list.some((s) => s && (Number(s.id_task) > 0 || Number(s.task_id) > 0));
      e.slotStreak = hasTask && !mutated && !processing ? (e.slotStreak || 0) + 1 : 0;
    }
  } catch { /* no /slots — lifecycle falls back to health-only */ }

  const memory = {
    modelMiB: resolveModelMiB(m.model || m.modelId),
    ctxTokens: ctxTokens || Number(m.contextLength) || null,
    slots: slotCount || null,
    lastPromptTokens: promptTotal || null,
  };

  if (!loaded) {
    setLifecycle(id, 'unloaded', { detail: 'server is up but no model is loaded (model-router mode)' });
    return { ...publicStatus(m), lifecycle: 'unloaded', phase: null, since: e.since, detail: e.detail, online: true, busy: false, memory };
  }

  const queueActive = !!isActive && !!requestQueue.stats().active;
  const working = processing || prefilling || queueActive || mutated || (hasTask && (e.slotStreak || 0) < 2);

  if (prefilling) {
    const pct = promptTotal ? Math.min(99, Math.round((promptDone / promptTotal) * 100)) : null;
    setLifecycle(id, 'loading', { phase: 'prefill', detail: `cold start — processing prompt${pct !== null ? ` (${pct}%)` : ''}` });
    return { ...publicStatus(m), lifecycle: 'loading', phase: 'prefill', since: e.since, detail: e.detail, online: true, busy: true, memory, prefillPct: pct };
  }
  if (working) {
    setLifecycle(id, 'loading', { phase: 'processing', detail: 'model is working — completion in progress' });
    return { ...publicStatus(m), lifecycle: 'loading', phase: 'processing', since: e.since, detail: e.detail, online: true, busy: true, memory };
  }
  setLifecycle(id, 'ready', { detail: 'model loaded and responsive' });
  return { ...publicStatus(m), lifecycle: 'ready', phase: null, since: e.since, detail: e.detail, online: true, busy: false, memory };
}

function publicStatus(m) {
  return {
    id: m.id,
    name: m.name,
    model: m.model,
    provider: m.provider || 'local',
    endpoint: m.endpoint,
    contextLength: m.contextLength,
  };
}

/** Status for every registry model (parallel probes). */
async function getStatuses() {
  const { active, models } = await modelManager.listModels();
  const probed = await Promise.all(models.map((m) => probeModel(modelManager.getModel(m.id) || m, m.id === active)));
  return { active, models: probed };
}

/** Status for a single model (used after ops; null when unknown). */
async function getStatus(id) {
  const m = modelManager.getModel(id);
  if (!m) return null;
  const active = modelManager.getActiveModel();
  return probeModel(m, active && active.id === id);
}

// ---------------------------------------------------------------- warm-up
/**
 * Trigger a background pre-load: enqueue a max_tokens=1 completion through
 * the same FIFO queue as chat. On a single-model llama-server this confirms
 * the weights are resident and prefills the KV cache so the first real user
 * prompt starts instantly. Lifecycle shows 'loading (warming)' in flight.
 */
async function warmup(id) {
  const m = modelManager.getModel(id);
  if (!m) return { ok: false, code: 404, error: `model not found: ${id}` };
  if (!isLocal(m)) {
    return { ok: false, code: 400, error: 'Warm-up applies to local llama.cpp endpoints only (remote models have no local weights to pre-load).' };
  }
  const entry = lc(id);
  if (entry.op && entry.op.kind === 'warmup') {
    return { ok: true, already: true, detail: 'warm-up already in progress', since: entry.op.since };
  }
  const st = await modelManager.probeStatus(m.endpoint, modelManager.resolveApiKey(id));
  if (st !== 'online') {
    return { ok: false, code: 502, error: `llama.cpp server at ${m.endpoint} is not reachable (${st}) — start llama-server first, then warm up.` };
  }

  setOp(id, 'warmup', 'warming', 'warm-up in progress — pre-loading model…');
  const started = Date.now();
  try {
    const q = requestQueue.enqueue(() => warmComplete(m), { label: `warmup:${id}` });
    const r = await q.promise;
    clearOp(id);
    if (!r.ok) {
      setLifecycle(id, 'error', { detail: `warm-up failed: ${r.error}` });
      return { ok: false, code: 502, error: `warm-up failed: ${r.error}` };
    }
    const ms = Date.now() - started;
    setLifecycle(id, 'ready', { detail: `model warm — ${r.tokens} prompt tokens · ${(ms / 1000).toFixed(1)}s` });
    return { ok: true, warmed: true, ms, detail: `model warm (${(ms / 1000).toFixed(1)}s)`, promptTokens: r.tokens };
  } catch (err) {
    clearOp(id);
    const msg = String((err && err.message) || err || 'unknown error');
    setLifecycle(id, 'error', { detail: `warm-up failed: ${msg}` });
    return { ok: false, code: 502, error: `warm-up failed: ${msg}` };
  }
}

/** One tiny non-streaming completion against a SPECIFIC model endpoint. */
function warmComplete(m) {
  return new Promise((resolve) => {
    const timeoutMs = Number(config.warmupTimeoutMs) || 120000;
    const payload = {
      model: m.model,
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
      max_tokens: 1,
      temperature: 0,
      stream: false,
    };
    const url = chatCompletionsUrl(m.endpoint);
    const apiKey = modelManager.resolveApiKey(m.id);
    httpPostJson(url, payload, { timeout: timeoutMs, apiKey }).then(({ code, body }) => {
      if (code >= 200 && code < 300) {
        let tokens = null;
        try {
          const parsed = JSON.parse(body);
          tokens = parsed && parsed.usage && Number.isFinite(parsed.usage.prompt_tokens)
            ? parsed.usage.prompt_tokens
            : null;
        } catch { /* usage optional */ }
        resolve({ ok: true, tokens });
      } else {
        const msg = (() => {
          try {
            const parsed = JSON.parse(body);
            return (parsed.error && (parsed.error.message || parsed.error.code)) || body.slice(0, 200);
          } catch { return body.slice(0, 200) || `HTTP ${code}`; }
        })();
        resolve({ ok: false, error: `llama.cpp ${code}: ${msg}` });
      }
    });
  });
}

// ---------------------------------------------------------------- eject
// Capability cache: endpoint -> { knownAt, unload: true|false }
const unloadCapCache = new Map();
const CAP_TTL_MS = 5 * 60 * 1000;

/**
 * Probe runtime-unload support without unloading anything: the router-mode
 * handler answers 2xx/400 to a stub body (400 = missing model id is still
 * 'capable'), non-router servers answer 404/405.
 */
async function probeUnloadCapability(m) {
  const key = String(m.endpoint);
  const cached = unloadCapCache.get(key);
  if (cached && Date.now() - cached.knownAt < CAP_TTL_MS) return cached.unload;
  const apiKey = modelManager.resolveApiKey(m.id);
  const { code } = await httpPostJson(`${rootUrl(m.endpoint)}/models/unload`, {}, { timeout: 8000, apiKey });
  const unload = code !== 404 && code !== 405 && code !== 501 && code !== 0;
  unloadCapCache.set(key, { knownAt: Date.now(), unload });
  return unload;
}

/**
 * Eject / unload a local model from memory. Capability-tiered (see header):
 * true unload when the server exposes the model-router API, a KV-cache
 * erase fallback when --slot-save-path is available, and an honest
 * degraded result otherwise — the response never claims the weights were
 * freed when they weren't.
 */
async function eject(id) {
  const m = modelManager.getModel(id);
  if (!m) return { ok: false, code: 404, error: `model not found: ${id}` };
  if (!isLocal(m)) {
    return { ok: false, code: 400, error: 'Eject applies to local llama.cpp endpoints only (remote models have no local weights to free).' };
  }
  const entry = lc(id);
  if (entry.op && entry.op.kind === 'warmup') {
    return { ok: false, code: 409, error: 'A warm-up is in flight for this model — wait for it to finish before ejecting.' };
  }
  const apiKey = modelManager.resolveApiKey(m.id);
  const st = await modelManager.probeStatus(m.endpoint, apiKey);
  if (st !== 'online') {
    return { ok: false, code: 502, error: `llama.cpp server at ${m.endpoint} is not reachable (${st}) — nothing to eject.` };
  }

  // Tier 1: model-router mode — true unload.
  const u = await httpPostJson(`${rootUrl(m.endpoint)}/models/unload`, {}, { timeout: 15000, apiKey });
  if (u.code === 200 || u.code === 204) {
    unloadCapCache.set(String(m.endpoint), { knownAt: Date.now(), unload: true });
    setLifecycle(id, 'unloaded', { detail: 'model unloaded — weights freed from memory' });
    return { ok: true, unloaded: true, detail: 'model unloaded — weights freed from memory' };
  }
  if (u.code === 404 || u.code === 405 || u.code === 501) {
    unloadCapCache.set(String(m.endpoint), { knownAt: Date.now(), unload: false });

    // Tier 2: erase the KV caches (frees context memory; needs --slot-save-path).
    const slots = await httpGetJson(`${rootUrl(m.endpoint)}/slots`, { apiKey });
    let cleared = 0;
    try {
      const list = JSON.parse(slots.body);
      if (Array.isArray(list)) {
        for (const s of list) {
          // Only fully idle slots — never erase while a task is queued/processing.
          if (!s || s.is_processing === true || Number(s.id_task) > 0 || Number(s.task_id) > 0) continue;
          const r = await httpPostJson(
            `${rootUrl(m.endpoint)}/slots/${encodeURIComponent(s.id)}?action=erase`,
            {},
            { timeout: 8000, apiKey }
          );
          if (r.code === 200 || r.code === 204) cleared += 1;
        }
      }
    } catch { /* erase best-effort */ }

    if (cleared > 0) {
      setLifecycle(id, 'ready', { detail: `KV cache erased on ${cleared} slot(s); weights remain resident (no runtime unload on this server)` });
      return {
        ok: true,
        unloaded: false,
        degraded: true,
        cleared,
        detail: `This llama.cpp instance has no runtime model unload (POST /models/unload → HTTP ${u.code}; start it with the model router for true weight ejection). KV caches were erased on ${cleared} idle slot(s) — context memory freed, model weights remain resident.`,
      };
    }
    setLifecycle(id, 'ready', { detail: 'no runtime unload available on this server instance — weights remain resident' });
    return {
      ok: true,
      unloaded: false,
      degraded: true,
      cleared: 0,
      detail: `This llama.cpp instance cannot unload models at runtime (POST /models/unload → HTTP ${u.code}, slot erase → 501 without --slot-save-path). The model stays resident. Restart llama-server with the model router (--router) for true eject-from-memory support.`,
    };
  }
  setLifecycle(id, 'error', { detail: `unload failed (HTTP ${u.code})` });
  return { ok: false, code: 502, error: `unload failed: HTTP ${u.code} ${String(u.body).slice(0, 200)}` };
}

module.exports = {
  getStatuses,
  getStatus,
  warmup,
  eject,
  probeUnloadCapability,
  isLocal,
};