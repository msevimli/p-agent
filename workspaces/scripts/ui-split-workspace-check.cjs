#!/usr/bin/env node
/**
 * ui-split-workspace-check.cjs — jsdom harness for the split workspace.
 *
 * Drives the REAL index.html + app.js with a stateful fetch mock:
 *  - boot: chat fills the main area, tool pane + divider hidden,
 *  - header toggle enters split (chat left, File Explorer right),
 *  - sidebar Tools clicks swap the pane's tool without touching chat,
 *  - tool interaction (memory add/delete) works while the chat stays put,
 *  - the pane switcher select swaps tools,
 *  - the divider drag resizes (clamped) and persists to localStorage,
 *  - swap-sides flips the row, close returns to the pre-split view,
 *  - single-pane navigation still works after the split is closed,
 *  - session clicks in split mode keep the split shape.
 *
 * Run: NODE_PATH=/home/hermesai/.hermes/hermes-agent/node_modules \
 *        node workspaces/scripts/ui-split-workspace-check.cjs
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

(async () => {
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:8888/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  if (!window.TextDecoder) { window.TextDecoder = global.TextDecoder; window.TextEncoder = global.TextEncoder; }
  if (!window.ReadableStream) window.ReadableStream = global.ReadableStream;
  if (!window.AbortController) window.AbortController = global.AbortController;

  // ---- stateful mock store ------------------------------------------------
  const fsEntries = [
    { name: 'hello.txt', path: 'hello.txt', type: 'file' },
    { name: 'sub', path: 'sub', type: 'directory' },
  ];
  let facts = [
    { id: 'f-1', category: 'preference', fact: 'the user prefers TypeScript', created_at: 1 },
    { id: 'f-2', category: 'personal', fact: 'the user likes dark chocolate', created_at: 2 },
  ];
  let workspaceContent = '# Project notes\n- docker based';
  const posts = [];
  window.fetch = async (url, opts) => {
    const u = String(url);
    const json = (obj, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => obj, headers: { get: () => null } });
    if (u.includes('/api/memory/workspace')) {
      if (opts && opts.method === 'PUT') { workspaceContent = JSON.parse(opts.body).content; return json({ ok: true, bytes: workspaceContent.length, saved: true }); }
      if (opts && opts.method === 'DELETE') { workspaceContent = ''; return json({ ok: true, cleared: true }); }
      return json({ ok: true, exists: workspaceContent !== '', bytes: workspaceContent.length, content: workspaceContent });
    }
    if (u.includes('/api/memory')) {
      if (opts && opts.method === 'POST') {
        const body = JSON.parse(opts.body);
        posts.push(body);
        facts.unshift({ id: `f-${facts.length + 1}`, category: body.category || '', fact: body.fact, created_at: Date.now() });
        return json({ ok: true, fact: facts[0] }, 201);
      }
      if (opts && opts.method === 'DELETE') {
        const id = decodeURIComponent(u.split('/api/memory/')[1] || '');
        facts = facts.filter((f) => f.id !== id);
        return json({ ok: true, deleted: true, id });
      }
      return json({ ok: true, count: facts.length, facts });
    }
    if (u.includes('/api/fs/list')) return json({ ok: true, entries: fsEntries });
    if (u.includes('/api/sessions')) return json([{ id: 's1', title: 'Test session', messages: [], usage: null }]);
    if (u.includes('/api/chat/state/')) return json({ ok: false, active: false }, 404);
    if (u.includes('/api/health')) return json({ server: { up: true, port: 8888 }, llama: { up: true }, contextWindow: 500000 });
    if (u.includes('/api/models/status')) return json({ ok: true, models: [], active: null });
    if (u.includes('/api/models')) return json({ ok: true, active: 'm1', models: [
      { id: 'm1', name: 'Test Model', endpoint: 'https://example.com/v1', model: 'm1', provider: 'remote', category: 'cloud', contextLength: 8192, hasKey: true, active: true, status: 'online', templateId: '' },
    ], cascade: { enabled: false, escalate: 'marker', router: null, primary: null } });
    if (u.includes('/api/skills')) return json({ ok: true, skills: [{ name: 'demo', description: 'a demo skill', enabled: true, version: '1.0.0', files: 1 }] });
    if (u.includes('/api/automations')) return json({ ok: true, automations: [], paused: false });
    if (u.includes('/api/system/prompt')) return json({ ok: true, prompt: 'default prompt' });
    if (u.includes('/api/system/metrics')) return json({ cpu: 0, ram: 0 });
    if (u.includes('/api/templates')) return json({ ok: true, templates: [] });
    if (u.includes('/api/channels')) return json({ ok: true, channels: [] });
    if (u.includes('/api/queue')) return json({ queue: [] });
    return json({ ok: true });
  };
  window.marked = { parse: (s) => String(s || ''), setOptions: () => {}, use: () => {} };
  window.confirm = () => true;
  dom.window.eval(appJs);
  await sleep(450); // boot settle

  const $ = (sel) => window.document.querySelector(sel);
  const $$ = (sel) => [...window.document.querySelectorAll(sel)];
  const visible = (el) => !!el && !el.classList.contains('hidden');
  const hidden = (el) => !el || el.classList.contains('hidden');
  const click = (el) => el && el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const settled = () => sleep(320);

  // ---- 1) boot: single-pane chat ------------------------------------------
  t('boot: chat pane fills the main area', visible($('#chatPane')) && visible($('#chatView')), '');
  t('boot: tool pane + divider + header hidden', hidden($('#toolPane')) && hidden($('#splitDivider')) && hidden($('#splitToolHeader')), '');
  t('boot: no split-active class', !$('#splitRoot').classList.contains('split-active'), '');

  // ---- 2) enter split: chat left, File Explorer right ---------------------
  click($('#splitToggleBtn'));
  await settled();
  t('split: toggle button has active styling', $('#splitToggleBtn').classList.contains('active'), '');
  t('split: both panes + divider + header visible', visible($('#chatPane')) && visible($('#toolPane')) && visible($('#splitDivider')) && visible($('#splitToolHeader')), '');
  t('split: splitRoot carries split-active', $('#splitRoot').classList.contains('split-active'), '');
  t('split: chat still visible (not wiped)', visible($('#chatView')), '');
  t('split: File Explorer loaded in the pane', visible($('#fileExplorerView')) && ($('#fsList').textContent || '').includes('hello.txt'), ($('#fsList').textContent || '').slice(0, 60));
  t('split: other tools hidden', hidden($('#memoryView')) && hidden($('#modelsView')), '');
  t('split: pane header shows File Explorer', $('#splitToolName').textContent === 'File Explorer' && $('#splitToolSwitcher').value === 'files', $('#splitToolName').textContent);
  t('split: header subtitle = Chat · File Explorer', $('#headerSub').textContent === 'Local AI Agent · File Explorer', $('#headerSub').textContent);
  t('split: sidebar nav active on File Explorer', $('#fileExplorerBtn').classList.contains('active'), '');

  // ---- 3) chat independence: typing must not disturb the tool pane ---------
  $('#promptInput').value = 'hello from the chat pane';
  $('#promptInput').dispatchEvent(new window.Event('input', { bubbles: true }));
  await settled();
  t('split: typing in chat leaves the tool pane alone', visible($('#fileExplorerView')) && ($('#fsList').textContent || '').includes('hello.txt'), '');
  t('split: prompt text retained', $('#promptInput').value === 'hello from the chat pane', $('#promptInput').value);

  // ---- 4) sidebar tool click swaps the pane, chat untouched ---------------
  click($('#memoryBtn'));
  await settled();
  t('split: Memory swaps into the pane', visible($('#memoryView')) && hidden($('#fileExplorerView')), '');
  t('split: chat pane still visible with prompt intact', visible($('#chatView')) && $('#promptInput').value === 'hello from the chat pane', '');
  t('split: memory facts loaded in the pane', $$('#memFactsList .memory-fact-row').length === 2, $$('#memFactsList .memory-fact-row').length);
  t('split: nav active follows the pane tool', $('#memoryBtn').classList.contains('active') && !$('#fileExplorerBtn').classList.contains('active'), '');

  // tool interaction inside the pane (add + delete a fact)
  $('#memAddFact').value = 'split panes keep their own state';
  click($('#memAddBtn'));
  await settled();
  t('split: adding a memory fact works inside the pane', $$('#memFactsList .memory-fact-row').length === 3 && posts.length === 1, $$('#memFactsList .memory-fact-row').length);
  t('split: chat still intact after tool edit', $('#promptInput').value === 'hello from the chat pane', '');
  const delBtn = $$('#memFactsList .memory-del').find((b) => b.getAttribute('data-mem-del') === 'f-2');
  click(delBtn);
  await settled();
  t('split: deleting a fact works inside the pane', $$('#memFactsList .memory-fact-row').length === 2 && !($('#memFactsList').textContent || '').includes('chocolate'), '');

  // ---- 5) switcher select --------------------------------------------------
  $('#splitToolSwitcher').value = 'models';
  $('#splitToolSwitcher').dispatchEvent(new window.Event('change', { bubbles: true }));
  await settled();
  t('switcher: Models opens in the pane', visible($('#modelsView')) && hidden($('#memoryView')), '');
  t('switcher: chat pane untouched', visible($('#chatView')), '');
  t('switcher: model card rendered from the mock', ($('#modelsList').textContent || '').includes('Test Model'), ($('#modelsList').textContent || '').slice(0, 60));

  // ---- 6) divider drag ------------------------------------------------------
  const splitRoot = $('#splitRoot');
  splitRoot.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1200, height: 800, right: 1200, bottom: 800, x: 0, y: 0, toJSON: () => ({}) });
  Object.defineProperty(splitRoot, 'clientWidth', { configurable: true, value: 1200 });
  const divider = $('#splitDivider');
  const pd = (type, x) => divider.dispatchEvent(new window.PointerEvent(type, { bubbles: true, pointerId: 1, clientX: x }));
  pd('pointerdown', 400);
  t('drag: body + root get dragging state', window.document.body.classList.contains('split-dragging') && splitRoot.classList.contains('resizing'), '');
  pd('pointermove', 800);
  pd('pointerup', 800);
  t('drag: chat width follows the pointer (800px)', splitRoot.style.getPropertyValue('--split-chat-w') === '800px', splitRoot.style.getPropertyValue('--split-chat-w'));
  t('drag: width persisted to localStorage', window.localStorage.getItem('pagent.splitChatPx') === '800', window.localStorage.getItem('pagent.splitChatPx'));
  t('drag: dragging state cleared', !window.document.body.classList.contains('split-dragging'), '');
  pd('pointerdown', 800);
  pd('pointermove', 30); // left edge — must clamp to the 300px minimum
  pd('pointerup', 30);
  t('drag: width clamps at the chat minimum', splitRoot.style.getPropertyValue('--split-chat-w') === '300px', splitRoot.style.getPropertyValue('--split-chat-w'));

  // ---- 7) swap sides --------------------------------------------------------
  click($('#splitSwapBtn'));
  t('swap: splitRoot flipped (row-reverse)', splitRoot.classList.contains('split-swapped'), '');
  t('swap: preference persisted', window.localStorage.getItem('pagent.splitSwapped') === '1', window.localStorage.getItem('pagent.splitSwapped'));

  // ---- 8) session click keeps the split ------------------------------------
  const sItem = $('.session-item');
  t('sessions: session row present from the mock', !!sItem, '');
  click(sItem);
  await settled();
  t('sessions: split still active after switching sessions', splitRoot.classList.contains('split-active') && visible($('#toolPane')), '');
  t('sessions: tool pane content kept', visible($('#modelsView')), '');

  // ---- 9) close split -> single-pane chat -----------------------------------
  click($('#splitCloseBtn'));
  await settled();
  t('close: split gone, chat back full width', !splitRoot.classList.contains('split-active') && visible($('#chatPane')) && hidden($('#toolPane')) && hidden($('#splitDivider')) && hidden($('#splitToolHeader')), '');
  t('close: toggle button no longer active', !$('#splitToggleBtn').classList.contains('active'), '');
  t('close: header subtitle restored', $('#headerSub').textContent === 'Local AI Agent', $('#headerSub').textContent);
  t('close: models view hidden again', hidden($('#modelsView')), '');

  // ---- 10) open split FROM a tool view; close returns there ----------------
  click($('#modelsBtn'));
  await settled();
  t('single: Models fills the main area alone', visible($('#modelsView')) && hidden($('#chatPane')) && visible($('#toolPane')), '');
  click($('#splitToggleBtn'));
  await settled();
  t('single->split: chat returns alongside Models', visible($('#chatView')) && visible($('#modelsView')), '');
  t('single->split: pane header shows Models', $('#splitToolName').textContent === 'Models', $('#splitToolName').textContent);
  click($('#splitCloseBtn'));
  await settled();
  t('single<-close: returns to single-pane Models', hidden($('#chatPane')) && visible($('#toolPane')) && visible($('#modelsView')) && !splitRoot.classList.contains('split-active'), '');
  click($('#modelsBackChat'));
  await settled();
  t('single: back-to-chat works in single pane', visible($('#chatPane')) && hidden($('#modelsView')), '');

  // ---- 11) single-pane memory still works (regression) ----------------------
  click($('#memoryBtn'));
  await settled();
  t('reg: single-pane Memory opens (old flow intact)', visible($('#memoryView')) && hidden($('#chatPane')), '');
  click($('#memoryBackChat'));
  await settled();
  t('reg: back to chat', visible($('#chatView')) && !visible($('#memoryView')), '');

  // ---- 12) re-enter after persisted swap: row-reverse restored --------------
  click($('#splitToggleBtn'));
  await settled();
  t('re-enter: persisted swap applied on boot into split', splitRoot.classList.contains('split-swapped'), '');
  t('re-enter: persisted chat width applied (300px clamp)', splitRoot.style.getPropertyValue('--split-chat-w') === '300px', splitRoot.style.getPropertyValue('--split-chat-w'));
  click($('#splitToggleBtn'));
  await settled();
  t('re-enter: toggle closes again', !splitRoot.classList.contains('split-active'), '');

  const fails = results.filter((r) => r.startsWith('FAIL'));
  console.log(results.join('\n'));
  console.log(`\n${fails.length === 0 ? 'ALL' : fails.length + ' FAILED of'} ${results.length} split-workspace checks passed`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});