/**
 * /api/skills — CRUD + execution surface for the workspace skill registry.
 *
 * Backed by services/skillManager.js. All paths exercise the same slug +
 * sandbox guards the manager applies, so names can't escape the skills dir.
 */
const express = require('express');
const skillManager = require('../services/skillManager');

const router = express.Router();

// GET /api/skills -> { ok, skills: [...] }
router.get('/', (_req, res) => {
  res.json({ ok: true, skills: skillManager.listSkills() });
});

// POST /api/skills  body: { name, description?, version?, entry?, files? }
// Create or update a skill. Allows the UI/agent to author skills dynamically.
router.post('/', (req, res) => {
  const r = skillManager.writeSkill(req.body || {});
  res.status(r.ok ? 201 : 400).json(r);
});

// GET /api/skills/:name -> single skill
router.get('/:name', (req, res) => {
  const s = skillManager.loadSkill(req.params.name);
  if (!s) return res.status(404).json({ ok: false, error: 'skill not found' });
  res.json({ ok: true, skill: s });
});

// POST /api/skills/:name/toggle  body: { enabled: boolean }
router.post('/:name/toggle', (req, res) => {
  const enabled = req.body && typeof req.body.enabled === 'boolean' ? req.body.enabled : true;
  const r = skillManager.setEnabled(req.params.name, enabled);
  res.status(r.ok ? 200 : 400).json(r);
});

// POST /api/skills/:name/run  body: { args?: string[], timeoutMs?: number }
router.post('/:name/run', async (req, res) => {
  const body = req.body || {};
  const r = await skillManager.runSkill(req.params.name, body.args, { timeoutMs: body.timeoutMs });
  res.status(r.ok ? 200 : 400).json(r);
});

// DELETE /api/skills/:name
router.delete('/:name', (req, res) => {
  const r = skillManager.deleteSkill(req.params.name);
  res.status(r.ok ? 200 : 400).json(r);
});

module.exports = router;
