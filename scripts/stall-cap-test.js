/**
 * Slot-supervisor + finishReason tests for llamaClient.
 *
 * Mocks a llama.cpp server on a dedicated port: GET /slots answers per the
 * `slotState` var ('processing' | 'idle' | '404'), POST /v1/chat/completions
 * holds the stream open and exposes a control handle to the test.
 * Scenarios prove the slot-aware liveness supervisor:
 *   1. pre-first-byte, /slots unavailable (404)        -> fixed-grace abort
 *   2. pre-first-byte, slot busy                        -> waits PAST the grace
 *   3. post-first-byte, slot idle (2 consecutive polls) -> dynamic abort
 *   4. post-first-byte, slot busy                       -> waits PAST the grace
 *   5. finish_reason regression (length capture)
 *
 * Active model is swapped in data/models-state.json and restored in `finally`
 * (the file is re-read per request — no restart needed).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const config = require(path.join(ROOT, 'config'));
const { complete, buildChatPayload } = require(path.join(ROOT, 'services', 'llamaClient'));

const STATE = path.join(ROOT, 'data', 'models-state.json');
const PORT = 9877;
const orig = fs.readFileSync(STATE, 'utf8');

let slotState = '404'; // 'processing' | 'idle' | '404'
let streamCtl = null;

const server = http.createServer((req, res) => {
  console.log(`[mock] ${req.method} ${req.url} slotState=${slotState}`);
  if (req.url === '/slots' || req.url.startsWith('/slots?')) {
    if (slotState === '404') { res.writeHead(404); return res.end('not found'); }
    const busy = slotState === 'processing';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify([{ id: 0, is_processing: busy, id_task: busy ? 42 : 0 }]));
  }
  // Only real chat-completion POSTs become held streams; everything else
  // (health/props from stray probes) gets a 404 so it can't clobber state.
  if (req.method !== 'POST' || !req.url.includes('/chat/completions')) {
    res.writeHead(404); return res.end('nope');
  }
  req.on('data', () => {});
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.flushHeaders();
    res.on('close', () => {});
    res.on('error', () => {});
    res.on('aborted', () => {});
    streamCtl = {
      send(obj) { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (e) { console.log('[mock] send threw:', e.message); } },
      finish() {
        try {
          res.write('data: {"choices":[],"usage":{"total_tokens":10}}\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        } catch (e) { console.log('[mock] finish threw:', e.message); }
      },
    };
    console.log('[mock] stream ctl ready');
  });
  req.on('error', () => {});
});

// Watchdog: if anything hangs, restore the state file and exit instead of
// leaving the live dashboard pointed at a dead mock (a killed process skips
// `finally`). 45s > the whole expected suite (~15s).
const watchdog = setTimeout(() => {
  console.log('WATCHDOG: suite exceeded 45s — restoring state and exiting');
  fs.writeFileSync(STATE, orig);
  process.exit(2);
}, 45000);

const writeState = () => {
  const s = JSON.parse(orig);
  s.models = (s.models || []).filter((m) => !String(m.id).startsWith('mock-'));
  s.models.push({ id: 'mock-slot', name: 'mock', endpoint: `http://127.0.0.1:${PORT}`, model: 'x' });
  s.activeId = 'mock-slot';
  fs.writeFileSync(STATE, JSON.stringify(s, null, 2));
};

const payload = () => buildChatPayload([{ role: 'user', content: 'hi' }], {}, {});
const TRANSIENT = /hang up|ECONNRESET|EPIPE|ETIMEDOUT|unreachable|empty stream/i;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const log = (m) => { console.log(m); results.push(m); };

(async () => {
  await new Promise((r) => server.listen(PORT, r));
  try {
    // 1 — pre-first-byte, /slots 404: fixed grace abort
    slotState = '404';
    config.llamaStallTimeoutMs = 1200;
    writeState();
    const t0 = Date.now();
    try {
      await complete({ payload: payload() });
      log('T1 pre-byte/404: FAIL — did not reject');
    } catch (e) {
      const t1 = Date.now() - t0;
      log(
        `T1 pre-byte/404: rejected in ${t1}ms | "${e.message}"` +
        ` | non-transient: ${!TRANSIENT.test(e.message)} | sane: ${t1 > 900 && t1 < 3500}`
      );
    }
    log('T1 stage done — start T2');

    // 2 — pre-first-byte, slot busy: waits PAST the fixed grace
    slotState = 'processing';
    config.llamaStallTimeoutMs = 1200;
    const t2 = Date.now();
    const p2 = complete({ payload: payload() });
    await wait(2800); // > 2x the configured grace — must NOT abort
    const preReject = await Promise.race([
      p2.then(() => 'resolved').catch((e) => `rejected:${e.message}`),
      wait(200).then(() => 'pending'),
    ]);
    streamCtl.send({ choices: [{ delta: { content: 'done eventually' } }] });
    streamCtl.finish();
    const acc2 = await p2;
    results.push(
      `T2 pre-byte/busy: waited 2.8s past grace 1.2s — ${preReject === 'pending' ? 'no abort' : 'ABORTED'} | resolved="${acc2.content}" | total ${Date.now() - t2}ms`
    );
    log('T2 stage done — start T3');

    // 3 — post-first-byte, slot idle: dynamic abort (2 consecutive idle polls)
    slotState = 'idle';
    config.llamaStallTimeoutMs = 20000; // generous — abort must come from slot state, not the clock
    config.llamaSlotPollMs = 400;
    config.llamaSlotCheckSilenceMs = 800;
    const t3 = Date.now();
    const p3 = complete({ payload: payload() });
    await wait(300); // let the request reach the mock
    streamCtl.send({ choices: [{ delta: { content: 'partial' } }] });
    try {
      await p3;
      results.push('T3 post-byte/idle: FAIL — did not reject');
    } catch (e) {
      const t3e = Date.now() - t3;
      results.push(
        `T3 post-byte/idle: rejected in ${t3e}ms | "${e.message}"` +
        ` | slot-idle verdict: ${/slot went idle/.test(e.message)} | non-transient: ${!TRANSIENT.test(e.message)} | before-clock: ${t3e < 15000}`
      );
    }
    log('T3 stage done — start T4');

    // 4 — post-first-byte, slot busy: waits PAST the fixed grace
    slotState = 'processing';
    config.llamaStallTimeoutMs = 1500; // would abort if the fixed timer still ruled
    config.llamaSlotPollMs = 400;
    config.llamaSlotCheckSilenceMs = 800;
    const p4 = complete({ payload: payload() });
    await wait(300);
    streamCtl.send({ choices: [{ delta: { content: 'part' } }] });
    await wait(4000); // > fixed grace — must NOT abort while slot is busy
    const preReject4 = await Promise.race([
      p4.then(() => 'resolved').catch((e) => `rejected:${e.message}`),
      wait(200).then(() => 'pending'),
    ]);
    streamCtl.finish();
    const acc4 = await p4;
    results.push(
      `T4 post-byte/busy: held 4s past grace 1.5s — ${preReject4 === 'pending' ? 'no abort' : 'ABORTED'} | resolved="${acc4.content.slice(0, 20)}"`
    );
    log('T4 stage done — start T5');

    // 5 — regression: finish_reason capture with slot idle after end
    slotState = 'idle';
    const p5 = complete({ payload: payload() });
    await wait(300);
    streamCtl.send({ choices: [{ delta: { content: 'capped' } }] });
    streamCtl.send({ choices: [{ delta: {}, finish_reason: 'length' }] });
    streamCtl.finish();
    const acc5 = await p5;
    results.push(`T5 regression: finishReason=${acc5.finishReason} content="${acc5.content}"`);
    log('T5 stage done');
  } catch (e) {
    results.push('HARNESS ERROR: ' + (e.stack || e.message));
  } finally {
    clearTimeout(watchdog);
    config.llamaStallTimeoutMs = 120000;
    config.llamaSlotPollMs = 4000;
    config.llamaSlotCheckSilenceMs = 15000;
    fs.writeFileSync(STATE, orig);
    server.close();
    console.log(results.join('\n'));
    process.exit(results.some((r) => r.includes('FAIL') || r.includes('ABORTED') || r.includes('HARNESS ERROR')) ? 1 : 0);
  }
})();