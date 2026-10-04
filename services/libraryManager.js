/**
 * services/libraryManager.js — persistent file library storage.
 *
 * Uploaded files live in config.libraryDir (data/library/) as opaque blobs
 * named <uuid>; every entry's metadata (original name, mime, size,
 * description, timestamps) is tracked in data/library-index.json so the
 * original filename survives regardless of the stored blob name. data/* is
 * gitignored (except models-state.json), so the library is runtime state and
 * never gets committed.
 *
 * The index is the source of truth; a missing blob is reported as such by the
 * read/download paths instead of being silently recreated.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

const LIB_DIR = config.libraryDir;
const INDEX_FILE = path.join(config.dataDir, 'library-index.json');

// Extensions treated as text even when the upload had no/generic mime.
const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'json', 'js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx',
  'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'hpp', 'cpp', 'cs', 'php',
  'sh', 'bash', 'zsh', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env',
  'csv', 'tsv', 'log', 'html', 'htm', 'css', 'scss', 'sass', 'less', 'xml',
  'sql', 'svg', 'r', 'lua', 'pl', 'vue', 'svelte', 'dockerfile', 'gitignore',
]);

const CHUNK_PROBE = 8192; // bytes probed for NUL-byte binary detection

function ensureDir() {
  fs.mkdirSync(LIB_DIR, { recursive: true });
}

function loadIndex() {
  try {
    const j = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    return Array.isArray(j.files) ? j.files : [];
  } catch {
    return [];
  }
}

function saveIndex(files) {
  ensureDir();
  const tmp = INDEX_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ files }, null, 2), 'utf8');
  fs.renameSync(tmp, INDEX_FILE);
}

/** Normalize an uploaded filename: strip paths/control chars, cap length. */
function sanitizeName(name) {
  let n = String(name || '')
    .replace(/[\\/]/g, '_')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  if (!n) n = 'file';
  if (n.length > 200) n = n.slice(0, 200);
  return n;
}

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

/** Small extension→mime map; falls back to the provided mime or octet-stream. */
function mimeOf(name, fallback) {
  const M = {
    txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown',
    json: 'application/json', js: 'application/javascript', mjs: 'application/javascript',
    cjs: 'application/javascript', ts: 'text/plain', jsx: 'text/plain', tsx: 'text/plain',
    py: 'text/x-python', rb: 'text/x-ruby', go: 'text/plain', rs: 'text/plain',
    java: 'text/x-java', c: 'text/x-c', h: 'text/x-c', hpp: 'text/x-c', cpp: 'text/x-c',
    cs: 'text/plain', php: 'text/x-php', sh: 'application/x-sh', bash: 'application/x-sh',
    zsh: 'text/plain', yml: 'text/yaml', yaml: 'text/yaml', toml: 'text/plain',
    ini: 'text/plain', cfg: 'text/plain', conf: 'text/plain', env: 'text/plain',
    csv: 'text/csv', tsv: 'text/tab-separated-values', log: 'text/plain',
    html: 'text/html', htm: 'text/html', css: 'text/css', xml: 'text/xml',
    sql: 'application/sql', svg: 'image/svg+xml', r: 'text/plain', lua: 'text/plain',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', ico: 'image/x-icon', bmp: 'image/bmp',
    pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip',
    tar: 'application/x-tar', mp3: 'audio/mpeg', wav: 'audio/wav', mp4: 'video/mp4',
    webm: 'video/webm',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint',
  };
  return M[extOf(name)] || fallback || 'application/octet-stream';
}

/** All entries, newest-updated first. */
function list() {
  return loadIndex().sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

function get(id) {
  if (!id || typeof id !== 'string') return null;
  return loadIndex().find((f) => f.id === id) || null;
}

/** Resolve by exact (case-insensitive) name — used by the agent tool. */
function getByName(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return null;
  return loadIndex().find((f) => f.name.toLowerCase() === n) || null;
}

function blobPath(id) {
  return path.join(LIB_DIR, String(id));
}

/** Store a new uploaded file. Returns { ok, file } with the created entry. */
function save({ name, mime, description, buffer }) {
  if (!Buffer.isBuffer(buffer)) return { ok: false, error: 'no file data received' };
  ensureDir();
  const clean = sanitizeName(name);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const entry = {
    id,
    name: clean,
    mime: mimeOf(clean, typeof mime === 'string' && mime ? mime : 'application/octet-stream'),
    size: buffer.length,
    description: typeof description === 'string' ? description.trim().slice(0, 500) : '',
    createdAt: now,
    updatedAt: now,
  };
  fs.writeFileSync(blobPath(id), buffer);
  const files = loadIndex();
  files.push(entry);
  saveIndex(files);
  return { ok: true, file: entry };
}

/** Update metadata (name / description) of an existing entry. */
function update(id, { name, description } = {}) {
  const files = loadIndex();
  const entry = files.find((f) => f.id === id);
  if (!entry) return { ok: false, error: 'file not found' };
  if (typeof name === 'string' && name.trim()) {
    entry.name = sanitizeName(name);
    entry.mime = mimeOf(entry.name, entry.mime);
  }
  if (typeof description === 'string') entry.description = description.trim().slice(0, 500);
  entry.updatedAt = new Date().toISOString();
  saveIndex(files);
  return { ok: true, file: entry };
}

/** Delete an entry + its blob. Returns { ok, file } with the removed entry. */
function remove(id) {
  const files = loadIndex();
  const idx = files.findIndex((f) => f.id === id);
  if (idx === -1) return { ok: false, error: 'file not found' };
  const [entry] = files.splice(idx, 1);
  try { fs.unlinkSync(blobPath(id)); } catch { /* blob already gone — index wins */ }
  saveIndex(files);
  return { ok: true, file: entry };
}

/**
 * Heuristic text/binary detection: mime text/*, a known text extension, or a
 * probe of the first bytes for NUL characters (strong binary signal).
 */
function isProbablyText(entry) {
  if (!entry) return false;
  const mime = String(entry.mime || '');
  if (mime.startsWith('text/') || TEXT_EXTS.has(extOf(entry.name))) return true;
  try {
    const probe = Buffer.alloc(Math.min(CHUNK_PROBE, Number(entry.size) || 0));
    const fd = fs.openSync(blobPath(entry.id), 'r');
    let n = 0;
    try { n = fs.readSync(fd, probe, 0, probe.length, 0); } finally { fs.closeSync(fd); }
    return !probe.subarray(0, n).includes(0);
  } catch {
    return false;
  }
}

/**
 * Read a library file as text (utf8). Returns { ok, entry, text, truncated }
 * or { ok:false, entry, error } (missing blob or binary content).
 */
function readText(id, maxChars) {
  const entry = get(id);
  if (!entry) return { ok: false, error: 'file not found' };
  if (!isProbablyText(entry)) {
    return {
      ok: false,
      entry,
      reason: 'binary',
      error: `binary file (${entry.mime}, ${entry.size} bytes) — cannot render as text`,
    };
  }
  try {
    let text = fs.readFileSync(blobPath(entry.id), 'utf8');
    const truncated = text.length > maxChars;
    if (truncated) text = text.slice(0, maxChars);
    return { ok: true, entry, text, truncated };
  } catch (e) {
    return { ok: false, entry, error: e && e.message ? e.message : String(e) };
  }
}

module.exports = {
  LIB_DIR,
  TEXT_EXTS,
  sanitizeName,
  mimeOf,
  isProbablyText,
  list,
  get,
  getByName,
  save,
  update,
  remove,
  blobPath,
  readText,
};