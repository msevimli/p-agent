/**
 * /api/system/prompt — GET / POST / DELETE the active system prompt.
 *
 * GET returns the EXACT prompt that is currently sent to the model
 * (the persisted override when set, else the generated template including
 * the tool-payloads section), so the editor always shows ground truth.
 * POST persists a replacement override (replaces the template wholesale).
 * DELETE clears the override and returns to the generated template.
 *
 * Mounted at /api/system/prompt AFTER /api/system (metrics router), so
 * /metrics keeps working and plain /api/system/* falls through to here.
 */
'use strict';

const express = require('express');
const router = express.Router();

const config = require('../config');
const toolLoop = require('../services/toolLoop');
const systemPrompt = require('../services/systemPrompt');

/** The active prompt: override if set, else the template (mirror routes/chat.js). */
function activePrompt() {
  const override = systemPrompt.getOverride();
  if (override) return { prompt: override, source: 'override', overridden: true };
  const toolsEnabled = config.toolCallingEnabled && toolLoop.listTools().length > 0;
  // No override: serve the BUILT-IN default (services/system-prompt.default.txt — the
  // current prompt was promoted to the default), not the legacy generated template.
  const built = toolsEnabled
    ? systemPrompt.getDefault()
    : `${config.llamaSystemPrompt}\n\n${toolLoop.AUTOMATIONS_GUIDANCE}`;
  return { prompt: built, source: 'template', overridden: false };
}

router.get('/', (_req, res) => {
  try {
    res.json({ ok: true, ...activePrompt() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || 'could not load system prompt' });
  }
});

router.post('/', (req, res) => {
  const text = (req.body && typeof req.body.prompt === 'string') ? req.body.prompt : '';
  const r = systemPrompt.setOverride(text);
  if (!r.ok) return res.status(400).json({ ok: false, error: r.error });
  res.json({ ok: true, ...activePrompt() });
});

router.delete('/', (_req, res) => {
  systemPrompt.resetOverride();
  res.json({ ok: true, ...activePrompt() });
});

module.exports = router;