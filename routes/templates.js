/**
 * /api/models/templates — llama-server launch-config templates.
 *
 * Backed by services/templateStore.js (data/templates-state.json). The
 * built-in default template is present from first run, undeletable, and
 * keeps its name; every other template is fully user-managed. Templates are
 * referenced by models via their `templateId` registry field and applied by
 * the model lifecycle manager when a model's launch unit is generated.
 *
 *   GET    /api/models/templates        list all templates
 *   POST   /api/models/templates        create a template
 *   PUT    /api/models/templates/:id    update a template
 *   DELETE /api/models/templates/:id    delete a template (built-in: 400)
 */
const express = require('express');
const templateStore = require('../services/templateStore');
const router = express.Router();

router.get('/', (_req, res) => {
  try {
    res.json({ ok: true, templates: templateStore.list() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'could not list templates' });
  }
});

router.post('/', (req, res) => {
  const r = templateStore.create(req.body || {});
  res.status(r.ok ? 201 : 400).json(r);
});

router.put('/:id', (req, res) => {
  const r = templateStore.update(req.params.id, req.body || {});
  res.status(r.ok ? 200 : 400).json(r);
});

router.delete('/:id', (req, res) => {
  const r = templateStore.remove(req.params.id);
  res.status(r.ok ? 200 : 400).json(r);
});

module.exports = router;