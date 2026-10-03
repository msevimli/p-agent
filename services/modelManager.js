/**
 * modelManager — multi-model registry + active-model selection for plife.
 *
 * Lets the dashboard manage several LLM endpoints (e.g. Gemma, Llama, Mistral,
 * Qwen) instead of a single hardcoded llama.cpp server. Each model is an entry
 * with its own endpoint URL, model identifier, and context length; chat routing
 * (services/llamaClient.js) resolves the currently active model at request time
 * so switching takes effect on the next message — no restart needed.
 *
 * Persistence: <dataDir>/models-state.json
 *   {
 *     "activeId": "<id|null>",
 *     "models": [ { id, name, endpoint, model, contextLength, apiKey? }, ... ]
 *   }
 *
 * The file is the source of truth and is re-read on every read so external
 * edits are picked up; all clusters are guarded so the active model can never
 * be orphaned.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const config = require('../config');

const STATE_FILE = path.join(config.dataDir, 'models-state.json');

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const URL_RE = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/;

// ---------------------------------------------------------------- storage
function loadState() {
  let raw = null;
  try { raw = fs.readFileSync(STATE_FILE, 'utf8'); } catch { /* first run */ }
  if (raw === null) {
    // First run: seed with sensible defaults so the UI has something to show.
    const seeded = defaultModels();
    saveState(seeded);
    return seeded;
  }
  let o = {};
  if (raw) {
    try { o = JSON.parse(raw); } catch { o = {}; }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) o = {};
  if (!Array.isArray(o.models)) o.models = [];
  if (typeof o.activeId !== 'string') o.activeId = null;
  return o;
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

/** Strip apiKey from a model before sending it to the client (still has hasKey). */
function publicModel(m, opts) {
  if (!m) return null;
  const { includeKey } = opts || {};
  const hasKey = !!(m.apiKey && String(m.apiKey).length);
  const out = {
    id: m.id,
    name: m.name,
    endpoint: m.endpoint,
    model: m.model,
    contextLength: m.contextLength,
    provider: m.provider || 'local',
    hasKey,
    active: false,
  };
  if (includeKey && hasKey) out.apiKey = m.apiKey;
  return out;
}

// ---------------------------------------------------------------- defaults
/** Seed the store on first run with the legacy single-model config plus a few
 * common local llama.cpp endpoints so the UI has something to show. */
function defaultModels() {
  const seeded = [
    {
      id: 'gemma',
      name: 'Gemma 2 2B Instruct',
      provider: 'local',
      endpoint: config.llamaBaseUrl,
      model: config.llamaModel,
      contextLength: 8192,
    },
    {
      id: 'qwen-coder',
      name: 'Qwen2.5 Coder 3B',
      provider: 'local',
      endpoint: 'http://127.0.0.1:8081',
      model: 'qwen2.5-coder-3b-instruct-q4_0.gguf',
      contextLength: 32768,
    },
    {
      id: 'mistral',
      name: 'Mistral 7B Instruct',
      provider: 'local',
      endpoint: 'http://127.0.0.1:8082',
      model: 'mistral-7b-instruct-v0.3.Q4_K_M.gguf',
      contextLength: 32768,
    },
    {
      id: 'llama',
      name: 'Llama 3.2 3B Instruct',
      provider: 'local',
      endpoint: 'http://127.0.0.1:8083',
      model: 'llama-3.2-3b-instruct.Q4_K_M.gguf',
      contextLength: 8192,
    },
  ];
  // The legacy config endpoints win the seed so nothing that already pointed at
  // a custom LLAMA_BASE_URL/LLAMA_MODEL loses its current setup.
  seeded[0].endpoint = config.llamaBaseUrl;
  seeded[0].model = config.llamaModel;
  return { activeId: seeded[0].id, models: seeded };
}

// ---------------------------------------------------------------- validation
function validate(body) {
  const b = body && typeof body === 'object' ? body : {};
  const errs = [];
  if (!b.id || !ID_RE.test(b.id)) errs.push('id (letters/digits/dot/dash/underscore) is required');
  if (!b.name || !String(b.name).trim()) errs.push('name is required');
  if (!b.endpoint || !URL_RE.test(b.endpoint)) errs.push('endpoint must be a valid http(s) URL');
  const model = b.model || b.modelId;
  if (!model || !MODEL_RE.test(model)) errs.push('model identifier is required');
  let contextLength = Number(b.contextLength);
  if (!(contextLength > 0)) contextLength = 8192;
  if (errs.length) return { ok: false, errors: errs };
  return {
    ok: true,
    id: b.id,
    name: String(b.name).trim(),
    provider: String(b.provider || 'local').trim() || 'local',
    endpoint: String(b.endpoint).trim().replace(/\/+$/, ''),
    model: String(model).trim(),
    contextLength,
  };
}

// ---------------------------------------------------------------- live status
/** Best-effort online check against a model's endpoint /health (llama.cpp). */
function probeStatus(endpoint) {
  return new Promise((resolve) => {
    const client = /^https:/i.test(endpoint) ? https : http;
    let req;
    try {
      req = client.get(`${endpoint}/health`, { timeout: 1500 }, (res) => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 400 ? 'online' : 'offline');
      });
    } catch {
      return resolve('unreachable');
    }
    req.on('timeout', () => { req.destroy(); resolve('timeout'); });
    req.on('error', () => resolve('unreachable'));
  });
}

// ---------------------------------------------------------------- public API
/** All models with active flag and live status. */
async function listModels() {
  const state = loadState();
  const withStatus = await Promise.all(
    state.models.map(async (m) => {
      const pub = publicModel(m);
      pub.active = m.id === state.activeId;
      pub.status = await probeStatus(m.endpoint);
      return pub;
    })
  );
  return { active: state.activeId, models: withStatus };
}

/** Resolve the active model config; falls back to legacy config if none set. */
function getActiveModel() {
  const state = loadState();
  const active = state.models.find((m) => m.id === state.activeId) || state.models[0] || null;
  if (!active) {
    // Nothing configured yet → drive off the legacy env config.
    return {
      id: 'default',
      name: 'Default (legacy config)',
      endpoint: config.llamaBaseUrl,
      model: config.llamaModel,
      contextLength: 8192,
    };
  }
  return { ...active };
}

/** Get one model by id (with optional apiKey for internal callers). */
function getModel(id, opts) {
  const state = loadState();
  const m = state.models.find((x) => x.id === id);
  return m ? publicModel(m, opts) : null;
}

/** Set the active model. Unknown id → error. */
function setActive(id) {
  const state = loadState();
  if (!state.models.some((m) => m.id === id)) {
    return { ok: false, error: `model not found: ${id}` };
  }
  state.activeId = id;
  saveState(state);
  const m = publicModel(state.models.find((x) => x.id === id));
  m.active = true;
  return { ok: true, active: id, model: m };
}

/** Create a new model. */
function createModel(body) {
  const v = validate(body);
  if (!v.ok) return { ok: false, errors: v.errors };
  const state = loadState();
  if (state.models.some((m) => m.id === v.id)) {
    return { ok: false, error: `model already exists: ${v.id}` };
  }
  const entry = {
    id: v.id,
    name: v.name,
    provider: v.provider,
    endpoint: v.endpoint,
    model: v.model,
    contextLength: v.contextLength,
  };
  if (typeof body.apiKey === 'string' && body.apiKey.trim()) entry.apiKey = body.apiKey.trim();
  // First model becomes active by default.
  if (state.models.length === 0) state.activeId = v.id;
  state.models.push(entry);
  saveState(state);
  return { ok: true, model: publicModel(entry) };
}

/** Update an existing model. `id` path param may differ from body.id — the
 * path id wins for locating, and body may rename via `newId`. */
function updateModel(id, body) {
  const state = loadState();
  const idx = state.models.findIndex((m) => m.id === id);
  if (idx === -1) return { ok: false, error: `model not found: ${id}` };
  const existing = state.models[idx];
  const patch = { ...body };
  if (patch.id === undefined) patch.id = id;
  // Allow partial updates: missing scalar fields fall back to the existing entry.
  if (patch.name === undefined) patch.name = existing.name;
  if (patch.endpoint === undefined) patch.endpoint = existing.endpoint;
  if (patch.model === undefined && patch.modelId === undefined) {
    patch.model = existing.model;
  }
  if (patch.contextLength === undefined) patch.contextLength = existing.contextLength;
  if (patch.provider === undefined) patch.provider = existing.provider;
  const v = validate(patch);
  if (!v.ok) return { ok: false, errors: v.errors };

  let targetId = v.id;
  if (v.id !== id) {
    if (state.models.some((m) => m.id === v.id)) {
      return { ok: false, error: `model already exists: ${v.id}` };
    }
    targetId = v.id;
  }

  const entry = {
    id: targetId,
    name: v.name,
    provider: v.provider,
    endpoint: v.endpoint,
    model: v.model,
    contextLength: v.contextLength,
  };
  // Preserve apiKey unless a new one (or explicit clear) was supplied.
  if (body.apiKey !== undefined) {
    if (typeof body.apiKey === 'string' && body.apiKey.trim()) entry.apiKey = body.apiKey.trim();
    else if (body.apiKey === '' || body.apiKey === null) { /* explicit clear → omit */ }
    else entry.apiKey = existing.apiKey; // keep old
  } else {
    entry.apiKey = existing.apiKey;
  }

  state.models[idx] = entry;
  if (state.activeId === id) state.activeId = targetId;
  saveState(state);
  const m = publicModel(entry);
  m.active = state.activeId === targetId;
  return { ok: true, model: m, active: state.activeId };
}

/** Delete a model. Re-points active to the first remaining model if needed. */
function deleteModel(id) {
  const state = loadState();
  const idx = state.models.findIndex((m) => m.id === id);
  if (idx === -1) return { ok: true, deleted: false, error: `model not found: ${id}` };
  state.models.splice(idx, 1);
  if (state.activeId === id) {
    state.activeId = state.models.length ? state.models[0].id : null;
  }
  saveState(state);
  return { ok: true, deleted: true, active: state.activeId };
}

module.exports = {
  STATE_FILE,
  listModels,
  getActiveModel,
  getModel,
  setActive,
  createModel,
  updateModel,
  deleteModel,
};
