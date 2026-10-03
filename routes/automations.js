/**
 * /api/automations — scheduled automation rules (cron / interval / on-demand).
 *
 * Backed by services/automationManager.js. Provides:
 *   GET    /api/automations           list all rules + next-run/log status
 *   POST   /api/automations           create a rule
 *   GET    /api/automations/:id       single rule
 *   PUT    /api/automations/:id       update name/description/schedule/action
 *   POST   /api/automations/:id/toggle  enable (true) or pause (false)
 *   POST   /api/automations/:id/run     manual on-demand run (works while paused)
 *   DELETE /api/automations/:id       delete a rule
 */
const express = require('express');
const manager = require('../services/automationManager');
const router = express.Router();

// GET /api/automations
router.get('/', (_req, res) => {
  res.json({ ok: true, automations: manager.list() });
});

// GET /api/automations/:id
router.get('/:id', (req, res) => {
  const a = manager.get(req.params.id);
  if (!a) return res.status(404).json({ ok: false, error: 'automation not found' });
  res.json({ ok: true, automation: a });
});

// POST /api/automations
router.post('/', (req, res) => {
  const r = manager.create(req.body || {});
  res.status(r.ok ? 201 : 400).json(r);
});

// PUT /api/automations/:id
router.put('/:id', (req, res) => {
  const r = manager.update(req.params.id, req.body || {});
  res.status(r.ok ? 200 : r.error ? 404 : 400).json(r);
});

// POST /api/automations/:id/toggle  body: { enabled: boolean }
router.post('/:id/toggle', (req, res) => {
  const r = manager.setEnabled(req.params.id, req.body && req.body.enabled);
  res.status(r.ok ? 200 : 404).json(r);
});

// POST /api/automations/:id/run — manual trigger; completes in the background.
router.post('/:id/run', async (req, res) => {
  const r = await manager.runNow(req.params.id);
  res.status(r.ok ? 202 : 409).json(r);
});

// DELETE /api/automations/:id
router.delete('/:id', (req, res) => {
  const r = manager.remove(req.params.id);
  res.status(200).json(r);
});

module.exports = router;