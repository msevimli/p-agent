/**
 * /api/channels — agent channels configuration (Telegram).
 *
 *   GET    /api/channels                      list channels + live status
 *   PUT    /api/channels/telegram             update allowedChatIds
 *   POST   /api/channels/telegram/toggle      enable/disable the poller
 *   POST   /api/channels/telegram/token       set (or clear) the bot token
 *   POST   /api/channels/telegram/test        validate the token via getMe
 *
 * Secrets: the bot token is NEVER stored in channels-state.json. It is
 * written to the gitignored .env (TELEGRAM_BOT_TOKEN) via the same
 * writeDotEnvVar pattern the Models panel uses, and mirrored into the live
 * process env so enabling works without a restart. Responses only expose
 * tokenSet: true/false.
 */
const express = require('express');
const telegramBot = require('../services/telegramBot');

const router = express.Router();

function parseChatIds(v) {
  if (v === undefined || v === null) return undefined;
  const list = Array.isArray(v) ? v : String(v).split(',').map((s) => s.trim());
  return list.map(String).filter((s) => /^-?\d+$/.test(s)).slice(0, 100);
}

// GET /api/channels
router.get('/', (_req, res) => {
  res.json({ ok: true, channels: [telegramBot.status()] });
});

// PUT /api/channels/telegram — body: { allowedChatIds?: string[] }
router.put('/telegram', (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const ids = parseChatIds(body.allowedChatIds);
  if (ids === undefined) {
    return res.status(400).json({ ok: false, error: 'allowedChatIds is required' });
  }
  const r = telegramBot.setAllowedChatIds(ids);
  res.json({ ok: true, ...r });
});

// POST /api/channels/telegram/toggle — body: { enabled: boolean }
router.post('/telegram/toggle', (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const r = telegramBot.setEnabled(body.enabled === true);
  res.status(r.ok ? 200 : 400).json(r);
});

// POST /api/channels/telegram/token — body: { token?: string } ('' clears)
router.post('/telegram/token', (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (typeof body.token !== 'string') {
    return res.status(400).json({ ok: false, error: 'token must be a string (empty string clears it)' });
  }
  const r = telegramBot.writeToken(body.token);
  res.status(r.ok ? 200 : 500).json(r);
});

// POST /api/channels/telegram/test — validate the configured token (getMe)
router.post('/telegram/test', async (_req, res) => {
  const t = await telegramBot.testConnection();
  res.status(t.ok ? 200 : 400).json(t);
});

module.exports = router;