/**
 * /api/queue — live FIFO request-queue stats (concurrency, waiters, retries).
 *
 * Backed by services/requestQueue.js. The frontend and operators can poll this
 * to see how many heavy LLM/automation requests are queued behind the current
 * one (single-slot llama.cpp ⇒ limit 1).
 */
const express = require('express');
const requestQueue = require('../services/requestQueue');
const router = express.Router();

// GET /api/queue
router.get('/', (_req, res) => {
  res.json({ ok: true, queue: requestQueue.stats() });
});

module.exports = router;