/**
 * requestQueue — FIFO serialization for LLM + heavy automation requests.
 *
 * Local llama.cpp serves a SINGLE generation slot: parallel completions make
 * it return empty streams, error out, or serialize server-side with no
 * client signal. This module gives every outgoing heavy request a fair FIFO
 * slot so the dashboard fires at most `limit` upstream requests at once
 * (default 1). Items that fail with a transient error (socket hang-up,
 * ECONNRESET, EPIPE, timeouts, unreachable, empty stream) are automatically
 * retried by re-entering the queue, up to `retries` extra attempts.
 *
 * Re-entrancy note: queue slots must never nest. Anything that itself calls
 * enqueue() (e.g. llamaClient.complete() → LLM) must NOT be wrapped again at
 * a higher level — queue the spawns/scripts separately, never the whole
 * operation that contains queued calls (would deadlock).
 */
const config = require('../config');

const TRANSIENT = /hang up|ECONNRESET|EPIPE|ETIMEDOUT|unreachable|empty stream|402|429|in_flight_budget|rate[- ]limited|temporarily rate-limited/i;

const limit = Math.max(1, Number(config.queueLimit) || 1);
const maxRetries = Math.max(0, Math.floor(Number(config.queueRetries) || 0));

const waiters = []; // FIFO of { fn, label, attempts }
let active = 0;
const stats = { limit, active: 0, waiting: 0, completed: 0, retried: 0, failed: 0 };

function pump() {
  stats.active = active;
  stats.waiting = waiters.length;
  while (active < limit && waiters.length) {
    const w = waiters.shift();
    active++;
    run(w);
  }
  stats.active = active;
  stats.waiting = waiters.length;
}

function isTransient(err) {
  return TRANSIENT.test(String((err && err.message) || err || ''));
}

async function run(w) {
  try {
    const value = await w.fn();
    stats.completed++;
    active--;
    pump();
    w.resolve(value);
  } catch (err) {
    if (isTransient(err) && w.attempts < maxRetries) {
      // Transient failure: release the slot and re-enqueue the SAME waiter
      // (its promise is the caller's handle, so it must survive retries) at
      // the back of the queue after a short backoff. The item keeps its
      // original attempt count +1 and runs again when its turn comes.
      stats.retried++;
      w.attempts++;
      active--;
      pump();
      const backoffMs = 400 * w.attempts;
      setTimeout(() => {
        w.position = active + waiters.length + 1;
        waiters.push(w);
        pump();
      }, backoffMs);
      return;
    }
    stats.failed++;
    active--;
    pump();
    w.reject(err);
  }
}

/** Create a queue entry carrying the caller-facing promise + settle handles. */
function makeWaiter(fn, label, attempts) {
  const w = {
    fn,
    label: label || 'task',
    attempts: attempts || 0,
    position: active + waiters.length + 1,
    resolve: null,
    reject: null,
  };
  w.promise = new Promise((resolve, reject) => {
    w.resolve = resolve;
    w.reject = reject;
  });
  return w;
}

/**
 * Enqueue `fn` for exclusive execution. Returns { promise, position } where
 * position is the item's FIFO rank at enqueue time (1 = next/executing).
 */
function enqueue(fn, opts = {}) {
  const w = makeWaiter(fn, opts.label, 0);
  waiters.push(w);
  pump();
  return { promise: w.promise, position: w.position };
}

/** Snapshot of queue state for /api/queue + debugging. */
function statsSnapshot() {
  return {
    limit,
    active,
    waiting: waiters.length,
    retries: maxRetries,
    completed: stats.completed,
    retried: stats.retried,
    failed: stats.failed,
    labels: waiters.map((w) => ({ label: w.label, attempts: w.attempts, position: w.position })),
  };
}

module.exports = { enqueue, stats: statsSnapshot, isTransient };