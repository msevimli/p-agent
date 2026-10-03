/** /api/sessions — CRUD over the persisted session store. */
const express = require('express');
const router = express.Router();
const store = require('../services/sessionStore');

function newSession(body) {
  return {
    id: body.id || `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    title: (body.title || 'New chat').slice(0, 120),
    messages: Array.isArray(body.messages) ? body.messages : [],
    createdAt: body.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

router.get('/', (_req, res) => {
  res.json(store.load());
});

router.post('/', (req, res) => {
  const sessions = store.load();
  const session = newSession(req.body || {});
  const idx = sessions.findIndex((s) => s.id === session.id);
  if (idx >= 0) sessions[idx] = session;
  else sessions.unshift(session);
  store.save(sessions);
  res.json(session);
});

router.delete('/:id', (req, res) => {
  const sessions = store.load().filter((s) => s.id !== req.params.id);
  store.save(sessions);
  res.json({ ok: true });
});

module.exports = router;