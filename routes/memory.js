'use strict';
/**
 * Memory API for the sidebar Memory tab.
 *
 *   GET    /api/memory                -> { ok, count, facts } (newest first)
 *   GET    /api/memory?q=<text>       -> { ok, count, facts } semantic top-k
 *   POST   /api/memory {fact, category?} -> 201 { ok, fact } | 400 { ok:false, error }
 *   DELETE /api/memory/:id            -> { ok, deleted } | 404
 *   GET    /api/memory/workspace      -> { ok, exists, bytes, content, truncated }
 *   PUT    /api/memory/workspace {content} -> { ok, bytes, saved } | 413
 *
 * Thin wrappers over services/vectorMemory + services/workspaceMemory —
 * the same layer the agent tools and the per-turn injection use, so the UI,
 * the tools and the prompts can never disagree. No auth on these endpoints
 * (same trust model as every other dashboard API).
 */

const express = require('express');
const vectorMemory = require('../services/vectorMemory');
const workspaceMemory = require('../services/workspaceMemory');

const router = express.Router();

function bad(res, error, status = 400) {
  return res.status(status).json({ ok: false, error });
}

// GET /api/memory[?q=...]
router.get('/', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  try {
    if (q) {
      const facts = await vectorMemory.searchFacts(q, 5);
      return res.json({ ok: true, count: facts.length, facts });
    }
    const facts = vectorMemory.listFacts(500);
    return res.json({ ok: true, count: facts.length, facts });
  } catch (e) {
    return bad(res, e && e.message ? e.message : String(e), 500);
  }
});

// POST /api/memory { fact, category? }
router.post('/', async (req, res) => {
  const body = req.body || {};
  if (typeof body.fact !== 'string' || body.fact.trim() === '') {
    return bad(res, 'fact is required (non-empty string)');
  }
  try {
    const r = await vectorMemory.addFact(body.fact, body.category == null ? '' : String(body.category));
    if (!r.ok) return bad(res, r.error, r.error && /dimension|full/.test(r.error) ? 409 : 400);
    return res.status(201).json({ ok: true, fact: r.fact });
  } catch (e) {
    return bad(res, e && e.message ? e.message : String(e), 500);
  }
});

// ---- workspace MEMORY.md ---------------------------------------------------
// Registered BEFORE the /:id routes — Express matches in registration order.

// GET /api/memory/workspace
router.get('/workspace', (req, res) => {
  const r = workspaceMemory.readMemory();
  return res.json({ ...r, path: 'MEMORY.md' });
});

// PUT /api/memory/workspace { content }
router.put('/workspace', (req, res) => {
  const body = req.body || {};
  if (typeof body.content !== 'string') return bad(res, 'content is required (string)');
  const r = workspaceMemory.writeMemory(body.content);
  if (!r.ok) return bad(res, r.error, r.error && /too large/.test(r.error) ? 413 : 400);
  return res.json({ ok: true, bytes: r.bytes, saved: true, path: 'MEMORY.md' });
});

// DELETE /api/memory/workspace — remove MEMORY.md (UI "clear" action)
router.delete('/workspace', (req, res) => {
  workspaceMemory.clearMemory();
  return res.json({ ok: true, cleared: true });
});

// DELETE /api/memory/:id
router.delete('/:id', (req, res) => {
  const id = String(req.params.id || '');
  if (!id) return bad(res, 'id is required');
  const r = vectorMemory.deleteFact(id);
  if (!r.ok) return bad(res, r.error, 404);
  return res.json({ ok: true, deleted: true, id: r.id });
});

// ---- workspace MEMORY.md ---------------------------------------------------

// GET /api/memory/workspace
router.get('/workspace', (req, res) => {
  const r = workspaceMemory.readMemory();
  return res.json({ ...r, path: 'MEMORY.md' });
});

// PUT /api/memory/workspace { content }
router.put('/workspace', (req, res) => {
  const body = req.body || {};
  if (typeof body.content !== 'string') return bad(res, 'content is required (string)');
  const r = workspaceMemory.writeMemory(body.content);
  if (!r.ok) return bad(res, r.error, r.error && /too large/.test(r.error) ? 413 : 400);
  return res.json({ ok: true, bytes: r.bytes, saved: true, path: 'MEMORY.md' });
});

// DELETE /api/memory/workspace — remove MEMORY.md (UI "clear" action)
router.delete('/workspace', (req, res) => {
  workspaceMemory.clearMemory();
  return res.json({ ok: true, cleared: true });
});

module.exports = router;