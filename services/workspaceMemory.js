'use strict';
/**
 * WorkSPACE memory store — MEMORY.md inside config.workRoot.
 *
 * Project facts / architectural decisions / conventions injected into every
 * request while the file exists. The path is FIXED (config.workspaceMemoryFile,
 * env-overridable for tests) — no user-supplied path, so there is no
 * traversal surface; the sandbox is the path itself.
 *
 * Caps (config.memoryFileMaxChars, default 48 KiB): the file rides inside
 * EVERY prompt, so size limits are enforced at write/append time (a file
 * that grew past the cap is still READ but flagged oversized), and reads
 * are capped too.
 */

const fs = require('fs');
const config = require('../config');

const FILE = config.workspaceMemoryFile;

function readRaw() {
  try {
    return fs.readFileSync(FILE, 'utf8');
  } catch {
    return null; // missing or unreadable — treated as absent
  }
}

/** { ok, exists, bytes, content, truncated } — content capped for prompts. */
function readMemory() {
  const raw = readRaw();
  if (raw === null) return { ok: true, exists: false, bytes: 0, content: '', truncated: false };
  const cap = config.memoryFileMaxChars;
  const truncated = raw.length > cap;
  return {
    ok: true,
    exists: true,
    bytes: Buffer.byteLength(raw, 'utf8'),
    content: truncated ? raw.slice(0, cap) : raw,
    truncated,
    oversized: truncated,
  };
}

/** { ok, bytes, saved, truncated? } — write (overwrite). Rejects > cap. */
function writeMemory(content) {
  const text = content == null ? '' : String(content);
  if (text.length > config.memoryFileMaxChars) {
    return {
      ok: false,
      error: `MEMORY.md too large (${text.length} chars, max ${config.memoryFileMaxChars}) — it is injected into every request`,
    };
  }
  fs.mkdirSync(require('path').dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, text, 'utf8');
  return { ok: true, bytes: Buffer.byteLength(text, 'utf8'), saved: true };
}

/** { ok, bytes } — append; the result must stay within the cap. */
function appendMemory(content) {
  const text = content == null ? '' : String(content);
  if (text.length === 0) return { ok: false, error: 'content is required to append' };
  const existing = readRaw() || '';
  const next = existing.length ? existing.replace(/\s*$/, '') + '\n' + text : text;
  if (next.length > config.memoryFileMaxChars) {
    return {
      ok: false,
      error: `append would exceed the ${config.memoryFileMaxChars}-char MEMORY.md cap`,
    };
  }
  fs.mkdirSync(require('path').dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, next, 'utf8');
  return { ok: true, bytes: Buffer.byteLength(next, 'utf8') };
}

/** Remove the file entirely (action:clear from the UI/tool). */
function clearMemory() {
  try {
    fs.unlinkSync(FILE);
  } catch {
    /* already absent */
  }
  return { ok: true, cleared: true };
}

module.exports = { readMemory, writeMemory, appendMemory, clearMemory, FILE };