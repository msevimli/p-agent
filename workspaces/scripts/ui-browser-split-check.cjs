#!/usr/bin/env node
/**
 * ui-browser-split-check.cjs — jsdom smoke for the split-screen Browser pane.
 *
 * Loads the real index.html + app.js with a stubbed fetch and drives the
 * flow: Browser tool button -> right pane opens beside the chat (chatView
 * gains .browser-split) -> session created against the QT default URL ->
 * live screenshot polling starts -> Go (navigate) / Reload / Close ->
 * single-pane chat is restored and polling stops. Also covers attaching to
 * an existing session (e.g. one created by the agent).
 *
 * Run: NODE_PATH=/home/hermesai/.hermes/hermes-agent/node_modules \
 *        node workspaces/scripts/ui-browser-split-check.cjs
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

const QT_URL = 'http://127.0.0.1:3777';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const dom = new JSDOM(html, {
    url: 'http://127.0.0.1:8888/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const $ = (sel) => window.document.querySelector(sel);

  // --- fetch stub ----------------------------------------------------------
  let existing = false;       // when true, sessions list returns one session
  let createCalls = 0;
  let deletes = 0;
  let lastNavigate = null;
  let reloads = 0;
  let stateCalls = 0;
  let shotCalls = 0;
  const json = (obj) => ({ ok: true, status: 200, json: async () => obj });
  window.fetch = (url, opts) => {
    const method = (opts && opts.method) || 'GET';
    const u = String(url);
    if (method === 'GET' && u.endsWith('/api/browser/sessions')) {
      return Promise.resolve(json({ ok: true, sessions: existing ? [{ id: 'b1', url: QT_URL, title: 'Chart' }] : [] }));
    }
    if (method === 'POST' && u.endsWith('/api/browser/session')) {
      createCalls++;
      return Promise.resolve(json({ ok: true, session: { id: 'b1', url: JSON.parse(opts.body).url, title: 'Chart' } }));
    }
    if (method === 'GET' && u.includes('/api/browser/session/b1/screenshot.png')) { shotCalls++; return Promise.resolve({ ok: true, status: 200 }); }
    if (method === 'GET' && u.endsWith('/api/browser/session/b1')) {
      stateCalls++;
      return Promise.resolve(json({ ok: true, session: { id: 'b1', url: QT_URL + '/', title: 'Chart', pageErrors: ['boom'], requestFailures: ['HTTP 404 /x'], console: ['[error] net::ERR'] } }));
    }
    if (method === 'POST' && u.endsWith('/api/browser/session/b1/navigate')) {
      lastNavigate = JSON.parse(opts.body).url;
      return Promise.resolve(json({ ok: true }));
    }
    if (method === 'POST' && u.endsWith('/api/browser/session/b1/reload')) { reloads++; return Promise.resolve(json({ ok: true })); }
    if (method === 'DELETE' && u.endsWith('/api/browser/session/b1')) { deletes++; return Promise.resolve(json({ ok: true, closed: 'b1' })); }
    // generic boot-time endpoints (mirrors the file-editor harness)
    if (!method || method === 'GET') {
      if (u.includes('/api/sessions')) return Promise.resolve(json([]));
      if (u.includes('/api/models')) return Promise.resolve(json({ models: [], cascade: null }));
      if (u.includes('/api/skills')) return Promise.resolve(json({ skills: [] }));
      if (u.includes('/api/automations')) return Promise.resolve(json({ automations: [], paused: false }));
      if (u.includes('/api/system/prompt')) return Promise.resolve(json({ prompt: '' }));
      if (u.includes('/api/system/metrics')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ cpu: 0, ram: 0 }) });
      if (u.includes('/api/library')) return Promise.resolve(json({ files: [] }));
      if (u.includes('/api/templates')) return Promise.resolve(json({ templates: [] }));
      if (u.includes('/api/channels')) return Promise.resolve(json({ channels: [] }));
      if (u.includes('/api/queue')) return Promise.resolve(json({ queue: [] }));
    }
    return Promise.resolve(json({ ok: true }));
  };

  // --- boot stubs + eval (mirrors ui-file-editor-check.cjs) -----------------
  window.marked = { parse: (s) => String(s || ''), setOptions: () => {}, use: () => {} };
  window.hljs = { highlightElement: () => {} };
  window.confirm = () => true;
  dom.window.eval(appJs);

  await sleep(400); // initial boot fetches resolve

  // --- nets -----------------------------------------------------------------
  t('markup: browser button exists', !!$('#browserBtn'));
  t('markup: pane exists and starts hidden', !!$('#browserPane') && $('#browserPane').classList.contains('hidden'));
  t('markup: chat starts single-pane (no browser-split)', !$('#chatView').classList.contains('browser-split'));
  t('markup: pane lives inside chatView (split sibling of #chatCol)', $('#browserPane').parentElement.id === 'chatView' && !!$('#chatCol'));

  // open the split view
  $('#browserBtn').click();
  await sleep(50);
  t('open: pane becomes visible', !$('#browserPane').classList.contains('hidden') && $('#browserPane').classList.contains('flex'));
  t('open: chatView switched to split layout', $('#chatView').classList.contains('browser-split'));
  t('open: sidebar button marked active', $('#browserBtn').classList.contains('active'));
  t('open: URL prefilled with QT default', $('#browserUrl').value === QT_URL);
  t('open: session created exactly once for default URL', createCalls === 1, `createCalls=${createCalls}`);
  t('open: state polling loop running (pollBrowser)', stateCalls >= 1, `stateCalls=${stateCalls}`);
  t('open: frame img targets the session screenshot endpoint', ($('#browserFrame').src || '').includes('/api/browser/session/b1/screenshot.png'), $('#browserFrame').src);
  t('open: status shows title + error tally', ($('#browserStatus').textContent || '').includes('Chart') && ($('#browserStatus').textContent || '').includes('3 errors'), $('#browserStatus').textContent);

  // navigate via Go
  $('#browserUrl').value = 'http://localhost:3777/chart';
  $('#browserGo').click();
  await sleep(50);
  t('navigate: POST navigate with new URL', lastNavigate === 'http://localhost:3777/chart', String(lastNavigate));

  // reload
  $('#browserReload').click();
  await sleep(30);
  t('reload: POST reload issued', reloads === 1, `reloads=${reloads}`);

  // close restores single-pane chat and tears the session down
  $('#browserClose').click();
  await sleep(50);
  t('close: session deleted', deletes === 1, `deletes=${deletes}`);
  t('close: pane hidden again', $('#browserPane').classList.contains('hidden'));
  t('close: chatView back to single pane', !$('#chatView').classList.contains('browser-split'));
  t('close: sidebar button un-marked', !$('#browserBtn').classList.contains('active'));
  t('close: status reset to idle', $('#browserStatus').textContent === 'idle');
  const shotsAtClose = shotCalls;
  const statesAtClose = stateCalls;
  await sleep(30);
  t('close: polling stopped (no further state fetches)', stateCalls === statesAtClose, `statesAtClose=${statesAtClose} stateCalls=${stateCalls}`);

  // reopen attaches to an existing session instead of creating one
  existing = true;
  $('#browserBtn').click();
  await sleep(50);
  t('reopen: attaches to existing session (no new create)', createCalls === 1 && !$('#browserPane').classList.contains('hidden'), `createCalls=${createCalls}`);
  $('#browserClose').click();
  await sleep(30);

  const fails = results.filter((r) => r.startsWith('FAIL')).length;
  console.log(results.join('\n'));
  console.log(fails === 0 ? `\nALL ${results.length} PASSED` : `\n${fails} FAIL of ${results.length}`);
  process.exit(fails === 0 ? 0 : 1);
})();