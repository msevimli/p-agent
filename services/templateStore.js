/**
 * templateStore — llama-server launch-config templates (data/templates-state.json).
 *
 * A template is a named bundle of llama-server CLI args (a token array) that
 * the model lifecycle manager applies when generating a model's systemd user
 * unit at launch (see modelLifecycle.buildUnitFile). Models reference a
 * template via their `templateId` registry field; an unset/unknown id falls
 * back to the built-in default template.
 *
 * The store seeds ONE built-in template on first run ("Default", standard
 * performance flags). Built-in templates are undeletable and keep their id
 * and name, but their args/description stay editable — the dashboard shows
 * the delete button disabled for them.
 *
 * The args stream may contain the placeholder <model-file>, substituted at
 * launch time with the launched model's identifier (its `model` field).
 * Flags that are derived from the registry entry (-m, --port, --host) are
 * rejected at save time; derived flags are appended last at launch, where
 * llama.cpp's last-wins parsing gives them precedence over template args.
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');

const STATE_FILE = path.join(config.dataDir, 'templates-state.json');

// Built-in default: standard performance flags for a CPU llama-server
// (the k/v cache stays f16, --cache-reuse 256 keeps recently shifted
// context hot; -t 6 -tb 2 fits the 8-core host).
const DEFAULT_TEMPLATE = {
  id: 'default',
  name: 'Default',
  builtin: true,
  description: 'Standard performance flags (f16 KV cache, cache reuse 256).',
  args: [
    '--alias', '<model-file>',
    '-fa', '1', '--jinja',
    '-c', '16384', '-np', '1',
    '-b', '512', '-ub', '512',
    '-t', '6', '-tb', '2',
    '--cache-type-k', 'f16', '--cache-type-v', 'f16',
    '--cache-reuse', '256',
  ],
};

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_ARGS = 96;
// Derived at launch from the registry entry — never allowed inside a template.
// Matches any dash form (single/double, with or without =value).
const FORBIDDEN_ARG_RE = /^--?(m|model|model-file|port|host)(=.*)?$/;

// ---------------------------------------------------------------- storage
function loadState() {
  let raw = null;
  try { raw = fs.readFileSync(STATE_FILE, 'utf8'); } catch { /* first run */ }
  let o = {};
  if (raw) {
    try { o = JSON.parse(raw); } catch { o = {}; }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) o = {};
  if (!Array.isArray(o.templates)) o.templates = [];
  // Schema normalization: a legacy string `args` gets tokenized; the built-in
  // default is re-seeded whenever it is missing (it is required by the
  // launcher as the fallback, so it must always exist).
  let dirty = false;
  if (!o.templates.some((t) => t && t.builtin)) {
    o.templates.unshift(JSON.parse(JSON.stringify(DEFAULT_TEMPLATE)));
    dirty = true;
  }
  for (const t of o.templates) {
    if (!t || typeof t !== 'object') continue;
    if (typeof t.args === 'string') {
      t.args = t.args.trim().split(/\s+/).filter(Boolean);
      dirty = true;
    }
  }
  if (dirty) saveState(o);
  return o;
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

/** Public copy — the args are user-authored config, safe to send as-is. */
function publicTemplate(t) {
  return {
    id: t.id,
    name: t.name,
    description: t.description || '',
    builtin: t.builtin === true,
    args: Array.isArray(t.args) ? t.args.slice() : [],
  };
}

/** Parse an args payload (string or token array) into a normalized token list. */
function parseArgs(input) {
  const raw = Array.isArray(input) ? input : [String(input || '')];
  const tokens = [];
  for (const part of raw) {
    for (const tok of String(part).trim().split(/\s+/)) {
      if (tok) tokens.push(tok);
    }
  }
  return tokens;
}

// ---------------------------------------------------------------- validation
function validate(body, existing) {
  const b = body && typeof body === 'object' ? body : {};
  const errs = [];
  const name = String(b.name !== undefined ? b.name : (existing && existing.name) || '').trim();
  if (!name) errs.push('name is required');
  else if (name.length > 60) errs.push('name must be 60 characters or fewer');
  const args = parseArgs(b.args !== undefined ? b.args : (existing && existing.args) || []);
  if (!args.length) errs.push('at least one llama-server flag is required');
  else if (args.length > MAX_ARGS) errs.push(`too many flags (max ${MAX_ARGS}, got ${args.length})`);
  else {
    for (const a of args) {
      if (FORBIDDEN_ARG_RE.test(a)) {
        errs.push(`flag ${a} is not allowed in a template (it is derived from the model entry at launch)`);
        break;
      }
    }
  }
  const description = String(b.description !== undefined ? b.description : (existing && existing.description) || '').trim();
  if (description.length > 200) errs.push('description must be 200 characters or fewer');
  if (errs.length) return { ok: false, errors: errs };
  return { ok: true, name, args, description };
}

// ---------------------------------------------------------------- public API
/** All templates (built-in first). */
function list() {
  const state = loadState();
  const sorted = state.templates
    .filter((t) => t && t.id)
    .sort((a, b) => (a.builtin === b.builtin ? 0 : a.builtin ? -1 : 1));
  return sorted.map(publicTemplate);
}

/** One template by id. */
function get(id) {
  const state = loadState();
  const t = state.templates.find((x) => x && x.id === id);
  return t ? publicTemplate(t) : null;
}

/**
 * Resolve the template to apply for a model launch: the model's assigned id
 * when it exists, else the built-in default. Never returns null — the
 * built-in is guaranteed to exist by loadState().
 */
function resolve(id) {
  const picked = id ? get(String(id)) : null;
  if (picked) return picked;
  const state = loadState();
  const builtin = state.templates.find((t) => t && t.builtin) || DEFAULT_TEMPLATE;
  return publicTemplate(builtin);
}

/** Create a template. `id` optional (defaults to a slug of the name). */
function create(body) {
  const v = validate(body);
  if (!v.ok) return { ok: false, errors: v.errors };
  let id = String(body && body.id || '').trim();
  if (!id) id = v.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'template';
  if (!ID_RE.test(id)) return { ok: false, error: 'invalid id (letters/digits/dot/dash/underscore)' };
  const state = loadState();
  if (state.templates.some((t) => t.id === id)) {
    return { ok: false, error: `template already exists: ${id}` };
  }
  const entry = { id, name: v.name, description: v.description, builtin: false, args: v.args };
  state.templates.push(entry);
  saveState(state);
  return { ok: true, template: publicTemplate(entry) };
}

/** Update a template. Built-ins: args/description only — name and id are
 * locked (the dashboard disables the name input; the server enforces it). */
function update(id, body) {
  const state = loadState();
  const idx = state.templates.findIndex((t) => t && t.id === id);
  if (idx === -1) return { ok: false, error: `template not found: ${id}` };
  const existing = state.templates[idx];
  const v = validate(body, existing);
  if (!v.ok) return { ok: false, errors: v.errors };
  const name = existing.builtin ? existing.name : v.name;
  if (existing.builtin && String(body.name || '').trim() && String(body.name).trim() !== existing.name) {
    return { ok: false, error: 'built-in template name is locked' };
  }
  const entry = { id: existing.id, name, description: v.description, builtin: existing.builtin, args: v.args };
  state.templates[idx] = entry;
  saveState(state);
  return { ok: true, template: publicTemplate(entry) };
}

/** Delete a template. Built-ins are undeletable. */
function remove(id) {
  const state = loadState();
  const idx = state.templates.findIndex((t) => t && t.id === id);
  if (idx === -1) return { ok: true, deleted: false, error: `template not found: ${id}` };
  if (state.templates[idx].builtin) {
    return { ok: false, error: 'the built-in default template cannot be deleted' };
  }
  state.templates.splice(idx, 1);
  saveState(state);
  return { ok: true, deleted: true };
}

module.exports = {
  STATE_FILE,
  DEFAULT_TEMPLATE,
  list,
  get,
  resolve,
  create,
  update,
  remove,
  parseArgs,
};