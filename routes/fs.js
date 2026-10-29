/**
 * Filesystem API for the dashboard's File Explorer view.
 *
 * Thin JSON wrappers around the sandboxed file tools in tools/fileTools.js so
 * the header can browse/list, read, edit and save files without going through
 * the agentic chat loop. Paths are workspace-relative and validated by
 * resolveWithin() (nothing can escape config.workRoot).
 *
 * Endpoints:
 *   GET  /api/fs/list               ->  { ok, path, count, entries, root }
 *   GET  /api/fs/read?path=<rel>    ->  { ok, path, bytes, content } (WHOLE file)
 *   GET  /api/fs/read?path=<rel>&full=1 -> same whole-file read (compat no-op)
 *   POST /api/fs/write              ->  { path, content } -> { ok, path, bytes, saved }
 *   POST /api/fs/patch              ->  { path, old_text, new_text, replace_all? }
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { tools, ROOT, resolveWithin } = require('../tools/fileTools');

const byName = (n) => tools.find((t) => t.name === n);
const listFilesTool = byName('list_files');
const writeFileTool = byName('write_file');
const editFileTool = byName('edit_file');

const router = express.Router();

// GET /api/fs/list?path=<rel-dir>  ->  { ok, path, count, entries, root }
router.get('/list', (req, res) => {
  const p = typeof req.query.path === 'string' && req.query.path !== '' ? req.query.path : undefined;
  const result = listFilesTool.execute({ path: p });
  if (!result.ok) return res.status(400).json(result);
  // Expose the sandbox root so the UI can render a breadcrumb/label for it.
  res.json({ ...result, root: ROOT });
});

// GET /api/fs/read?path=<rel-file>[&full=1]  ->  { ok, path, bytes, content }
// Since 2026-10-29 the plain view and the editor BOTH return the whole file
// (no preview truncation marker — the agentic read_file cap + offset/limit
// still protect the chat context, but the dashboard reads directly from
// disk). The only bound is config.fsReadFullMaxChars so absurdly large
// files refuse loudly (413) instead of choking the tab. `full=1` is kept as
// a compatibility no-op for the editor's existing fetch.
router.get('/read', (req, res) => {
  if (typeof req.query.path !== 'string' || req.query.path === '') {
    return res.status(400).json({ ok: false, error: 'path query param is required' });
  }
  const abs = resolveWithin(req.query.path);
  if (!abs) return res.status(400).json({ ok: false, error: 'path escapes the allowed workspace' });
  let raw;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    return res.status(400).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
  const bytes = Buffer.byteLength(raw);
  if (bytes > config.fsReadFullMaxChars) {
    return res.status(413).json({
      ok: false,
      error: `file is ${bytes} bytes — too large to open in the browser editor (limit ${config.fsReadFullMaxChars} bytes)`,
    });
  }
  return res.json({ ok: true, path: req.query.path, bytes, full: true, content: raw });
});

// POST /api/fs/write  { path, content }  ->  { ok, path, bytes, saved }
// Full-content save from the editor. Sandboxed + size-capped; creating a new
// file (parent dirs auto-created) and overwriting an existing one both work.
router.post('/write', (req, res) => {
  const relPath = req.body && req.body.path;
  const content = req.body && req.body.content;
  if (typeof relPath !== 'string' || relPath.trim() === '') {
    return res.status(400).json({ ok: false, error: 'path is required' });
  }
  if (typeof content !== 'string') {
    return res.status(400).json({ ok: false, error: 'content must be a string' });
  }
  const bytes = Buffer.byteLength(content);
  if (bytes > config.fsWriteMaxChars) {
    return res.status(413).json({
      ok: false,
      error: `file too large: ${bytes} bytes (limit ${config.fsWriteMaxChars} bytes)`,
    });
  }
  const result = writeFileTool.execute({ path: relPath, content });
  if (!result.ok) return res.status(400).json(result);
  res.json({ ...result, saved: true });
});

// POST /api/fs/patch  { path, old_text, new_text, replace_all? }  ->  { ok, path, bytes }
// Targeted in-place edit (companion to the editor's full save). Reuses the
// edit_file tool semantics: exact old_text match, first occurrence replaced
// unless replace_all is set, fails cleanly when old_text is not found.
router.post('/patch', (req, res) => {
  const relPath = req.body && req.body.path;
  const oldText = req.body && req.body.old_text;
  const newText = req.body && req.body.new_text;
  if (typeof relPath !== 'string' || relPath.trim() === '') {
    return res.status(400).json({ ok: false, error: 'path is required' });
  }
  if (typeof oldText !== 'string' || oldText === '') {
    return res.status(400).json({ ok: false, error: 'old_text must be a non-empty string' });
  }
  if (typeof newText !== 'string') {
    return res.status(400).json({ ok: false, error: 'new_text must be a string' });
  }
  const grown = Buffer.byteLength(newText) - Buffer.byteLength(oldText);
  try {
    const abs = resolveWithin(relPath);
    if (!abs) return res.status(400).json({ ok: false, error: 'path escapes the allowed workspace' });
    const currentBytes = Buffer.byteLength(fs.readFileSync(abs, 'utf8'));
    if (currentBytes + Math.max(0, grown) > config.fsWriteMaxChars) {
      return res.status(413).json({
        ok: false,
        error: `resulting file would exceed the ${config.fsWriteMaxChars} byte limit`,
      });
    }
  } catch (e) {
    return res.status(400).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
  const result = editFileTool.execute({
    path: relPath,
    old_text: oldText,
    new_text: newText,
    replace_all: !!(req.body && req.body.replace_all),
  });
  if (!result.ok) return res.status(400).json(result);
  res.json({ ...result, patched: true });
});

module.exports = router;