/**
 * /api/models — multi-model registry + active-model selection.
 *
 * Backed by services/modelManager.js. Provides:
 *   GET    /api/models           list all models + active id (live status)
 *   POST   /api/models           create a model (name, endpoint, model, contextLength, apiKey?)
 *   GET    /api/models/:id       single model
 *   PUT    /api/models/:id       update a model
 *   DELETE /api/models/:id       delete a model
 *   POST   /api/models/:id/activate   set a model as the active/default model
 */
const express = require('express');
const modelManager = require('../services/modelManager');
const router = express.Router();

// GET /api/models -> { ok, active, models: [...] }
router.get('/', async (_req, res) => {
  try {
    const { active, models } = await modelManager.listModels();
    res.json({ ok: true, active, models });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'could not list models' });
  }
});

// GET /api/models/:id -> single model
router.get('/:id', (req, res) => {
  const m = modelManager.getModel(req.params.id);
  if (!m) return res.status(404).json({ ok: false, error: 'model not found' });
  res.json({ ok: true, model: m });
});

// POST /api/models  body: { id, name, endpoint, model, contextLength?, apiKey?, provider? }
router.post('/', (req, res) => {
  const r = modelManager.createModel(req.body || {});
  res.status(r.ok ? 201 : 400).json(r);
});

// PUT /api/models/:id  body: { name?, endpoint?, model?, contextLength?, apiKey?, id? (rename) }
router.put('/:id', (req, res) => {
  const r = modelManager.updateModel(req.params.id, req.body || {});
  res.status(r.ok ? 200 : 400).json(r);
});

// DELETE /api/models/:id
router.delete('/:id', (req, res) => {
  const r = modelManager.deleteModel(req.params.id);
  res.status(200).json(r);
});

// POST /api/models/:id/activate  — make this model the active/default one.
router.post('/:id/activate', (req, res) => {
  const r = modelManager.setActive(req.params.id);
  res.status(r.ok ? 200 : 400).json(r);
});

module.exports = router;
