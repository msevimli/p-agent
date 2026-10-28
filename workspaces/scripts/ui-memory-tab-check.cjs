#!/usr/bin/env node
/**
 * ui-memory-tab-check.cjs — jsdom harness for the sidebar Memory tab.
 *
 * Drives the REAL index.html + app.js with a stateful /api/memory mock:
 *  - clicking the Memory tool opens the view (active nav, panel visible),
 *  - the global facts list renders (category chips + count),
 *  - semantic search hits GET /api/memory?q= via the debounce,
 *  - Add posts the fact, deletes call DELETE /api/memory/:id,
 *  - the workspace editor round-trips GET/PUT/DELETE /api/memory/workspace
 *    with save feedback,
 *  - failure paths render error banners instead of dying.
 *
 * Run: NODE_PATH=/home/hermesai/.hermes/hermes-agent/node_modules \
 *        node scripts/ui-memory-tab-check.cjs
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
  let facts = [
    { id: 'f-1', category: 'preference', fact: 'the user prefers TypeScript for backend projects', created_at: 1 },
    { id: 'f-2', category: 'personal', fact: 'the user enjoys dark chocolate with coffee', created_at: 2 },
  ];
  let workspaceContent = '# Project notes\n- The deployment is docker-based';
  let workspaceExists = true;
  const posts = []; // POST /api/memory bodies
  const puts = []; // PUT /api/memory/workspace bodies
  const deletes = []; // DELETE paths
  const searchQueries = []; // GET ?q= values

  window.fetch = async (url, opts) => {
    const u = String(url);
    const json = (obj, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => obj, headers: { get: () => null } });
    if (u.includes('/api/memory/workspace')) {
      if (opts && opts.method === 'PUT') {
        const body = JSON.parse(opts.body);
        puts.push(body);
        workspaceContent = body.content;
        workspaceExists = body.content !== '';
        return json({ ok: true, bytes: body.content.length, saved: true, path: 'MEMORY.md' });
      }
      if (opts && opts.method === 'DELETE') {
        deletes.push('workspace');
        workspaceContent = '';
        workspaceExists = false;
        return json({ ok: true, cleared: true });
      }
      return json({ ok: true, exists: workspaceExists, bytes: workspaceExists ? workspaceContent.length : 0, content: workspaceExists ? workspaceContent : '', truncated: false, path: 'MEMORY.md' });
    }
    if (u.includes('/api/memory')) {
      if (opts && opts.method === 'POST') {
        const body = JSON.parse(opts.body);
        posts.push(body);
        const fact = { id: `f-${facts.length + 1}`, category: body.category || '', fact: body.fact, created_at: Date.now() };
        facts.unshift(fact);
        return json({ ok: true, fact }, 201);
      }
      if (opts && opts.method === 'DELETE') {
        const id = decodeURIComponent(u.split('/api/memory/')[1] || '');
        deletes.push(id);
        facts = facts.filter((f) => f.id !== id);
        return json({ ok: true, deleted: true, id });
      }
      if (u.includes('q=')) {
        searchQueries.push(decodeURIComponent(u.split('q=')[1] || ''));
        const q = decodeURIComponent(u.split('q=')[1] || '');
        const hits = facts.filter((f) => f.fact.includes(q));
        return json({ ok: true, count: hits.length, facts: hits });
      }
      return json({ ok: true, count: facts.length, facts });
    }
    if (!opts || !opts.method || opts.method === 'GET') {
      if (u.includes('/api/sessions')) return json([]);
      if (u.includes('/api/health')) return json({ server: { up: true, port: 8888 }, llama: { up: true }, contextWindow: 500000 });
      if (u.includes('/api/chat/state/')) return json({ ok: false, active: false }, 404);
      if (u.includes('/api/models/status')) return json({ ok: true, models: [], active: null });
      if (u.includes('/api/models')) return json({ models: [], cascade: null });
      if (u.includes('/api/skills')) return json({ skills: [] });
      if (u.includes('/api/automations')) return json({ automations: [], paused: false });
      if (u.includes('/api/system/prompt')) return json({ prompt: '' });
      if (u.includes('/api/system/metrics')) return json({ cpu: 0, ram: 0 });
      if (u.includes('/api/templates')) return json({ templates: [] });
      if (u.includes('/api/channels')) return json({ channels: [] });
      if (u.includes('/api/queue')) return json({ queue: [] });
      return json({ ok: true });
    }
    return json({ ok: true });
  };
  window.marked = { parse: (s) => String(s || ''), setOptions: () => {}, use: () => {} };
  window.confirm = () => true;
  dom.window.eval(appJs);
  await sleep(400); // boot settle

  const $ = (sel) => window.document.querySelector(sel);
  const $$ = (sel) => [...window.document.querySelectorAll(sel)];
  const visible = (el) => !!el && !el.classList.contains('hidden');
  const click = (el) => el && el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  // ---- 1) tab opening -----------------------------------------------------
  t('tab: Memory button exists in the Tools sidebar', !!$('#memoryBtn'), '');
  click($('#memoryBtn'));
  await sleep(350);
  t('tab: clicking Memory opens the view + active nav', visible($('#memoryView')) && $('#memoryBtn').classList.contains('active'), '');
  t('tab: header shows the Memory title', ($('#headerSub') && $('#headerSub').textContent) === 'Memory', $('#headerSub') && $('#headerSub').textContent);
  t('tab: global facts list rendered both seeded facts', $$('#memFactsList .memory-fact-row').length === 2, $$('#memFactsList .memory-fact-row').length);
  t('tab: category chips rendered', $$('#memFactsList .memory-cat').some((c) => c.textContent === 'preference'), '');
  t('tab: fact count label', ($('#memCount').textContent || '').includes('2'), $('#memCount').textContent);
  t('tab: workspace editor prefilled from GET', $('#memWsEditor').value.includes('docker-based'), $('#memWsEditor').value.slice(0, 40));
  t('tab: workspace status shows bytes', ($('#memWsStatus').textContent || '').includes('bytes'), $('#memWsStatus').textContent);

  // ---- 2) semantic search --------------------------------------------------
  $('#memSearchInput').value = 'chocolate';
  $('#memSearchInput').dispatchEvent(new window.Event('input', { bubbles: true }));
  await sleep(450); // debounce 300ms + fetch
  t('search: GET ?q= fired with the query', searchQueries.length === 1 && searchQueries[0] === 'chocolate', JSON.stringify(searchQueries));
  t('search: list filtered to the chocolate fact', $$('#memFactsList .memory-fact-row').length === 1 && ($('#memFactsList').textContent || '').includes('chocolate'), '');
  t('search: clear button visible', !$('#memSearchClear').classList.contains('hidden'));
  click($('#memSearchClear'));
  await sleep(350);
  t('search: clear restores the full list', $$('#memFactsList .memory-fact-row').length === 2, $$('#memFactsList .memory-fact-row').length);

  // ---- 3) add fact ----------------------------------------------------------
  $('#memAddFact').value = 'the user prefers terse commit messages';
  $('#memAddCategory').value = 'style';
  click($('#memAddBtn'));
  await sleep(350);
  t('add: POST /api/memory carries fact + category', posts.length === 1 && posts[0].fact === 'the user prefers terse commit messages' && posts[0].category === 'style', JSON.stringify(posts));
  t('add: new fact rendered on top with its category chip', $$('#memFactsList .memory-fact-row').length === 3 && ($('#memFactsList').textContent || '').includes('commit'), '');
  t('add: inputs cleared after success', $('#memAddFact').value === '' && $('#memAddCategory').value === '', '');

  // ---- 4) delete fact --------------------------------------------------------
  const delBtn = $$('#memFactsList .memory-del').find((b) => b.getAttribute('data-mem-del') === 'f-2');
  t('delete: delete button present for f-2', !!delBtn, '');
  click(delBtn);
  await sleep(350);
  t('delete: DELETE /api/memory/:id fired', deletes.includes('f-2'), JSON.stringify(deletes));
  t('delete: fact row gone from the list', !($('#memFactsList').textContent || '').includes('dark chocolate'), ($('#memFactsList').textContent || '').slice(0, 80));

  // ---- 5) workspace editor -----------------------------------------------------
  $('#memWsEditor').value = '# Project notes\n- The deployment is docker-based\n- Builds run on the CI runner';
  click($('#memWsSave'));
  await sleep(350);
  t('ws: PUT /api/memory/workspace carries the edited content', puts.length === 1 && puts[0].content.includes('CI runner'), JSON.stringify(puts[0] && puts[0].content.slice(0, 60)));
  t('ws: save flash shown', !$('#memWsFlash').classList.contains('hidden') && ($('#memWsFlash').textContent || '').includes('Saved'), $('#memWsFlash').textContent);

  click($('#memWsClear'));
  await sleep(350);
  t('ws: DELETE /api/memory/workspace fired', deletes.includes('workspace'), JSON.stringify(deletes));
  t('ws: editor cleared and status reflects absence', $('#memWsEditor').value === '' && ($('#memWsStatus').textContent || '').includes('no MEMORY.md'), '');

  // ---- 6) failure path -----------------------------------------------------------
  const origFetch = window.fetch;
  window.fetch = async (url, opts) => {
    if (String(url).includes('/api/memory') && !String(url).includes('workspace') && (!opts || !opts.method || opts.method === 'GET')) {
      return { ok: false, status: 500, json: async () => ({ ok: false, error: 'boom: store unreachable' }), headers: { get: () => null } };
    }
    return origFetch(url, opts);
  };
  click($('#memoryRefresh'));
  await sleep(350);
  t('fail: error banner rendered instead of a dead view', ($('#memFactsList').textContent || '').includes('boom: store unreachable'), ($('#memFactsList').textContent || '').slice(0, 60));
  window.fetch = origFetch;

  // ---- 7) back to chat ------------------------------------------------------------
  click($('#memoryBackChat'));
  t('back: Memory view closes, chat shows', !visible($('#memoryView')) && visible($('#chatView')), '');

  const fails = results.filter((r) => r.startsWith('FAIL'));
  console.log(results.join('\n'));
  console.log(`\n${fails.length === 0 ? 'ALL' : fails.length + ' FAILED of'} ${results.length} memory-tab checks passed`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});