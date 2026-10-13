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
 *     "models": [ { id, name, endpoint, model, contextLength, provider }, ... ]
 *   }
 *
 * API keys are NEVER stored here. They live in <root>/.env (gitignored) as
 * `LLAMA_API_KEY_<MODEL_ID>` per-model variables (fallback: the global
 * `LLAMA_API_KEY` from the legacy env config). Keys typed into the dashboard
 * are routed to .env by writeDotEnvVar(); presence is tracked as the hasKey
 * flag in API responses.
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
const templateStore = require('./templateStore');

const STATE_FILE = path.join(config.dataDir, 'models-state.json');
const DOTENV_FILE = config.dotEnvFile;

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const URL_RE = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/;
const ENV_NAME_RE = /^[A-Z0-9_]+$/;

// ---------------------------------------------------------------- secrets
/** Map a model id to its per-model env variable: LLAMA_API_KEY_<ID_UPPER>. */
function envVarForModel(id) {
  return 'LLAMA_API_KEY_' + String(id || '').toUpperCase().replace(/[^A-Z0-9_]/g, '_');
}

/**
 * Resolve the bearer token for a model: per-model .env variable first, then
 * the shared legacy LLAMA_API_KEY fallback. Never reads models-state.json.
 */
function resolveApiKey(id) {
  const perModel = process.env[envVarForModel(id)];
  if (perModel && String(perModel).trim()) return String(perModel).trim();
  return config.llamaApiKey || '';
}

/**
 * Upsert (value) or remove (null/undefined/'') a variable in .env, then
 * mirror it into this process's env so the change applies immediately
 * without a restart. Preserves all other lines and the 0600 file mode.
 */
function writeDotEnvVar(name, value) {
  if (!ENV_NAME_RE.test(name)) return { ok: false, error: `invalid env var name: ${name}` };
  const keep = value !== null && value !== undefined && String(value).trim() !== '';
  const line = `${name}=${keep ? String(value).trim() : ''}`;
  let raw = '';
  try { raw = fs.readFileSync(DOTENV_FILE, 'utf8'); } catch { /* first write */ }
  const out = raw
    .split('\n')
    .filter((l) => !new RegExp(`^${name}=`).test(l.trim()))
    .concat(keep ? [line] : [])
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '') + '\n';
  try {
    fs.mkdirSync(path.dirname(DOTENV_FILE), { recursive: true });
    fs.writeFileSync(DOTENV_FILE, out, { mode: 0o600 });
    fs.chmodSync(DOTENV_FILE, 0o600);
  } catch (e) {
    return { ok: false, error: `could not write ${DOTENV_FILE}: ${e.message}` };
  }
  if (keep) process.env[name] = String(value).trim();
  else delete process.env[name];
  return { ok: true, var: name, set: keep };
}

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
  // Schema normalization + one-time migration on load: every entry carries a
  // hasKey boolean (true only where a key is configured AND needed, i.e. not
  // loopback) and a provider auto-detected from the endpoint URL. Existing
  // entries that predate the schema (provider 'local' on remote endpoints,
  // missing hasKey) are corrected and persisted once.
  let dirty = false;
  for (const m of o.models) {
    if (!m || typeof m !== 'object') continue;
    if (!m.provider || m.provider === 'local') {
      const auto = detectProvider(m.endpoint, undefined);
      if (m.provider !== auto) { m.provider = auto; dirty = true; }
    }
    const hk = !!resolveApiKey(m.id) && !isLoopback(m.endpoint);
    if (m.hasKey !== hk) { m.hasKey = hk; dirty = true; }
  }
  if (dirty) saveState(o);
  return o;
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

/** Local llama.cpp endpoints never need a bearer token. */
function isLoopback(url) {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])([:/]|$)/i.test(String(url || ''));
}

/**
 * Assign a provider label from the endpoint URL when none was given:
 * loopback llama.cpp servers → 'local', openrouter.ai hosts → 'openrouter',
 * any other non-loopback endpoint → 'remote'. An explicit provider always
 * wins — this only fixes the old "everything defaults to local" behavior.
 */
function detectProvider(endpoint, explicit) {
  const given = explicit !== undefined && explicit !== null ? String(explicit).trim() : '';
  if (given) return given;
  if (isLoopback(endpoint)) return 'local';
  const host = String(endpoint || '')
    .replace(/^https?:\/\//i, '')
    .split(/[/:]/)[0]
    .toLowerCase();
  if (host === 'openrouter.ai' || host.endsWith('.openrouter.ai')) return 'openrouter';
  return 'remote';
}

/**
 * Models-panel section category for an entry:
 *   'cascade' — member of the two-stage cascade pair (role router/primary);
 *   'local'   — standalone local llama.cpp server (loopback, no cascade role);
 *   'cloud'   — remote OpenAI-compatible / OpenRouter endpoint.
 * The cascade category is role-driven (not endpoint-driven): a remote model
 * mis-configured with a role still lands in the cascade section so the
 * mismatch is visible instead of silently hidden in Cloud.
 */
function categoryFor(m) {
  const role = String(m && m.role || '');
  if (role === 'router' || role === 'primary') return 'cascade';
  return isLoopback(m && m.endpoint) ? 'local' : 'cloud';
}

/** Strip secrets from a model before sending it to the client (still has hasKey). */
function publicModel(m, opts) {
  if (!m) return null;
  const { includeKey } = opts || {};
  const key = resolveApiKey(m.id);
  // hasKey means "a key is configured where one is needed": the global
  // fallback applies to every model at resolution time, but reporting it on
  // loopback models would be wrong — they never authenticate.
  const hasKey = !!key && !isLoopback(m.endpoint);
  const out = {
    id: m.id,
    name: m.name,
    endpoint: m.endpoint,
    model: m.model,
    contextLength: m.contextLength,
    provider: m.provider || 'local',
    role: String(m.role || ''),
    templateId: String(m.templateId || ''),
    category: categoryFor(m),
    hasKey,
    active: false,
  };
  if (includeKey && hasKey) out.apiKey = key;
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
  // Hard cap of 1M tokens: modern large models (DeepSeek 3.x, Claude, ...)
  // legitimately run 100k–1M context windows, so only an absurd value is
  // clamped rather than rejecting.
  contextLength = Math.min(contextLength, 1000000);
  if (errs.length) return { ok: false, errors: errs };
  // Cascade role (optional): 'router' (fast stage-1 model) or 'primary'
  // (heavy stage-2 model); anything else is treated as unset. Roles are
  // re-resolved per request (services/cascade.js), so edits apply instantly.
  const role = typeof b.role === 'string' ? b.role.trim().toLowerCase() : '';
  // Launch template (optional): a template id from services/templateStore;
  // '' = unset (the built-in default applies when the lifecycle manager
  // generates a launch unit for a model that has no unit yet).
  const templateId = String(b.templateId || '').trim();
  if (templateId && !templateStore.get(templateId)) {
    errs.push(`launch template not found: ${templateId}`);
  }
  if (errs.length) return { ok: false, errors: errs };
  return {
    ok: true,
    id: b.id,
    name: String(b.name).trim(),
    provider: detectProvider(b.endpoint, b.provider),
    endpoint: String(b.endpoint).trim().replace(/\/+$/, ''),
    model: String(model).trim(),
    contextLength,
    role: role === 'router' || role === 'primary' ? role : '',
    templateId,
  };
}

// ---------------------------------------------------------------- live status
/** OpenAI-compatible liveness path, mirroring llamaClient.chatCompletionsUrl
 * normalization: strip a trailing /chat/completions, add /v1 when missing,
 * then /models. OpenRouter and friends answer GET /v1/models with the bearer
 * token; a llama.cpp /health ping against them returns 404 and looks "offline". */
function probeUrlFor(endpoint) {
  const base = String(endpoint || '')
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/i, '');
  return /\/v1$/i.test(base) ? `${base}/models` : `${base}/v1/models`;
}

/**
 * Best-effort liveness check.
 * - Loopback (local llama.cpp): GET /health, 2xx/3xx = online (llama.cpp
 *   reports 200 only when a model is loaded).
 * - Remote (OpenRouter etc.): GET the OpenAI-compatible /models endpoint with
 *   the model's resolved bearer token. Any HTTP answer (2xx, and 401/403 when
 *   the server is up but the key is rejected) counts as reachable/online;
 *   404 = wrong base URL, other 4xx/5xx = offline, transport errors
 *   distinguish 'unreachable' / 'timeout'.
 */
function probeStatus(endpoint, apiKey) {
  return new Promise((resolve) => {
    const remote = !isLoopback(endpoint);
    const client = /^https:/i.test(endpoint) ? https : http;
    const url = remote ? probeUrlFor(endpoint) : `${endpoint}/health`;
    const opts = { timeout: remote ? 3000 : 1500 };
    if (remote && apiKey) opts.headers = { Authorization: `Bearer ${apiKey}` };
    let req;
    try {
      req = client.get(url, opts, (res) => {
        res.resume();
        const code = res.statusCode || 0;
        if (remote) {
          resolve(code >= 200 && code < 300 ? 'online' : code === 401 || code === 403 ? 'online' : 'offline');
        } else {
          resolve(code >= 200 && code < 400 ? 'online' : 'offline');
        }
      });
    } catch {
      return resolve('unreachable');
    }
    req.on('timeout', () => { req.destroy(); resolve('timeout'); });
    req.on('error', () => resolve('unreachable'));
  });
}

/**
 * Best-effort live context window for local llama.cpp servers.
 * GET <endpoint>/props and read default_generation_settings.n_ctx so the
 * panel reflects the server's actual runtime context instead of the static
 * state-file value (which goes stale whenever llama-server flags change).
 * Remote endpoints keep their configured contextLength — /props is a
 * llama.cpp-only endpoint. Resolves to null on any failure so callers
 * fall back to the stored value.
 */
function probeContextLength(endpoint) {
  return new Promise((resolve) => {
    if (!isLoopback(endpoint)) return resolve(null);
    const client = /^https:/i.test(endpoint) ? https : http;
    const url = `${endpoint.replace(/\/+$/, '')}/props`;
    const opts = { timeout: 1500 };
    let req;
    try {
      req = client.get(url, opts, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) return resolve(null);
          try {
            const n = JSON.parse(body).default_generation_settings?.n_ctx;
            resolve(Number.isFinite(n) && n > 0 ? n : null);
          } catch {
            resolve(null);
          }
        });
      });
    } catch {
      return resolve(null);
    }
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

// --------------------------------------------------- served-model identity
// Several registry entries may share one loopback port (e.g. many .gguf
// entries pointing at 8081). A port answering /health proves ONLY that SOME
// llama-server is up — not that it serves the model being asked about. These
// helpers resolve/serialize the identity of whatever the endpoint currently
// serves (/v1/models alias ids — llama.cpp --alias values — plus /props
// model_path) and match it against a registry entry, so status/load/eject are
// scoped to the SPECIFIC model instance.

const IDENTITY_CACHE_TTL_MS = 1500;

function getJsonText(url) {
  return new Promise((resolve) => {
    const client = /^https:/i.test(url) ? https : http;
    const opts = { timeout: 1500 };
    let req;
    try {
      req = client.get(url, opts, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve(body));
      });
    } catch {
      return resolve('');
    }
    req.on('timeout', () => { req.destroy(); resolve(''); });
    req.on('error', () => resolve(''));
  });
}

/**
 * Pure parse of /v1/models + /props bodies into { reachable, ids, modelPath }.
 * ids: alias ids from /v1/models (router servers list several;
 * `/props.result` carries the same info in some builds). modelPath: the
 * absolute path from /props (single-model servers).
 */
function parseServedIdentity(modelsBody, propsBody) {
  const idn = { reachable: false, ids: [], modelPath: null };
  try {
    const parsed = JSON.parse(modelsBody || '{}');
    if (Array.isArray(parsed.data)) {
      idn.ids = parsed.data.map((d) => (d && typeof d.id === 'string' ? d.id : '')).filter(Boolean);
      idn.reachable = true;
    }
  } catch { /* unparseable /v1/models */ }
  try {
    const p = JSON.parse(propsBody || '{}');
    if (typeof p.model_path === 'string') {
      idn.modelPath = p.model_path;
      idn.reachable = true;
    } else if (Array.isArray(p.result)) {
      const ids = p.result
        .map((x) => (x && (typeof x.id === 'string' || typeof x.model === 'string') ? String(x.id || x.model) : ''))
        .filter(Boolean);
      if (ids.length) {
        for (const id of ids) if (!idn.ids.includes(id)) idn.ids.push(id);
        idn.reachable = true;
      }
    }
  } catch { /* no /props */ }
  return idn;
}

function fetchServedIdentity(endpoint) {
  if (!isLoopback(endpoint)) return Promise.resolve({ reachable: false, ids: [], modelPath: null });
  const base = String(endpoint).replace(/\/+$/, '');
  return Promise.all([getJsonText(`${base}/v1/models`), getJsonText(`${base}/props`)]).then(([m, p]) =>
    parseServedIdentity(m, p)
  );
}

const servedIdentityCache = new Map(); // endpoint -> { at, promise }

/**
 * Identity of whatever the endpoint currently serves, cached ~1.5s across
 * callers so a status sweep over N entries sharing one port performs ONE
 * fetch pair per endpoint instead of N.
 */
function servedIdentityFor(endpoint) {
  const hit = servedIdentityCache.get(endpoint);
  if (hit && Date.now() - hit.at < IDENTITY_CACHE_TTL_MS) return hit.promise;
  const promise = fetchServedIdentity(endpoint);
  servedIdentityCache.set(endpoint, { at: Date.now(), promise });
  return promise;
}

/** Identity keys for a registry entry: model file name, id, modelId. */
function identityKeys(m) {
  return [String((m && (m.model || m.modelId)) || ''), String((m && m.id) || ''), String((m && m.modelId) || '')]
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Does the endpoint ACTUALLY serve this registry entry? Matches /v1/models
 * alias ids (with --alias <model-file> the id IS the gguf name) and the
 * /props model_path basename (hand-run servers without --alias report the
 * absolute path, whose basename equals the gguf file). false when the served
 * identity is unknown (ids list empty) — callers decide how to treat that.
 */
function endpointServes(m, idn) {
  if (!m || !idn) return false;
  const keys = identityKeys(m);
  if (idn.ids.some((id) => keys.some((k) => k === id || id.endsWith('/' + k)))) return true;
  if (typeof idn.modelPath === 'string' && idn.modelPath !== '') {
    const base = idn.modelPath.split('/').pop() || '';
    if (keys.some((k) => k === base || k.endsWith(base) || base.endsWith(k))) return true;
  }
  return false;
}

// ---------------------------------------------------------------- public API
/** All models with active flag and live status. */
async function listModels() {
  const state = loadState();
  const withStatus = await Promise.all(
    state.models.map(async (m) => {
      const pub = publicModel(m);
      pub.active = m.id === state.activeId;
      const [liveStatus0, liveCtx] = await Promise.all([
        probeStatus(m.endpoint, resolveApiKey(m.id)),
        probeContextLength(m.endpoint),
      ]);
      // Port-sharing guard: several registry entries may share one endpoint.
      // /health says "a server is up" — verify it serves THIS model before
      // reporting online; a foreign occupant gets status 'conflict' (the UI
      // shows Load, not Eject, for anything but 'online').
      let liveStatus = liveStatus0;
      if (liveStatus0 === 'online' && isLoopback(m.endpoint)) {
        const idn = await servedIdentityFor(m.endpoint);
        if (idn.ids.length > 0 && !endpointServes(m, idn)) liveStatus = 'conflict';
      }
      pub.status = liveStatus;
      // Live context wins for local llama.cpp servers; static value is the fallback.
      if (liveCtx) pub.contextLength = liveCtx;
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

/** Get one model by id (with optional resolved apiKey for internal callers). */
function getModel(id, opts) {
  const state = loadState();
  const m = state.models.find((x) => x.id === id);
  return m ? publicModel(m, opts) : null;
}

/** Raw registry snapshot ({ activeId, models }) — role/cascade consumers. */
function getState() {
  return loadState();
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
    role: v.role,
    templateId: v.templateId,
  };
  // First model becomes active by default.
  if (state.models.length === 0) state.activeId = v.id;
  state.models.push(entry);
  // Assigning a role here steals it from any other current holder — the
  // cascade pair stays unique even when roles are set via the model editor.
  clearDuplicateRoles(state, entry);
  saveState(state);
  // A key from the dashboard goes to .env (gitignored) — never into the
  // registry, which stays plaintext-secret-free by construction.
  if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
    writeDotEnvVar(envVarForModel(v.id), body.apiKey.trim());
  }
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
  if (patch.role === undefined) patch.role = existing.role;
  if (patch.templateId === undefined) patch.templateId = existing.templateId;
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
    role: v.role,
    templateId: v.templateId,
  };
  // apiKey semantics: a non-blank value updates the per-model var in .env; an
  // explicit blank/null clears it. Omitting apiKey leaves the stored var
  // untouched. The registry NEVER carries the key itself.
  if (body.apiKey !== undefined) {
    if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
      writeDotEnvVar(envVarForModel(targetId), body.apiKey.trim());
    } else {
      writeDotEnvVar(envVarForModel(targetId), null);
    }
  }

  state.models[idx] = entry;
  // Role exclusivity (see clearDuplicateRoles): saving a model with role
  // 'router'/'primary' clears that role from whatever model held it before.
  clearDuplicateRoles(state, entry);
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
  // Drop the model's dedicated .env variable so deleting a model cleans up
  // its secret too.
  writeDotEnvVar(envVarForModel(id), null);
  return { ok: true, deleted: true, active: state.activeId };
}

// ---------------------------------------------------------------- cascade roles
/**
 * Enforce cascade-role uniqueness: when `keep` carries a cascade role
 * ('router'|'primary'), strip that SAME role from every other entry. Called
 * on every create/update and by setCascadeRoles(), so the registry can never
 * hold two routers or two primaries (resolveFrom() would silently pick the
 * first). Returns true when something changed.
 */
function clearDuplicateRoles(state, keep) {
  const role = keep && keep.role;
  if (role !== 'router' && role !== 'primary') return false;
  let changed = false;
  for (const m of state.models) {
    if (m !== keep && m.role === role) {
      m.role = '';
      changed = true;
    }
  }
  return changed;
}

/**
 * Atomically assign the two-stage cascade pair: `routerId` becomes role
 * 'router', `primaryId` becomes role 'primary'; every other model's role is
 * cleared. Either id may be null/'' to unset that stage (both empty clears
 * the whole cascade). The ids must exist and must be two different models.
 * Saves once. Roles are re-read from disk on every request (cascade.resolve
 * in services/cascade.js), so chat routing switches to the new pair
 * instantly — no restart.
 */
function setCascadeRoles(routerId, primaryId) {
  const state = loadState();
  const byId = (id) => {
    const key = id !== null && id !== undefined ? String(id) : '';
    return key ? state.models.find((m) => m.id === key) || null : null;
  };
  const router = byId(routerId);
  const primary = byId(primaryId);
  if (routerId && !router) return { ok: false, error: `model not found: ${routerId}` };
  if (primaryId && !primary) return { ok: false, error: `model not found: ${primaryId}` };
  if (router && primary && router.id === primary.id) {
    return { ok: false, error: 'router and primary must be two different models' };
  }
  let changed = false;
  for (const m of state.models) {
    if (m.role) { m.role = ''; changed = true; }
  }
  if (router) { router.role = 'router'; changed = true; }
  if (primary) { primary.role = 'primary'; changed = true; }
  // Assigning a cascade pair ACTIVATES the primary: the resolver only runs
  // the two-stage cascade while the selected model IS the configured primary,
  // so pair assignment must select it too — otherwise the panel's "assign
  // pair" would silently leave the system in single-model mode.
  if (primary) state.activeId = primary.id;
  if (changed) saveState(state);
  const share = (m) => (m ? { id: m.id, name: m.name, role: m.role } : null);
  return { ok: true, router: share(router), primary: share(primary), activeId: primary ? primary.id : null };
}

module.exports = {
  STATE_FILE,
  DOTENV_FILE,
  listModels,
  getActiveModel,
  getModel,
  getState,
  setActive,
  createModel,
  updateModel,
  deleteModel,
  setCascadeRoles,
  clearDuplicateRoles,
  resolveApiKey,
  writeDotEnvVar,
  envVarForModel,
  probeStatus,
  probeUrlFor,
  detectProvider,
  categoryFor,
  // served-model identity (port-sharing guard)
  parseServedIdentity,
  fetchServedIdentity,
  servedIdentityFor,
  endpointServes,
  identityKeys,
  _identityCache: servedIdentityCache,
};
