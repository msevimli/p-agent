#!/usr/bin/env node
/**
 * ui-stream-reattach-check.cjs — jsdom harness for per-session stream
 * re-attachment + the sidebar processing indicator.
 *
 * Drives the REAL app.js with a controlled /api/chat SSE stream, then:
 *  - while the stream runs, switches away (session B) and back (session A),
 *  - asserts the re-attached view replays the buffered statuses + partial
 *    text, the stop button + timer resume, and LATER chunks still land
 *    live (no freeze),
 *  - asserts the sidebar pulse indicator follows the active session,
 *  - asserts the final assistant message + a mid-stream tool record are
 *    persisted into session A's OWN messages (never session B's — the
 *    wrong-session corruption guard).
 *
 * Run: NODE_PATH=/home/hermesai/.hermes/hermes-agent/node_modules \
 *        node scripts/ui-stream-reattach-check.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const results = [];
const t = (name, cond, detail) => results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`);

const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');

const sessA = { id: 'sess-a', title: 'Alpha', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [{ role: 'user', content: 'hi from A' }] };
const sessB = { id: 'sess-b', title: 'Beta', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [{ role: 'user', content: 'yo from B' }] };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:8888/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  if (!window.TextDecoder) { window.TextDecoder = global.TextDecoder; window.TextEncoder = global.TextEncoder; }
  if (!window.ReadableStream) window.ReadableStream = global.ReadableStream;
  if (!window.AbortController) window.AbortController = global.AbortController;

  // --- controlled SSE stream ------------------------------------------------
  let streamCtrl = null;
  let chatBody = null;
  let started = false;
  const persistedPosts = []; // every POST /api/sessions body (corruption guard)
  const enc = new global.TextEncoder();
  const sse = (obj) => enc.encode(`data: ${JSON.stringify(obj)}\n\n`);

  let sessions = [sessA, sessB];
  window.fetch = async (url, opts) => {
    const u = String(url);
    const json = (obj, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => obj, headers: { get: () => null } });
    if (opts && opts.method === 'POST' && u.includes('/api/chat')) {
      chatBody = JSON.parse(opts.body);
      started = true;
      const stream = new global.ReadableStream({
        start(c) { streamCtrl = c; },
      });
      return { ok: true, status: 200, headers: { get: (h) => (h === 'X-Queue-Position' ? null : null) }, body: stream };
    }
    if (opts && opts.method === 'POST' && u.includes('/api/sessions')) {
      const body = JSON.parse(opts.body);
      persistedPosts.push(body);
      const existing = sessions.find((s) => s.id === body.id);
      const saved = existing || { id: 'sess-a', createdAt: new Date().toISOString() };
      saved.title = body.title;
      saved.messages = body.messages;
      saved.updatedAt = new Date().toISOString();
      if (!existing) sessions = [saved, ...sessions.filter((s) => s.id !== saved.id)];
      else sessions = sessions.map((s) => (s.id === saved.id ? saved : s));
      return json({ ok: true, id: saved.id, title: saved.title, messages: saved.messages });
    }
    if (!opts || !opts.method || opts.method === 'GET') {
      if (u.includes('/api/sessions')) return json(sessions);
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
    return json({ ok: true, id: 'sess-a' });
  };
  window.marked = { parse: (s) => String(s || ''), setOptions: () => {}, use: () => {} };
  dom.window.eval(appJs);

  await sleep(300); // initial loadSessions + auto-open first session

  const $ = (sel) => window.document.querySelector(sel);
  const $$ = (sel) => [...window.document.querySelectorAll(sel)];
  const clickSession = (id) => {
    // Title mutates to the first user message after the first persist, so
    // match ANY of the titles this session can carry over the run.
    const needles = id === 'sess-a'
      ? ['Alpha', 'check memory', 'timer regression check', 'hi from A']
      : ['Beta', 'yo from B'];
    const item = $$('.session-item').find((el) => {
      const txt = el.textContent || '';
      return needles.some((n) => txt.includes(n));
    });
    if (!item) return false;
    item.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    return true;
  };
  const indicatorFor = (id) => {
    const item = $$('.session-item').find((el) => (el.textContent || '').includes(id === 'sess-a' ? 'Alpha' : 'Beta'));
    return item ? item.querySelector('.session-processing-indicator') : null;
  };

  // --- 1) start a stream in session A --------------------------------------
  t('setup: session A is open', (window.document.querySelector('#messages .msg')?.textContent || '').includes('hi from A'));
  const promptInput = $('#promptInput');
  promptInput.value = 'check memory';
  $('#sendBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(120);
  t('start: POST /api/chat carries the sessionId (registry key)', started && chatBody.sessionId === 'sess-a', JSON.stringify(chatBody));

  // stream: status -> tool record -> content chunks (stream stays OPEN)
  streamCtrl.enqueue(sse({ type: 'status', message: '⚙ Running command: free -h' }));
  streamCtrl.enqueue(sse({ type: 'tool', tool: 'run_shell', args: '{"command":"free -h"}', ok: true, skipped: false, code: 0, out: 'Mem: 8G', ts: Date.now() }));
  await sleep(120);
  t('start: sidebar pulse indicator appears for session A', !!indicatorFor('sess-a'));
  t('start: stop button is active (streaming)', $('#sendBtn').classList.contains('stop-active'));

  streamCtrl.enqueue(sse({ choices: [{ delta: { content: 'Alpha reply ' } }] }));
  streamCtrl.enqueue(sse({ choices: [{ delta: { content: 'part one' } }] }));
  await sleep(150);
  t('start: live text visible while streaming', ($('#messages .agent-content')?.textContent || '').replace(/\s+/g, ' ').includes('Alpha reply part one'));

  // --- 2) switch away to B, then back to A ----------------------------------
  t('switch: clicked session B', clickSession('sess-b'));
  await sleep(120);
  t('switch: view shows B', ($('#messages .msg')?.textContent || '').includes('yo from B'));
  t('switch: A still shows the pulse indicator (background turn)', !!indicatorFor('sess-a'));
  t('switch: B has NO indicator', !indicatorFor('sess-b'));

  // A's stream keeps buffering while away (view guard in handleData)
  streamCtrl.enqueue(sse({ type: 'status', message: '⚙ df -h' }));
  streamCtrl.enqueue(sse({ choices: [{ delta: { content: ' while away' } }] }));
  await sleep(120);

  t('back: clicked session A again', clickSession('sess-a'));
  await sleep(150); // reattach replay
  const backText = $('#messages .agent-content')?.textContent || '';
  t('back: RE-ATTACHED — buffered text replayed (no freeze)', backText.replace(/\s+/g, ' ').includes('Alpha reply part one while away'), backText.slice(0, 120));
  t('back: buffered status lines replayed', $('#messages .tool-line') !== null, ($('#messages')?.textContent || '').slice(0, 80));
  t('back: tool-step card replayed from the session record', !!$('#messages .tool-step'), '');
  t('back: stop button restored (stream still live)', $('#sendBtn').classList.contains('stop-active'));
  t('back: gen timer visible (restored from turn start)', !$('#genTimer').classList.contains('hidden'));

  // --- 3) live proof: chunks STILL land after re-attach ---------------------
  streamCtrl.enqueue(sse({ choices: [{ delta: { content: ' AND LIVE' } }] }));
  let liveText = '';
  for (let i = 0; i < 20 && !/[A-Za-z] AND LIVE/.test(liveText); i++) {
    await sleep(60);
    liveText = $('#messages .agent-content')?.textContent || '';
  }
  t('live: subsequent chunks render in the re-attached bubble', liveText.replace(/\s+/g, ' ').includes('while away AND LIVE'), liveText.slice(0, 120));

  // --- 4) completion: pulse off, persist to the RIGHT session --------------
  streamCtrl.enqueue(enc.encode('data: [DONE]\n\n'));
  streamCtrl.close();
  await sleep(400); // finalization + persistSession

  t('done: indicator cleared after completion', !indicatorFor('sess-a'));
  t('done: stop button back to send mode', !$('#sendBtn').classList.contains('stop-active'));

  const aPersist = persistedPosts.find((p) => p.id === 'sess-a');
  t('done: session A persisted with the full assistant reply', !!aPersist && aPersist.messages.some((m) => m.role === 'assistant' && (m.content || '').includes('Alpha reply part one while away AND LIVE')), JSON.stringify((aPersist || {}).messages).slice(0, 150));
  t('done: tool record persisted in A (mid-stream, while viewing B)', !!aPersist && aPersist.messages.some((m) => m.role === 'tool' && m.tool === 'run_shell'), '');
  const bPersist = persistedPosts.find((p) => p.id === 'sess-b');
  t('CORRUPTION GUARD: B never received A\'s assistant/tool records', !bPersist || !bPersist.messages.some((m) => m.role === 'assistant' || m.role === 'tool'), JSON.stringify((bPersist || {}).messages));

  // --- 5) THE TIMER REGRESSION: completion while viewing ANOTHER session -----
  // Repro of the reported bug: the ⏱ footer pill kept counting forever when
  // a turn completed while the user was looking at a different session
  // (the old finally only stopped the timer when sid === state.currentId).
  promptInput.value = 'timer regression check';
  $('#sendBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(120);
  t('timer: pill visible while the new turn streams', !$('#genTimer').classList.contains('hidden'));
  t('timer: pill shows the live ⏱ format', ($('#genTimer').textContent || '').startsWith('⏱'), $('#genTimer').textContent);

  streamCtrl.enqueue(sse({ choices: [{ delta: { content: 'quiet reply ' } }] }));
  await sleep(100);
  t('timer: switched to B mid-turn', clickSession('sess-b'));
  await sleep(120);
  t('timer: pill KEEPS counting while B is viewed (agent still busy)', !$('#genTimer').classList.contains('hidden'));

  // complete A's stream while the user is looking at B — the reported bug
  streamCtrl.enqueue(sse({ choices: [{ delta: { content: 'done.' } }] }));
  streamCtrl.enqueue(sse({ usage: { prompt_tokens: 10, completion_tokens: 10 } }));
  streamCtrl.close();
  await sleep(400); // finalization + persistSession
  t('timer: pill HIDDEN after A\'s background turn completes', $('#genTimer').classList.contains('hidden'), $('#genTimer').textContent);

  t('timer: switched back to session A', clickSession('sess-a'));
  await sleep(150);
  t('timer: pill stays hidden on the finished session (idle, no zombie)', $('#genTimer').classList.contains('hidden'), $('#genTimer').textContent);
  t('timer: send button back to send mode after background completion', !$('#sendBtn').classList.contains('stop-active'));

  const fails = results.filter((x) => x.startsWith('FAIL')).length;
  console.log(results.join('\n'));
  console.log(`\n${results.length - fails}/${results.length} ui-stream-reattach checks passed${fails ? ` (${fails} FAILED)` : ''}`);
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});