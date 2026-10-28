#!/usr/bin/env node
/**
 * ui-context-pill-check.cjs — jsdom harness for the per-session context
 * usage pill (the reported sync bug: switching away from a session and back
 * dropped the pill back to the character estimate, e.g. "3.3k / 500.0k"
 * estimated while the last message card showed "11.0k tok").
 *
 * Drives the REAL app.js with a mock /api/sessions store (usage persisted
 * like the real server whitelist) + a controlled /api/chat SSE stream:
 *  - turn in session A reports 11000 prompt tokens -> pill "11.0k / 500.0k";
 *  - turn in session B reports 3000 -> "3.0k / 500.0k";
 *  - switching BACK to A must restore "11.0k / 500.0k" from A's OWN record
 *    (the regression: old code nulled a global state.lastUsage on switch);
 *  - second boot (fresh page) restores the pill from the PERSISTED session
 *    usage without any new turn.
 *
 * Run: NODE_PATH=/home/hermesai/.hermes/hermes-agent/node_modules \
 *        node scripts/ui-context-pill-check.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const results = [];
const t = (name, cond, detail) => results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`);

const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = new global.TextEncoder();
const sse = (obj) => enc.encode(`data: ${JSON.stringify(obj)}\n\n`);

function boot(sessionStore) {
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:8888/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  if (!window.TextDecoder) { window.TextDecoder = global.TextDecoder; window.TextEncoder = global.TextEncoder; }
  if (!window.ReadableStream) window.ReadableStream = global.ReadableStream;
  if (!window.AbortController) window.AbortController = global.AbortController;

  let streamCtrl = null;
  const posts = []; // every POST /api/sessions body (persistence proof)
  const sessions = sessionStore; // shared with the caller (survives reboots)

  window.fetch = async (url, opts) => {
    const u = String(url);
    const json = (obj, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => obj, headers: { get: () => null } });
    if (opts && opts.method === 'POST' && u.includes('/api/chat')) {
      const stream = new global.ReadableStream({ start(c) { streamCtrl = c; } });
      return { ok: true, status: 200, headers: { get: () => null }, body: stream };
    }
    if (opts && opts.method === 'POST' && u.includes('/api/sessions')) {
      const body = JSON.parse(opts.body);
      posts.push({ id: body.id, hasUsage: !!body.usage, usage: body.usage });
      const existing = sessions.find((s) => s.id === body.id);
      // Mirrors routes/sessions.js newSession: whitelist incl. usage.
      const saved = {
        id: existing ? existing.id : `s_${sessions.length + 1}_mock`,
        title: body.title || 'New chat',
        messages: body.messages || [],
        usage: body.usage && typeof body.usage === 'object' ? body.usage : null,
        createdAt: existing ? existing.createdAt : new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const idx = sessions.findIndex((s) => s.id === saved.id);
      if (idx >= 0) sessions[idx] = saved;
      else sessions.unshift(saved);
      return json(saved);
    }
    if (!opts || !opts.method || opts.method === 'GET') {
      if (u.includes('/api/sessions')) return json(sessions);
      if (u.includes('/api/health')) return json({ server: { up: true, port: 8888 }, llama: { up: true }, contextWindow: 500000 });
      if (u.includes('/api/chat/state/')) return json({ ok: false, active: false }, 404);
      if (u.includes('/api/models')) return json({ models: [], cascade: null });
      if (u.includes('/api/models/status')) return json({ ok: true, models: [], active: null });
      if (u.includes('/api/skills')) return json({ skills: [] });
      if (u.includes('/api/automations')) return json({ automations: [], paused: false });
      if (u.includes('/api/system/prompt')) return json({ prompt: '' });
      if (u.includes('/api/system/metrics')) return json({ cpu: 0, ram: 0 });
      if (u.includes('/api/library')) return json({ files: [] });
      if (u.includes('/api/templates')) return json({ templates: [] });
      if (u.includes('/api/channels')) return json({ channels: [] });
      if (u.includes('/api/queue')) return json({ queue: [] });
      return json({ ok: true });
    }
    return json({ ok: true });
  };
  window.marked = { parse: (s) => String(s || ''), setOptions: () => {}, use: () => {} };
  dom.window.eval(appJs);

  const $ = (sel) => window.document.querySelector(sel);
  const $$ = (sel) => [...window.document.querySelectorAll(sel)];
  const clickSession = (titleNeedle) => {
    const item = $$('.session-item').find((el) => (el.textContent || '').includes(titleNeedle));
    if (!item) return false;
    item.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    return true;
  };
  const pill = () => ({ text: $('#contextSummary') ? $('#contextSummary').textContent : null, source: $('#ctxSource') ? $('#ctxSource').textContent : null });

  return { window, $, $$, clickSession, pill, posts, getStreamCtrl: () => streamCtrl };
}

(async () => {
  const store = []; // server-side session store, shared across both boots

  // ============================ boot 1 ======================================
  const app = await new Promise((resolve) => { resolve(boot(store)); });
  await sleep(450); // loadSessions + checkHealth (window 500000) settle

  t('pill: boot shows empty budget with the health window', app.pill().text === '0 tok · 0%', app.pill().text);

  // --- session A: TWO turns reporting usage (11000 then 12000 prompt) ---------
  app.$('#newChatBtn').dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }));
  app.$('#promptInput').value = 'tell me about alpha';
  app.$('#sendBtn').dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }));
  await sleep(150);
  let ctrlA = app.getStreamCtrl();
  ctrlA.enqueue(sse({ choices: [{ delta: { content: 'Alpha answer one' } }] }));
  ctrlA.enqueue(sse({ usage: { prompt_tokens: 11000, completion_tokens: 200 } }));
  ctrlA.close();
  await sleep(300);
  t('pill: A after turn 1 = accumulated 11.2k total', app.pill().text === '11.2k tok · 2%', app.pill().text);
  t('pill: A window footprint uses turn 1 prompt (11.0k / 500.0k)', app.$('#ctxTokens').textContent === '11.0k / 500.0k', app.$('#ctxTokens').textContent);
  t('pill: A breakdown says In 11.0k + Out 200', app.$('#ctxTotals').textContent === 'In 11.0k + Out 200 = 11.2k', app.$('#ctxTotals').textContent);

  // second turn in the SAME session: usage must ACCUMULATE, never replace
  app.$('#promptInput').value = 'tell me more about alpha';
  app.$('#sendBtn').dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }));
  await sleep(150);
  ctrlA = app.getStreamCtrl();
  ctrlA.enqueue(sse({ choices: [{ delta: { content: 'Alpha answer two' } }] }));
  ctrlA.enqueue(sse({ usage: { prompt_tokens: 12000, completion_tokens: 300 } }));
  ctrlA.close();
  await sleep(300);
  t('pill: A after turn 2 = ACCUMULATED 23.5k (not just 12.3k)', app.pill().text === '23.5k tok · 2%', app.pill().text);
  t('pill: A accumulated In is 23.0k across both turns', app.$('#ctxInput').textContent === '23.0k', app.$('#ctxInput').textContent);
  t('pill: A accumulated Out is 500 across both turns', app.$('#ctxOutput').textContent === '500', app.$('#ctxOutput').textContent);
  t('pill: A window footprint advanced to turn 2 prompt (12.0k / 500.0k)', app.$('#ctxTokens').textContent === '12.0k / 500.0k', app.$('#ctxTokens').textContent);
  t('pill: A session totals row adds up', app.$('#ctxTotals').textContent === 'In 23.0k + Out 500 = 23.5k', app.$('#ctxTotals').textContent);
  t('pill: A usage persisted with accumulated totals', JSON.stringify(app.posts.at(-1).usage).includes('"prompt_tokens":23000') && JSON.stringify(app.posts.at(-1).usage).includes('"completion_tokens":500'), JSON.stringify(app.posts.at(-1).usage));

  // --- session B: a fresh chat reporting 3000 prompt tokens -------------------
  app.$('#newChatBtn').dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }));
  app.$('#promptInput').value = 'tell me about beta';
  app.$('#sendBtn').dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }));
  await sleep(150);
  const ctrlB = app.getStreamCtrl();
  ctrlB.enqueue(sse({ choices: [{ delta: { content: 'Beta answer' } }] }));
  ctrlB.enqueue(sse({ usage: { prompt_tokens: 3000, completion_tokens: 80 } }));
  ctrlB.close();
  await sleep(300);
  t('pill: session B pill shows its own 3.1k total', app.pill().text === '3.1k tok · 1%', app.pill().text);

  // --- THE REGRESSION: switch back to A, then to B, then to A again -----------
  await sleep(50);
  t('pill: session list offers both sessions', app.clickSession('alpha') && app.clickSession('beta') && app.clickSession('alpha'), '');
  await sleep(100);
  t('pill: switching BACK to A restores the FULL accumulated 23.5k', app.pill().text === '23.5k tok · 2%', `got ${app.pill().text} | ${app.pill().source}`);
  t('pill: restored A In still totals 23.0k (not turn-2-only)', app.$('#ctxInput').textContent === '23.0k', app.$('#ctxInput').textContent);
  t('pill: restored A source is llama-reported, not estimated', app.pill().source === 'From llama.cpp usage stats (accumulated per turn).', app.pill().source);
  app.clickSession('beta');
  await sleep(100);
  t('pill: B pill still 3.1k after the round-trip', app.pill().text === '3.1k tok · 1%', `got ${app.pill().text}`);

  // ==================== boot 2: reload restores persisted usage ===============
  // Fresh page, SAME server-side store (records now carry ACCUMULATED usage).
  const app2 = await new Promise((resolve) => { resolve(boot(store)); });
  await sleep(450);
  t('reload: boot2 auto-opened the newest session (B) with its reported totals', app2.pill().text === '3.1k tok · 1%', app2.pill().text);
  app2.clickSession('alpha');
  await sleep(100);
  t('reload: session A pill restored from PERSISTED totals without any turn', app2.pill().text === '23.5k tok · 2%', `got ${app2.pill().text} | ${app2.pill().source}`);
  t('reload: restored In is the accumulated 23.0k', app2.$('#ctxInput').textContent === '23.0k', app2.$('#ctxInput').textContent);
  t('reload: restored source is llama-reported', app2.pill().source === 'From llama.cpp usage stats (accumulated per turn).', app2.pill().source);

  const fails = results.filter((r) => r.startsWith('FAIL'));
  console.log(results.join('\n'));
  console.log(`\n${fails.length === 0 ? 'ALL' : fails.length + ' FAILED of'} ${results.length} PASSED`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});