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
 *
 * Security: an apiKey sent here is routed by the manager to <root>/.env
 * (LLAMA_API_KEY_<MODEL_ID>) — it is never persisted in models-state.json,
 * which stays free of plaintext secrets. Responses carry only hasKey flags.
 */
const express = require('express');
const modelManager = require('../services/modelManager');
const modelLifecycle = require('../services/modelLifecycle');
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

// GET /api/models/status -> live lifecycle status (unloaded | loading |
// ready | error) per model + memory footprint. MUST stay registered before
// GET /:id so "status" is never captured as a model id.
router.get('/status', async (_req, res) => {
  try {
    const r = await modelLifecycle.getStatuses();
    res.json({ ok: true, ...r });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'could not probe model status' });
  }
});

// POST /api/models/warmup  body: { id? } (default: active model) — background
// pre-load so the first user prompt responds instantly.
router.post('/warmup', async (req, res) => {
  try {
    const active = modelManager.getActiveModel();
    const target = (req.body && req.body.id) || (active && active.id) || '';
    const r = await modelLifecycle.warmup(target);
    res.status(r.ok ? 200 : r.code || 400).json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'warm-up failed' });
  }
});

// POST /api/models/eject  body: { id? } (default: active model) — free model
// weights from memory (capability-tiered, see modelLifecycle).
router.post('/eject', async (req, res) => {
  try {
    const active = modelManager.getActiveModel();
    const target = (req.body && req.body.id) || (active && active.id) || '';
    const r = await modelLifecycle.eject(target);
    res.status(r.ok ? 200 : r.code || 400).json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'eject failed' });
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
