#!/usr/bin/env node
/**
 * ui-tool-replay-check.cjs — jsdom smoke for the persisted tool-run cards.
 *
 * Loads the real index.html + app.js with stubbed fetch/marked, seeds a
 * session already containing role:'tool' records (as persisted by a previous
 * live turn), opens it, and asserts the collapsible .tool-step cards render
 * with tool name, arguments, outcome badge (✓ ok / ⏭ skipped / ✗ failed),
 * output detail and a timestamp — i.e. the reload-after-refresh path shows
 * the tool history instead of losing it.
 *
 * Run: NODE_PATH=/home/hermesai/.hermes/hermes-agent/node_modules \
 *        node scripts/ui-tool-replay-check.cjs
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

// Session as it would be persisted after a real tool-round turn + reload.
const seededSession = {
  id: 's_replay',
  title: 'Replay check',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  messages: [
    { role: 'user', content: 'check disk usage' },
    {
      role: 'tool',
      tool: 'run_shell',
      args: '{"command":"df -h /"}',
      ok: true,
      skipped: false,
      code: 0,
      out: 'Filesystem      Size  Used Avail Use% Mounted on\n/dev/sda1        100G   40G   60G  40% /',
      error: undefined,
      ts: Date.now() - 60000,
    },
    {
      role: 'tool',
      tool: 'read_file',
      args: '{"path":"services/historyManager.js"}',
      ok: false,
      skipped: false,
      code: undefined,
      out: undefined,
      error: 'ENOENT: no such file or directory',
      ts: Date.now() - 59000,
    },
    {
      role: 'tool',
      tool: 'run_shell',
      args: '{"command":"df -h /"}',
      ok: false,
      skipped: true,
      code: undefined,
      out: undefined,
      error: 'chmod +x on a .py file is unnecessary (the python3 runner does not use the executable bit) — skipped',
      ts: Date.now() - 58000,
    },
    { role: 'assistant', content: 'Disk is **40% used**.', reasoning: 'checked df', meta: '8s' },
  ],
};

(async () => {
  const dom = new JSDOM(html, {
    url: 'http://127.0.0.1:8888/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;

  // --- stubs ---------------------------------------------------------------
  window.fetch = async (url, opts) => {
    const u = String(url);
    const json = (obj, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => obj });
    if (!opts || !opts.method || opts.method === 'GET') {
      if (u.includes('/api/sessions')) return json([seededSession], 200);
      if (u.includes('/api/models')) return json({ models: [], cascade: null });
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
    return json({ ok: true, id: 's_replay' });
  };
  window.marked = { parse: (s) => String(s || ''), setOptions: () => {}, use: () => {} };
  dom.window.eval(appJs);

  await new Promise((r) => setTimeout(r, 400)); // initial loadSessions resolves

  // --- the reload path: init auto-opens the first stored session ------------
  // (app.js init: `if (state.sessions.length) switchSession(state.sessions[0].id)`)
  // so a hard refresh with a persisted session must render the tool cards
  // with NO user interaction at all.
  const sidebarItem = [...window.document.querySelectorAll('.session-item')].find(
    (el) => (el.textContent || '').includes('Replay check')
  );
  t('replay: seeded session rendered in the sidebar', !!sidebarItem, sidebarItem ? '' : 'no .session-item with title found');
  await new Promise((r) => setTimeout(r, 200));

  // --- assert the tool cards ------------------------------------------------
  const cards = [...window.document.querySelectorAll('#messages .tool-step')];
  t('replay: tool-step cards rendered from stored history', cards.length === 3, `cards=${cards.length}`);

  const first = cards[0];
  t('replay: ok card — name + args + badge', !!first, '');
  if (first) {
    const txt = first.textContent || '';
    t('replay: ok card shows tool name', txt.includes('run_shell'), txt.slice(0, 80));
    t('replay: ok card shows the command argument', txt.includes('df -h'), txt.slice(0, 120));
    t('replay: ok card shows the success badge', txt.includes('✓ ok'), txt.slice(0, 120));
    t('replay: ok card shows a timestamp', /(\d{1,2}:){2}\d{2}/.test(txt), txt.slice(0, 200));
  }

  const errCard = cards[1];
  t('replay: failed card shows ✗ failed + error detail', !!errCard && /✗ failed/.test(errCard.textContent) && /ENOENT/.test(errCard.textContent), errCard && errCard.textContent.slice(0, 120));

  const skipCard = cards[2];
  t('replay: skipped card shows ⏭ skipped + hint', !!skipCard && /⏭ skipped/.test(skipCard.textContent) && /.py file is unnecessary/.test(skipCard.textContent), skipCard && skipCard.textContent.slice(0, 160));

  // --- expandable body ------------------------------------------------------
  const details = cards[0];
  details.setAttribute('open', '');
  const afterOpen = details.textContent || '';
  t('replay: expanded body shows full args + output', afterOpen.includes('{"command":"df -h /"}') && afterOpen.includes('Filesystem'), afterOpen.slice(0, 160));

  // --- assistant reply still renders (marked path intact) -------------------
  const assistant = [...window.document.querySelectorAll('#messages .msg-assistant')].find((el) => /Disk is/.test(el.textContent || ''));
  t('replay: assistant reply still rendered after tool cards', !!assistant, assistant ? '' : 'assistant message missing');

  const fails = results.filter((x) => x.startsWith('FAIL')).length;
  console.log(results.join('\n'));
  console.log(`\n${results.length - fails}/${results.length} ui-tool-replay checks passed${fails ? ` (${fails} FAILED)` : ''}`);
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});