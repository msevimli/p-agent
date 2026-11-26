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
  let deletes = [];
  let lastNavigate = null;
  let reloads = 0;
  let stateCalls = 0;
  let shotCalls = 0;
  const inputs = [];
  const viewportCalls = [];
  let sessionState = { id: 'b1', url: QT_URL, title: 'Chart', pageErrors: ['boom'], requestFailures: ['HTTP 404 /x'], console: ['[error] net::ERR'] };
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
      return Promise.resolve(json({ ok: true, session: sessionState }));
    }
    if (method === 'GET' && u.endsWith('/api/browser/session/b9')) {
      return Promise.resolve(json({ ok: true, session: { id: 'b9', url: QT_URL, title: 'Agent Session' } }));
    }
    const mInput = u.match(/\/api\/browser\/session\/([^/]+)\/input$/);
    if (method === 'POST' && mInput) { inputs.push(JSON.parse(opts.body)); return Promise.resolve(json({ ok: true })); }
    const mVp = u.match(/\/api\/browser\/session\/([^/]+)\/viewport$/);
    if (method === 'POST' && mVp) { viewportCalls.push(JSON.parse(opts.body)); return Promise.resolve(json({ ok: true, viewport: JSON.parse(opts.body) })); }
    if (method === 'POST' && u.endsWith('/api/browser/session/b1/navigate')) {
      lastNavigate = JSON.parse(opts.body).url;
      return Promise.resolve(json({ ok: true }));
    }
    if (method === 'POST' && u.endsWith('/api/browser/session/b1/reload')) { reloads++; return Promise.resolve(json({ ok: true })); }
    const mDel = u.match(/\/api\/browser\/session\/([^/]+)$/);
    if (method === 'DELETE' && mDel) { deletes.push(mDel[1]); return Promise.resolve(json({ ok: true, closed: mDel[1] })); }
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
  t('close: session deleted', deletes.length === 1 && deletes[0] === 'b1', `deletes=${deletes.join(',')}`);
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

  // ---- auto-open: agent browser_* tool steps open + sync the pane --------
  {
    existing = false; // no sessions yet -> the pane must CREATE one for the tool
    window.dispatchEvent(new window.CustomEvent('pagent:browser-tool', {
      detail: { type: 'tool', tool: 'browser_open', args: { url: QT_URL }, ok: true },
    }));
    await sleep(100);
    t('auto-open: browser_open tool step opens the hidden pane', !$('#browserPane').classList.contains('hidden') && $('#chatView').classList.contains('browser-split'));
    t('auto-open: URL field synced to the tool target', $('#browserUrl').value === QT_URL, $('#browserUrl').value);
    t('auto-open: session created for the tool', createCalls === 2, `createCalls=${createCalls}`);
    // a later step while the pane is already open only syncs the URL
    window.dispatchEvent(new window.CustomEvent('pagent:browser-tool', {
      detail: { type: 'tool', tool: 'browser_navigate', args: { url: QT_URL + '/chart' }, ok: true },
    }));
    await sleep(60);
    t('auto-open: open pane syncs URL from later steps', $('#browserUrl').value === QT_URL + '/chart', $('#browserUrl').value);
    // non-browser tools must never touch the pane
    window.dispatchEvent(new window.CustomEvent('pagent:browser-tool', {
      detail: { type: 'tool', tool: 'run_shell', args: {}, ok: true },
    }));
    await sleep(60);
    t('auto-open: non-browser tools leave the pane alone', !$('#browserPane').classList.contains('hidden') && $('#browserUrl').value === QT_URL + '/chart');
    $('#browserClose').click();
    await sleep(60);
    t('auto-open: close tears the tool session down', deletes.includes('b1'), deletes.join(','));
  }
  {
    // an agent step carrying an explicit sessionId attaches WITHOUT creating
    existing = false;
    window.dispatchEvent(new window.CustomEvent('pagent:browser-tool', {
      detail: { type: 'tool', tool: 'browser_navigate', args: { url: QT_URL, sessionId: 'b9' }, ok: true },
    }));
    await sleep(100);
    t('auto-open: explicit sessionId attaches the agent session', !$('#browserPane').classList.contains('hidden') && ($('#browserStatus').textContent || '').includes('Agent Session'), `status=${$('#browserStatus').textContent}`);
    t('auto-open: no new session created for attach', createCalls === 2, `createCalls=${createCalls}`);
    $('#browserClose').click();
    await sleep(60);
    t('auto-open: attached agent session closed cleanly', deletes.includes('b9'), deletes.join(','));
  }

  // ---- interactive layer: pointer + keyboard forwarding ------------------
  {
    existing = true;
    $('#browserBtn').click();
    await sleep(100);
    t('interact: pane open against the existing session', !$('#browserPane').classList.contains('hidden'));
    const img = $('#browserFrame');
    img.dispatchEvent(new window.MouseEvent('mousedown', { clientX: 120, clientY: 80, button: 0, bubbles: true }));
    img.dispatchEvent(new window.MouseEvent('mousemove', { clientX: 320, clientY: 180, button: 0, bubbles: true }));
    img.dispatchEvent(new window.MouseEvent('mouseup', { clientX: 320, clientY: 180, button: 0, bubbles: true }));
    await sleep(150);
    const evs = inputs.slice(-4);
    t('interact: pointer down/move/up forwarded with viewport coords',
      evs[0] && evs[0].type === 'down' && evs[0].x === 120 && evs[0].y === 80 && evs[0].button === 'left' &&
      evs.some((e) => e.type === 'move' && e.x === 320 && e.y === 180) &&
      evs[evs.length - 1].type === 'up' && evs[evs.length - 1].x === 320 && evs[evs.length - 1].y === 180,
      JSON.stringify(evs));
    img.dispatchEvent(new window.MouseEvent('mousedown', { clientX: 50, clientY: 50, button: 2, bubbles: true }));
    img.dispatchEvent(new window.MouseEvent('mouseup', { clientX: 50, clientY: 50, button: 2, bubbles: true }));
    await sleep(120);
    const rb = inputs.slice(-2);
    t('interact: right button mapped to "right"', rb.length === 2 && rb[0].button === 'right' && rb[1].button === 'right', JSON.stringify(rb));
    img.dispatchEvent(new window.WheelEvent('wheel', { deltaX: 0, deltaY: 240, bubbles: true, cancelable: true }));
    await sleep(120);
    t('interact: wheel forwarded as deltaY', inputs[inputs.length - 1] && inputs[inputs.length - 1].type === 'wheel' && inputs[inputs.length - 1].deltaY === 240, JSON.stringify(inputs[inputs.length - 1]));
    const pane = $('#browserPane');
    pane.focus();
    pane.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    pane.dispatchEvent(new window.KeyboardEvent('keyup', { key: 'Enter', bubbles: true, cancelable: true }));
    await sleep(120);
    const keys = inputs.slice(-2);
    t('interact: Enter forwarded as keydown+keyup', keys.length === 2 && keys[0].type === 'keydown' && keys[0].key === 'Enter' && keys[1].type === 'keyup' && keys[1].key === 'Enter', JSON.stringify(keys));
    pane.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true }));
    pane.dispatchEvent(new window.KeyboardEvent('keyup', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true }));
    await sleep(120);
    const sc = inputs.slice(-2);
    t('interact: Ctrl+A shortcut carries modifiers', sc[0] && sc[0].type === 'keydown' && sc[0].key === 'a' && Array.isArray(sc[0].modifiers) && sc[0].modifiers.includes('Control'), JSON.stringify(sc[0]));
    const beforeUrl = inputs.length;
    $('#browserUrl').value = 'http://localhost:3777/via-enter';
    $('#browserUrl').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true }));
    $('#browserUrl').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await sleep(120);
    t('interact: typing in the URL field is NOT forwarded', inputs.length === beforeUrl, `inputs=${inputs.length}`);
    t('interact: Enter in the URL field navigates', lastNavigate === 'http://localhost:3777/via-enter', String(lastNavigate));
  }

  // ---- viewport sync: the pane size drives the headless viewport ---------
  {
    const body = $('#browserPane').querySelector('.br-body');
    Object.defineProperty(body, 'clientWidth', { value: 900, configurable: true });
    Object.defineProperty(body, 'clientHeight', { value: 500, configurable: true });
    const before = viewportCalls.length;
    window.dispatchEvent(new window.Event('resize'));
    await sleep(150);
    t('viewport: pane size pushed to the session (fills 1:1)', viewportCalls.length === before + 1 && viewportCalls[before].width === 900 && viewportCalls[before].height === 500, JSON.stringify(viewportCalls.slice(before)));
  }

  // ---- live URL sync from polling (never clobbers typing) ----------------
  {
    sessionState.url = QT_URL + '/chart';
    $('#browserReload').click();
    await sleep(120);
    t('sync: polling reflects the session URL in the field', $('#browserUrl').value === QT_URL + '/chart', $('#browserUrl').value);
    $('#browserUrl').value = 'http://127.0.0.1:3777/manual';
    $('#browserUrl').dispatchEvent(new window.Event('input', { bubbles: true }));
    sessionState.url = QT_URL + '/other';
    $('#browserReload').click();
    await sleep(120);
    t('sync: user-edited URL is not clobbered by polling', $('#browserUrl').value === 'http://127.0.0.1:3777/manual', $('#browserUrl').value);
  }

  // ---- interaction hint --------------------------------------------------
  {
    const hint = $('#browserHint');
    t('hint: visible while waiting for the first frame', !!hint && !hint.classList.contains('hidden'));
    $('#browserFrame').dispatchEvent(new window.Event('load'));
    t('hint: hides after the first screenshot arrives', hint.classList.contains('hidden'));
  }

  // ---- full-bleed layout (file-level CSS assertions) ---------------------
  {
    const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'styles.css'), 'utf8');
    const bodyRule = css.match(/\.br-body\s*\{([^}]*)\}/s);
    const frameRule = css.match(/\.br-frame\s*\{([^}]*)\}/s);
    t('css: pane body is relative + overflow hidden (no centering)', !!bodyRule && /position:\s*relative/.test(bodyRule[1]) && /overflow:\s*hidden/.test(bodyRule[1]));
    t('css: frame fills the pane edge-to-edge (no letterboxing)', !!frameRule && /position:\s*absolute/.test(frameRule[1]) && /inset:\s*0/.test(frameRule[1]) && /width:\s*100%/.test(frameRule[1]) && /height:\s*100%/.test(frameRule[1]) && /object-fit:\s*fill/.test(frameRule[1]), frameRule && frameRule[1].trim());
    t('css: no contain letterboxing remains', !/object-fit:\s*contain/.test(css));
    $('#browserClose').click();
    await sleep(60);
  }

  const fails = results.filter((r) => r.startsWith('FAIL')).length;
  console.log(results.join('\n'));
  console.log(fails === 0 ? `\nALL ${results.length} PASSED` : `\n${fails} FAIL of ${results.length}`);
  process.exit(fails === 0 ? 0 : 1);
})();