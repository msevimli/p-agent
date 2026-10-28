#!/usr/bin/env node
/**
 * ui-file-editor-check.cjs — jsdom smoke for the File Explorer edit feature.
 *
 * Loads the real index.html + app.js with stubbed fetch and drives the full
 * flow: browse to a file -> preview -> edit mode (full-content re-fetch) ->
 * modify -> Save (asserts the POST /api/fs/write payload) -> 'Saved ✓'
 * feedback -> fresh preview; plus the failure path (error shown, edits kept,
 * editor stays open), cancel-with-dirty-confirm, Escape-to-cancel, and the
 * too-large-to-edit refusal.
 *
 * Run: NODE_PATH=/home/hermesai/.hermes/hermes-agent/node_modules \
 *        node scripts/ui-file-editor-check.cjs
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
  const dom = new JSDOM(html, {
    url: 'http://127.0.0.1:8888/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const $ = (sel) => window.document.querySelector(sel);

  // --- fetch stub ----------------------------------------------------------
  // Modes:
  //   read:     'ok'       -> full read for the editor
  //             'toobig'   -> 413 refusal
  //   write:    'ok'       -> save succeeds
  //             'fail'     -> 400 {ok:false,error:'boom'}
  let readMode = 'ok';
  let writeMode = 'ok';
  let confirmCalls = 0;
  let writePayload = null;
  let savedContent = 'hello world\nfoo world\n'; // mock disk state; writes update it
  // markdown fixture: exercised by the preview-mode nets (render + sanitize).
  const MD_SAMPLE = ['# Deep Research Title', '', '**bold** and *italic* text', '', '- item one', '- item two', '',
    '> a quoted line', '', '<script>window.evil = 1</script>', '', '<img src="pic.png" onerror="window.evil=2">', '',
    '```js', 'const x = 1;', '```', ''].join('\n');
  let mdSavedContent = MD_SAMPLE;
  // tiny stand-in for the real marked CDN: enough structure for the preview
  // assertions (h1, lists, quotes, bold, fenced code blocks).
  const richMd = (s) => String(s || '')
    .replace(/```(\w*)\n?([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
    .replace(/^# (.*)$/gm, '<h1>$1</h1>')
    .replace(/^- (.*)$/gm, '<ul><li>$1</li></ul>')
    .replace(/^> (.*)$/gm, '<blockquote>$1</blockquote>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

  window.fetch = async (url, opts) => {
    const u = String(url);
    const json = (obj, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => obj });
    const isPost = opts && opts.method === 'POST';
    if (isPost && u.includes('/api/fs/write')) {
      writePayload = JSON.parse(opts.body);
      await sleep(150); // simulated network latency so the in-flight state is observable
      if (writeMode === 'fail') return json({ ok: false, error: 'boom: save rejected' }, 400);
      savedContent = writePayload.content;
      if (writePayload.path === 'readme.md') mdSavedContent = writePayload.content;
      return json({ ok: true, path: writePayload.path, bytes: Buffer.byteLength(writePayload.content), saved: true });
    }
    if (u.includes('/api/fs/read')) {
      const full = u.includes('full=1');
      const isMd = u.includes('readme.md');
      const contentSrc = isMd ? mdSavedContent : savedContent;
      if (full && readMode === 'toobig') {
        return json({ ok: false, error: 'file is 5000000 bytes — too large to open in the browser editor (limit 1048576 bytes)' }, 413);
      }
      if (full) return json({ ok: true, path: isMd ? 'readme.md' : 'hello.txt', bytes: Buffer.byteLength(contentSrc), full: true, content: contentSrc });
      return json({ ok: true, path: isMd ? 'readme.md' : 'hello.txt', bytes: Buffer.byteLength(contentSrc), content: contentSrc });
    }
    if (u.includes('/api/fs/list')) {
      const q = new URL(u, 'http://x').searchParams.get('path') || '';
      const entries =
        q === 'workspaces'
          ? [{ name: 'ws.txt', path: 'workspaces/ws.txt', type: 'file' }]
          : [
              { name: 'hello.txt', path: 'hello.txt', type: 'file' },
              { name: 'readme.md', path: 'readme.md', type: 'file' },
              { name: 'workspaces', path: 'workspaces', type: 'directory' },
              { name: 'sub', path: 'sub', type: 'directory' },
            ];
      return json({
        ok: true,
        path: q,
        count: entries.length,
        entries,
        root: '/workspace',
      });
    }
    if (!isPost) {
      if (u.includes('/api/sessions')) return json([]);
      if (u.includes('/api/models')) return json({ models: [], cascade: null });
      if (u.includes('/api/skills')) return json({ skills: [] });
      if (u.includes('/api/automations')) return json({ automations: [], paused: false });
      if (u.includes('/api/system/prompt')) return json({ prompt: '' });
      if (u.includes('/api/system/metrics')) return json({ cpu: 0, ram: 0 });
      if (u.includes('/api/library')) return json({ files: [] });
      if (u.includes('/api/templates')) return json({ templates: [] });
      if (u.includes('/api/channels')) return json({ channels: [] });
      if (u.includes('/api/queue')) return json({ queue: [] });
    }
    return json({ ok: true });
  };
  window.marked = { parse: richMd, setOptions: () => {}, use: () => {} };
  window.hljs = {
    highlightElement(el) {
      // simulate real hljs output: text is HTML-escaped first (real hljs
      // escapes entities), then a token span that wraps ACROSS lines
      // (multi-line comment/string) plus a single-line balanced token.
      const t = el.textContent
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      el.innerHTML = t
        .replace('hello world', '<span class="hljs-cross">hello world')
        .replace('foo world', 'foo world</span>')
        .replace('hello moon', '<span class="hljs-cross">hello moon</span>');
    },
  };
  window.confirm = () => { confirmCalls++; return true; };
  dom.window.eval(appJs);

  await sleep(400); // initial boot fetches resolve

  // --- browse: open the file explorer and the hello.txt file --------------
  const explorerBtn = $('#fileExplorerBtn');
  t('editor: file explorer button exists', !!explorerBtn);
  explorerBtn.click();
  await sleep(80);
  const rows = [...window.document.querySelectorAll('#fsList .fs-entry')];
  const fileRow = rows.find((r) => (r.textContent || '').includes('hello.txt'));
  t('editor: directory listing renders entries', rows.length === 4 && !!fileRow, `rows=${rows.length}`);
  t('editor: folders are clickable separately from files', rows.some((r) => (r.textContent || '').includes('sub')), '');

  // --- workspace zones: breadcrumb labels + Root/Workspace quick toggles ---
  const crumbs = () => [...window.document.querySelectorAll('#fsBreadcrumb .fs-bc-seg')].map((c) => c.textContent);
  t('zone: root crumb is labeled Root', crumbs().length === 1 && crumbs()[0] === 'Root', JSON.stringify(crumbs()));
  const wsBtn = window.document.querySelector('#fsGoWs');
  const rootBtn = window.document.querySelector('#fsGoRoot');
  t('zone: Workspace + Root quick-toggle buttons exist', !!wsBtn && !!rootBtn, '');
  wsBtn.click();
  await sleep(80);
  const wsRows = [...window.document.querySelectorAll('#fsList .fs-entry')];
  t('zone: Go-to-Workspace lists the agent workspace', wsRows.some((r) => (r.textContent || '').includes('ws.txt')) && !wsRows.some((r) => (r.textContent || '').includes('hello.txt')), `rows=${wsRows.length}`);
  t('zone: breadcrumb reads Root > workspace', JSON.stringify(crumbs()) === JSON.stringify(['Root', 'workspace']), JSON.stringify(crumbs()));
  rootBtn.click();
  await sleep(80);
  t('zone: Go-to-Root returns to the project root breadcrumb', JSON.stringify(crumbs()) === JSON.stringify(['Root']), JSON.stringify(crumbs()));
  t('zone: root listing back via toggle', [...window.document.querySelectorAll('#fsList .fs-entry')].length === 4, '');

  // re-query the entry row — the toggles re-rendered the listing and the
  // old reference is detached (its click would not reach the delegated
  // listener on #fsList)
  const freshRow = [...window.document.querySelectorAll('#fsList .fs-entry')].find((r) => (r.textContent || '').includes('hello.txt'));
  freshRow.click();
  await sleep(80);
  t('editor: preview renders the code block', !!$('#fsList pre.fe-fileview'), '');
  t('md: no toggle on non-markdown files', !$('#fsList [data-hook=fe-md-toggle]'), '');

  // --- line-number gutter ----------------------------------------------------
  const lnRows = () => [...window.document.querySelectorAll('#fsList .fe-line')];
  const lnNums = () => lnRows().map((r) => (r.querySelector('.fe-ln') || {}).textContent || '');
  const lnCodes = () => lnRows().map((r) => r.querySelector('.fe-lc'));
  t('ln: gutter row count matches the file line count', JSON.stringify(lnNums()) === JSON.stringify(['1', '2']), JSON.stringify(lnNums()));
  t('ln: each row has gutter + code cells', lnRows().every((r) => !!r.querySelector('.fe-ln') && !!r.querySelector('.fe-lc')), '');
  const ln1 = lnCodes()[0];
  const ln2 = lnCodes()[1];
  t('ln: single-line syntax span kept on its row', !!ln1 && /<span class="hljs-cross">hello world/.test(ln1.innerHTML), ln1 ? ln1.innerHTML : 'none');
  t('ln: cross-line span is re-opened on the next row', !!ln2 && ln2.innerHTML === '<span class="hljs-cross">foo world</span>', ln2 ? ln2.innerHTML : 'none');
  t('ln: rows reassemble the file content exactly', lnCodes().map((c) => c.textContent).join('\n') === 'hello world\nfoo world', '');
  const editBtn = [...window.document.querySelectorAll('#fsList .fe-btn-back')].find((b) => (b.textContent || '').includes('edit'));
  t('editor: edit button in the file view header', !!editBtn, '');

  // --- enter edit mode ------------------------------------------------------
  editBtn.click();
  await sleep(80);
  const ta = $('textarea[data-hook=fe-editor]');
  t('editor: textarea opens prefilled with full content', !!ta && ta.value === 'hello world\nfoo world\n', ta ? JSON.stringify(ta.value) : 'no textarea');
  t('editor: save + cancel buttons rendered', !!$('button[data-hook=fe-save]') && !!$('button[data-hook=fe-cancel]'), '');
  t('editor: preview code block replaced while editing', !$('#fsList pre.fe-fileview'), '');
  t('editor: edit mode marks fsList as a flex column (fe-editing)', $('#fsList').classList.contains('fe-editing'), $('#fsList').className);

  // --- modify + save --------------------------------------------------------
  ta.value = 'hello moon';
  $('button[data-hook=fe-save]').click();
  await sleep(60);
  t('editor: saving feedback shown while in flight', /Saving…/.test(($('.fe-save-feedback') || {}).textContent || ''), ($('.fe-save-feedback') || {}).textContent);
  t('editor: save POSTs {path, content} to /api/fs/write', !!writePayload && writePayload.path === 'hello.txt' && writePayload.content === 'hello moon', JSON.stringify(writePayload));
  await sleep(250); // 150ms simulated latency + processing
  t('editor: Saved ✓ confirmation shown', !!($('.fe-save-feedback.saved') || false) && /Saved/.test($('.fe-save-feedback').textContent), ($('.fe-save-feedback') || {}).textContent);
  await sleep(900); // 800ms confirmation, then back to preview
  const previewCode = $('#fsList pre.fe-fileview code');
  const codeText = () => [...window.document.querySelectorAll('#fsList pre.fe-fileview .fe-lc')].map((c) => c.textContent).join('\n');
  t('editor: back to preview showing the SAVED content', !!previewCode && codeText() === 'hello moon', previewCode ? JSON.stringify(codeText()) : 'no preview');
  t('ln: gutter recalculates for the saved content', [...window.document.querySelectorAll('#fsList .fe-line')].length === 1 && lnNums()[0] === '1', JSON.stringify(lnNums()));
  t('editor: preview mode drops the fe-editing flex class', !$('#fsList').classList.contains('fe-editing'), $('#fsList').className);

  // --- too-large refusal -----------------------------------------------------
  readMode = 'toobig';
  [...window.document.querySelectorAll('#fsList .fe-btn-back')].find((b) => (b.textContent || '').includes('edit')).click();
  await sleep(80);
  t('editor: oversized file refuses edit mode with the server error', !$('textarea[data-hook=fe-editor]') && /too large/.test(($('#fsList .fs-error') || {}).textContent || ''), ($('#fsList .fs-error') || {}).textContent);
  t('editor: refusal keeps the preview intact', !!$('#fsList pre.fe-fileview'), '');
  t('editor: refusal never enters flex edit mode', !$('#fsList').classList.contains('fe-editing'), $('#fsList').className);

  // --- cancel with dirty changes confirms -----------------------------------
  readMode = 'ok';
  [...window.document.querySelectorAll('#fsList .fe-btn-back')].find((b) => (b.textContent || '').includes('edit')).click();
  await sleep(80);
  const ta2 = $('textarea[data-hook=fe-editor]');
  ta2.value = 'unsaved edit';
  $('button[data-hook=fe-cancel]').click();
  await sleep(30);
  t('editor: dirty cancel asks for confirmation', confirmCalls === 1, `confirmCalls=${confirmCalls}`);
  t('editor: confirmed cancel restores the preview', !!$('#fsList pre.fe-fileview') && !$('textarea[data-hook=fe-editor]'), '');
  t('editor: cancel drops the fe-editing flex class', !$('#fsList').classList.contains('fe-editing'), $('#fsList').className);

  // --- folder navigation while editing is open -------------------------------
  [...window.document.querySelectorAll('#fsList .fe-btn-back')].find((b) => (b.textContent || '').includes('edit')).click();
  await sleep(80);
  t('editor: editor re-opened for navigation test', !!$('textarea[data-hook=fe-editor]') && $('#fsList').classList.contains('fe-editing'), '');
  const folderBtn = [...window.document.querySelectorAll('#fsList .fe-btn-back')].find((b) => (b.textContent || '').includes('folder'));
  t('editor: folder button present while editing', !!folderBtn);
  folderBtn.click();
  await sleep(80);
  t('editor: navigation out of the editor drops the flex class', !$('#fsList').classList.contains('fe-editing') && !!$('#fsList .fs-entry'), $('#fsList').className);
  const rowAgain = [...window.document.querySelectorAll('#fsList .fs-entry')].find((r) => (r.textContent || '').includes('hello.txt'));
  rowAgain.click();
  await sleep(80);

  // --- Escape to cancel -------------------------------------------------------
  [...window.document.querySelectorAll('#fsList .fe-btn-back')].find((b) => (b.textContent || '').includes('edit')).click();
  await sleep(80);
  const ta3 = $('textarea[data-hook=fe-editor]');
  ta3.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(30);
  t('editor: Escape cancels edit mode', !$('textarea[data-hook=fe-editor]'), '');

  // --- failed save keeps edits + stays in editor -----------------------------
  writeMode = 'fail';
  [...window.document.querySelectorAll('#fsList .fe-btn-back')].find((b) => (b.textContent || '').includes('edit')).click();
  await sleep(80);
  const ta4 = $('textarea[data-hook=fe-editor]');
  ta4.value = 'doomed edit';
  $('button[data-hook=fe-save]').click();
  await sleep(250); // 150ms simulated latency + processing
  t('editor: failed save shows the error in the feedback slot', !!($('.fe-save-feedback.error') || false) && /boom/.test($('.fe-save-feedback').textContent), ($('.fe-save-feedback') || {}).textContent);
  t('editor: failed save keeps the editor open with edits intact', !!$('textarea[data-hook=fe-editor]') && $('textarea[data-hook=fe-editor]').value === 'doomed edit', '');
  t('editor: failed save re-enables the buttons', $('button[data-hook=fe-save]').disabled === false, `disabled=${$('button[data-hook=fe-save]').disabled}`);
  writeMode = 'ok';
  $('button[data-hook=fe-cancel]').click(); // dirty cancel (confirm again)
  await sleep(30);
  t('editor: post-failure cancel returns to preview (keep last saved)', !!$('#fsList pre.fe-fileview code') && codeText() === 'hello moon', JSON.stringify(codeText()));

  // --- copy button still present in preview ----------------------------------
  t('editor: copy button intact in preview', !!$('#fsList pre.fe-fileview .code-copy'), '');

  // --- markdown preview mode -------------------------------------------------
  readMode = 'ok';
  [...window.document.querySelectorAll('#fsList .fe-btn-back')].find((b) => (b.textContent || '').includes('folder')).click();
  await sleep(80);
  const mdRow = [...window.document.querySelectorAll('#fsList .fs-entry')].find((r) => (r.textContent || '').includes('readme.md'));
  t('md: .md file appears in the listing', !!mdRow, '');
  mdRow.click();
  await sleep(80);
  const mdView = () => $('#fsList [data-hook=fe-mdview]');
  const toggle = () => $('#fsList [data-hook=fe-md-toggle]');
  t('md: .md files default to the rendered preview', !!mdView() && !$('#fsList pre.fe-fileview'), '');
  t('md: preview toggle button sits next to edit', !!toggle() && /Raw/.test(toggle().textContent), '');
  t('md: renders headings', !!(mdView() && mdView().querySelector('h1')) && /Deep Research Title/.test(mdView().querySelector('h1').textContent), '');
  t('md: renders bold', !!(mdView() && mdView().querySelector('strong')) && /bold/.test(mdView().querySelector('strong').textContent), '');
  t('md: renders lists', !!(mdView() && mdView().querySelector('ul li')), '');
  t('md: renders blockquotes', !!(mdView() && mdView().querySelector('blockquote')), '');
  t('md: renders code blocks', !!(mdView() && mdView().querySelector('pre code')), '');
  t('md: sanitizer strips <script> from the preview', !(mdView() && mdView().querySelector('script')) && window.evil === undefined, '');
  t('md: sanitizer strips event handlers from tags', !(mdView() && mdView().querySelector('[onerror]')), '');
  t('md: copy button present in preview', !!(mdView() && mdView().querySelector('.code-copy')), '');
  toggle().click();
  await sleep(30);
  const rawPre = $('#fsList pre.fe-fileview');
  const staleMd = mdView();
  const toggleLabel = toggle() ? toggle().textContent : '(none)';
  t('md: toggle switches to raw source', !!rawPre && !staleMd && /Preview/.test(toggleLabel), `raw=${!!rawPre} md=${!!staleMd} label=${toggleLabel}`);
  t('md: raw view shows the original markdown text', codeText() === MD_SAMPLE.replace(/\n$/, ''), JSON.stringify(codeText()).slice(0, 300));
  t('ln: gutter count matches the markdown raw view', [...window.document.querySelectorAll('#fsList .fe-line')].length === MD_SAMPLE.split('\n').length - 1, `rows=${[...window.document.querySelectorAll('#fsList .fe-line')].length} want=${MD_SAMPLE.split('\n').length - 1}`);
  toggle().click();
  await sleep(30);
  t('md: toggle switches back to rendered preview', !!mdView() && !!mdView().querySelector('h1'), '');
  [...window.document.querySelectorAll('#fsList .fe-btn-back')].find((b) => (b.textContent || '').includes('edit')).click();
  await sleep(80);
  const mdTa = $('textarea[data-hook=fe-editor]');
  t('md: edit opens the raw source in the textarea', !!mdTa && mdTa.value.includes('# Deep Research Title'), '');
  mdTa.value = '# Edited Title\n\n**fresh** content';
  $('button[data-hook=fe-save]').click();
  await sleep(1000);
  t('md: after save returns to the rendered preview', !!mdView() && /Edited Title/.test(mdView().textContent), '');
  t('md: saved content is re-rendered (heading updated)', !!(mdView() && mdView().querySelector('h1')) && /Edited Title/.test(mdView().querySelector('h1').textContent), '');
  t('md: toggle state resets to preview after editing', !(mdView() && mdView().querySelector('script')) && window.evil === undefined, '');

  const fails = results.filter((r) => r.startsWith('FAIL'));
  console.log(results.join('\n'));
  console.log(`\n${fails.length === 0 ? 'ALL' : fails.length + ' FAILED of'} ${results.length} PASSED`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});