/**
 * /api/library — persistent file library CRUD.
 *
 *   GET    /api/library             list all stored files (metadata)
 *   POST   /api/library/upload      upload a file (raw byte body; name via
 *                                   ?name= query or X-File-Name header, real
 *                                   mime via X-File-Type header)
 *   GET    /api/library/:id         single file metadata
 *   PUT    /api/library/:id         update name / description
 *   GET    /api/library/:id/content raw file bytes (inline for text/images,
 *                                   attachment otherwise)
 *   DELETE /api/library/:id         remove the file + blob
 *
 * Uploads are streamed as application/octet-stream on purpose: the global
 * express.json middleware only parses application/json bodies, so text-ish
 * uploads (which browsers may label application/json) would otherwise be
 * mis-parsed and rejected. The client passes the real type via X-File-Type.
 *
 * Size cap: config.libraryMaxUploadBytes (default 50 MB) enforced by
 * express.raw (413 on overflow).
 */
const express = require('express');
const fs = require('fs');
const library = require('../services/libraryManager');
const config = require('../config');

const router = express.Router();

const MAX_UPLOAD = Number(config.libraryMaxUploadBytes) || 52428800;
const MAX_NAME = 200;
const MAX_DESC = 500;

// Mounted before :id routes so 'upload' is never treated as a file id.
router.post(
  '/upload',
  express.raw({ type: '*/*', limit: MAX_UPLOAD }),
  (req, res) => {
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const name = String(req.query.name || req.headers['x-file-name'] || '').slice(0, MAX_NAME);
    const description = String(req.query.description || req.headers['x-file-description'] || '').slice(0, MAX_DESC);
    if (!name.trim()) {
      return res.status(400).json({ ok: false, error: 'file name is required (?name= or X-File-Name)' });
    }
    const mime = String(req.headers['x-file-type'] || '');
    const r = library.save({ name, mime, description, buffer: buf });
    if (!r.ok) return res.status(400).json(r);
    res.status(201).json({ ok: true, file: r.file });
  }
);

// GET /api/library
router.get('/', (_req, res) => {
  res.json({ ok: true, files: library.list(), libraryDir: library.LIB_DIR });
});

// GET /api/library/:id
router.get('/:id', (req, res) => {
  const f = library.get(req.params.id);
  if (!f) return res.status(404).json({ ok: false, error: 'file not found' });
  res.json({ ok: true, file: f });
});

// PUT /api/library/:id — body: { name?, description? }
router.put('/:id', (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const r = library.update(req.params.id, {
    name: body.name !== undefined ? String(body.name).slice(0, MAX_NAME) : undefined,
    description: body.description !== undefined ? String(body.description).slice(0, MAX_DESC) : undefined,
  });
  res.status(r.ok ? 200 : 404).json(r);
});

// GET /api/library/:id/content
router.get('/:id/content', (req, res) => {
  const f = library.get(req.params.id);
  if (!f) return res.status(404).json({ ok: false, error: 'file not found' });
  const abs = library.blobPath(f.id);
  if (!fs.existsSync(abs)) return res.status(404).json({ ok: false, error: 'stored blob is missing' });
  const inline = library.isProbablyText(f) || String(f.mime || '').startsWith('image/');
  res.setHeader('Content-Type', f.mime || 'application/octet-stream');
  res.setHeader(
    'Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`
  );
  res.setHeader('Content-Length', String(f.size));
  const stream = fs.createReadStream(abs);
  stream.on('error', () => {
    if (!res.headersSent) res.status(500).end();
    else res.destroy();
  });
  stream.pipe(res);
});

// DELETE /api/library/:id
router.delete('/:id', (req, res) => {
  const r = library.remove(req.params.id);
  res.status(r.ok ? 200 : 404).json(r);
});

module.exports = router;