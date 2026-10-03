/**
 * skillManager — workspace skill registry.
 *
 * Skills live as folders under <workRoot>/skills/<name>/. Each skill has:
 *   - SKILL.md     : metadata (YAML frontmatter: name/version/description/entry)
 *                    + the skill's instructions/details in the Markdown body.
 *   - <entry>      : an executable Node script (default run.js)
 *   - any extra files the skill needs (authored via the agent / API)
 *
 * Legacy `skill.json` skills are still readable and are auto-migrated to
 * SKILL.md on first load, so old workspace skills keep working with zero manual
 * changes.
 *
 * This service scans/loads skills, persists their enabled/disabled state in
 * <dataDir>/skills-state.json (kept separate from the authored metadata so
 * toggling never rewrites user content), creates/updates/deletes skills, and
 * executes a skill's entry script in a bounded subprocess.
 *
 * Path safety: skill names must be a plain slug and every file we touch is
 * resolved strictly inside the skill's own folder — nothing can escape the
 * workspace or a skill's directory.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const config = require('../config');

const SKILLS_ROOT = path.resolve(config.workRoot, 'skills');
const STATE_FILE = path.join(config.dataDir, 'skills-state.json');
const META_FILE = 'SKILL.md';
const LEGACY_FILE = 'skill.json';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ENTRY_RE = /^[A-Za-z0-9._-]+$/;
const DEFAULT_ENTRY = 'run.js';

// ---------------------------------------------------------------- state store
function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const o = JSON.parse(raw);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}
function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

// A skill is enabled unless explicitly disabled in the state store.
function isEnabled(name, state) {
  return state[name] !== false;
}

// ---------------------------------------------------------------- helpers
function ensureRoot() {
  fs.mkdirSync(SKILLS_ROOT, { recursive: true });
}
function skillDir(name) {
  return path.join(SKILLS_ROOT, name);
}
function safeName(name) {
  return typeof name === 'string' && NAME_RE.test(name) && name !== '.' && name !== '..';
}
function safeEntry(entry) {
  return typeof entry === 'string' && ENTRY_RE.test(entry);
}

// Strips surrounding quotes and trims a scalar YAML-ish value.
function parseScalar(v) {
  let s = String(v == null ? '' : v).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  return s;
}

/**
 * Parse a SKILL.md document: leading YAML frontmatter (between `---` fences) is
 * metadata; the remainder is the body (instructions). Returns
 * { meta: {name,version,description,entry,...}, body }. Missing frontmatter is
 * tolerated (empty meta, whole doc is the body).
 */
function parseSkillMd(content) {
  const m = String(content).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: String(content || '').trim() };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const val = parseScalar(line.slice(idx + 1));
    if (key) meta[key] = val;
  }
  return { meta, body: (m[2] || '').trim() };
}

/** Serialize a {name,version,description,entry} object into a SKILL.md doc. */
function buildSkillMd(meta, body = '') {
  const lines = ['---'];
  if (meta.name) lines.push(`name: ${meta.name}`);
  if (meta.version) lines.push(`version: ${meta.version}`);
  lines.push(`description: ${meta.description || ''}`);
  lines.push(`entry: ${meta.entry || DEFAULT_ENTRY}`);
  lines.push('---');
  const trimmed = String(body || '').trim();
  if (trimmed) lines.push('', trimmed);
  return lines.join('\n') + '\n';
}

/** True if `p` is a regular file (never throws). */
function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/** True if a skill folder carries metadata (SKILL.md or a legacy skill.json). */
function hasSkillMeta(dir) {
  return isFile(path.join(dir, META_FILE)) || isFile(path.join(dir, LEGACY_FILE));
}

/** List names of installed skills (folders carrying skill metadata). */
function installedNames() {
  ensureRoot();
  let names;
  try {
    names = fs.readdirSync(SKILLS_ROOT, { withFileTypes: true });
  } catch {
    return [];
  }
  return names
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((n) => hasSkillMeta(path.join(SKILLS_ROOT, n)))
    .sort();
}

/** A lightweight file count/size summary for a skill folder. */
function folderStats(dir) {
  let files = 0;
  let bytes = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return { files, bytes }; }
  for (const e of entries) {
    if (e.isDirectory()) continue;
    files++;
    try { bytes += fs.statSync(path.join(dir, e.name)).size; } catch { /* ignore */ }
  }
  return { files, bytes };
}

/**
 * Read a skill's metadata, preferring SKILL.md. A legacy skill.json (with no
 * SKILL.md present) is migrated in place: its metadata is written as a new
 * SKILL.md and the old file is removed. Returns a plain metadata object or null.
 */
function readMeta(dir) {
  const mdPath = path.join(dir, META_FILE);
  try {
    if (fs.statSync(mdPath).isFile()) {
      const { meta, body } = parseSkillMd(fs.readFileSync(mdPath, 'utf8'));
      return { name: meta.name || path.basename(dir), version: meta.version, description: meta.description, entry: meta.entry, body };
    }
  } catch { /* fall through to legacy */ }

  // Legacy skill.json → migrate.
  try {
    const legacy = JSON.parse(fs.readFileSync(path.join(dir, LEGACY_FILE), 'utf8'));
    if (!legacy || typeof legacy !== 'object') return null;
    const meta = {
      name: legacy.name || path.basename(dir),
      version: legacy.version,
      description: legacy.description,
      entry: legacy.entry,
    };
    const body =
      (typeof legacy.description === 'string' && legacy.description.trim())
        ? `# Instructions\n\n${legacy.description}\n`
        : '# Instructions\nFirst line of the skill body.\n';
    fs.writeFileSync(mdPath, buildSkillMd(meta, body), 'utf8');
    try { fs.unlinkSync(path.join(dir, LEGACY_FILE)); } catch { /* non-fatal */ }
    return { name: meta.name, version: meta.version, description: meta.description, entry: meta.entry, body };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- public API
/** All installed skills with their metadata, enabled state and stats. */
function listSkills() {
  const state = loadState();
  return installedNames().map((name) => {
    const meta = readMeta(skillDir(name)) || {};
    return {
      name,
      version: meta.version || '1.0.0',
      description: meta.description || '',
      entry: meta.entry || DEFAULT_ENTRY,
      enabled: isEnabled(name, state),
      path: name,
      ...folderStats(skillDir(name)),
    };
  });
}

/** Load a single skill (full object + body) or null if missing/name-less. */
function loadSkill(name) {
  if (!safeName(name)) return null;
  ensureRoot();
  const meta = readMeta(skillDir(name));
  if (!meta) return null;
  const state = loadState();
  return {
    name,
    version: meta.version || '1.0.0',
    description: meta.description || '',
    entry: meta.entry || DEFAULT_ENTRY,
    enabled: isEnabled(name, state),
    path: name,
    body: meta.body || '',
    ...folderStats(skillDir(name)),
  };
}

/** Enable/disable a skill; persists the state. Unknown name → error. */
function setEnabled(name, enabled) {
  if (!safeName(name)) return { ok: false, error: 'invalid skill name' };
  if (!loadSkill(name)) return { ok: false, error: `skill not found: ${name}` };
  const state = loadState();
  if (enabled) delete state[name];
  else state[name] = false;
  saveState(state);
  return { ok: true, name, enabled: isEnabled(name, state) };
}

/**
 * Create or update a skill.
 * body: { name, description?, version?, entry?, instructions?, files? }
 *   - instructions: Markdown body for SKILL.md (also accepts `body` as an alias).
 *   - files: an object mapping a flat filename → content (e.g. { "run.js": "..." }).
 * SKILL.md / skill.json are managed files and cannot be supplied via `files`.
 * Metadata is written to SKILL.md frontmatter; provided files are (over)written.
 */
function writeSkill(body) {
  const name = body && body.name;
  if (!safeName(name)) return { ok: false, error: 'invalid skill name (use letters, digits, dots, dashes, underscores)' };
  const entry = safeEntry(body.entry) ? body.entry : DEFAULT_ENTRY;
  const instructions = typeof body.instructions === 'string'
    ? body.instructions
    : typeof body.body === 'string' ? body.body : '';

  ensureRoot();
  const dir = skillDir(name);
  fs.mkdirSync(dir, { recursive: true });

  const version =
    typeof body.version === 'string' && body.version
      ? body.version
      : readMeta(dir)?.version || '1.0.0';
  const meta = {
    name,
    version,
    description: typeof body.description === 'string' ? body.description : '',
    entry,
  };
  fs.writeFileSync(path.join(dir, META_FILE), buildSkillMd(meta, instructions), 'utf8');
  // Managed metadata files must not be clobbered through the free-form files map.
  try { fs.unlinkSync(path.join(dir, LEGACY_FILE)); } catch { /* none */ }

  const files = body && typeof body.files === 'object' && body.files ? body.files : {};
  for (const [fname, content] of Object.entries(files)) {
    if (!safeEntry(fname) || fname === META_FILE || fname === LEGACY_FILE) {
      return { ok: false, error: `invalid or managed file name: ${fname}` };
    }
    fs.writeFileSync(path.join(dir, fname), String(content), 'utf8');
  }

  return { ok: true, skill: loadSkill(name) };
}

/** Permanently delete a skill folder. */
function deleteSkill(name) {
  if (!safeName(name)) return { ok: false, error: 'invalid skill name' };
  ensureRoot();
  const dir = skillDir(name);
  if (!fs.existsSync(dir)) return { ok: true, deleted: false, error: `skill not found: ${name}` };
  // Only remove if it is a real skills/<name> entry, never the root.
  if (path.dirname(dir) !== SKILLS_ROOT) {
    return { ok: false, error: 'refusing to remove outside skills root' };
  }
  fs.rmSync(dir, { recursive: true, force: true });
  const state = loadState();
  delete state[name];
  saveState(state);
  return { ok: true, deleted: true, name };
}

/**
 * Execute a skill's entry script in a bounded child process.
 * args: string[] passed to the script; opts: { timeoutMs }.
 */
function runSkill(name, args = [], opts = {}) {
  return new Promise((resolve) => {
    const skill = loadSkill(name);
    if (!skill) return resolve({ ok: false, error: `skill not found: ${name}` });
    if (!safeEntry(skill.entry)) return resolve({ ok: false, error: `invalid entry file: ${skill.entry}` });

    const dir = skillDir(name);
    const entry = path.join(dir, skill.entry);
    const timeoutMs = Number(opts && opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 20000;
    const argv = Array.isArray(args) ? args.map(String) : [];

    let child;
    try {
      child = spawn(process.execPath, [entry, ...argv], { cwd: dir });
    } catch (e) {
      return resolve({ ok: false, error: e && e.message ? e.message : String(e) });
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => resolve({ ok: false, error: e.message }));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: true, code, stdout, stderr, timedOut });
    });
  });
}

// Reliably non-throwing scans are the norm here; loadSkill/listSkills never throw.
module.exports = {
  SKILLS_ROOT,
  listSkills,
  loadSkill,
  setEnabled,
  writeSkill,
  deleteSkill,
  runSkill,
};
