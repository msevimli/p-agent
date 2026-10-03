/**
 * Filesystem API for the dashboard's File Explorer view.
 *
 * Thin JSON wrappers around the sandboxed file tools in tools/fileTools.js so
 * the header can browse/list and read files without going through the agentic
 * chat loop. Paths are workspace-relative and validated by resolveWithin()
 * (nothing can escape config.workRoot).
 */
const express = require('express');
const { tools, ROOT } = require('../tools/fileTools');

const byName = (n) => tools.find((t) => t.name === n);
const listFilesTool = byName('list_files');
const readFileTool = byName('read_file');

const router = express.Router();

// GET /api/fs/list?path=<rel-dir>  ->  { ok, path, count, entries, root }
router.get('/list', (req, res) => {
  const p = typeof req.query.path === 'string' && req.query.path !== '' ? req.query.path : undefined;
  const result = listFilesTool.execute({ path: p });
  if (!result.ok) return res.status(400).json(result);
  // Expose the sandbox root so the UI can render a breadcrumb/label for it.
  res.json({ ...result, root: ROOT });
});

// GET /api/fs/read?path=<rel-file>  ->  { ok, path, bytes, content }
router.get('/read', (req, res) => {
  if (typeof req.query.path !== 'string' || req.query.path === '') {
    return res.status(400).json({ ok: false, error: 'path query param is required' });
  }
  const result = readFileTool.execute({ path: req.query.path });
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

module.exports = router;
