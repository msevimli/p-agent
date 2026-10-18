/**
 * File explorer fs routes — wiring test for routes/fs.js:
 *   GET  /api/fs/list, GET /api/fs/read (?full=1), POST /api/fs/write, POST /api/fs/patch
 *
 * PLIFE_WORK_ROOT is redirected to a throwaway temp dir (created + removed by
 * this test) and the size caps are shrunk via env so the boundary cases are
 * cheap. The real fileTools are exercised (the routes ARE thin wrappers), so
 * sandbox escapes must result in 400s and must never touch the real filesystem
 * outside the temp workRoot.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-routes-'));
const OUTSIDE = path.join(path.dirname(WORK), path.basename(WORK) + '-outside');
process.env.PLIFE_WORK_ROOT = WORK;
process.env.FS_WRITE_MAX_CHARS = '1024';
process.env.FS_READ_FULL_MAX_CHARS = '512';
process.env.READ_FILE_MAX_CHARS = '50'; // shrink the preview cap to test ?full=1

const ROOT = path.resolve(__dirname, '..');
const express = require(path.join(ROOT, 'node_modules', 'express'));
const routes = require(path.join(ROOT, 'routes', 'fs.js'));

const results = [];
const t = (name, pass, info) => {
  results.push(`${pass ? 'PASS' : 'FAIL'} ${name}${info ? ' | ' + String(info) : ''}`);
};

(async () => {
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use('/api/fs', routes);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/fs`;

  const jpost = (p, body) =>
    fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  try {
    // ---- seed fixtures ----
    fs.mkdirSync(path.join(WORK, 'sub', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(WORK, 'hello.txt'), 'hello world\nfoo world\n');
    fs.writeFileSync(path.join(WORK, 'big.txt'), 'x'.repeat(300)); // > preview cap 50, < full cap 512
    fs.writeFileSync(path.join(WORK, 'huge.txt'), 'y'.repeat(700)); // > full cap 512

    // ---- list ----
    let res = await fetch(`${base}/list`);
    let data = await res.json();
    t('list: root lists entries with sandbox root', res.status === 200 && data.ok === true && Array.isArray(data.entries) && data.root === WORK, JSON.stringify(data).slice(0, 160));
    res = await fetch(`${base}/list?path=${encodeURIComponent('sub//deep')}`);
    data = await res.json();
    t('list: subdir path resolves', res.status === 200 && data.ok === true && data.path === 'sub/deep', `${res.status} ${JSON.stringify(data).slice(0, 120)}`);
    res = await fetch(`${base}/list?path=${encodeURIComponent('../')}`);
    data = await res.json();
    t('list: ..-escape refused', res.status === 400 && data.ok === false, `${res.status} ${JSON.stringify(data)}`);

    // ---- read (plain preview, capped) ----
    res = await fetch(`${base}/read?path=${encodeURIComponent('hello.txt')}`);
    data = await res.json();
    t('read: file content served', res.status === 200 && data.ok === true && data.content === 'hello world\nfoo world\n', `${res.status} ${JSON.stringify(data).slice(0, 120)}`);
    res = await fetch(`${base}/read?path=${encodeURIComponent('nope.txt')}`);
    data = await res.json();
    t('read: missing file -> 400', res.status === 400 && data.ok === false, `${res.status}`);
    res = await fetch(`${base}/read`);
    data = await res.json();
    t('read: missing path param -> 400', res.status === 400 && data.ok === false, `${res.status}`);
    res = await fetch(`${base}/read?path=${encodeURIComponent('big.txt')}`);
    data = await res.json();
    t('read: preview truncates at the read_file cap', res.status === 200 && data.ok === true && data.truncated === true && data.content.startsWith('x') && data.content.length > 50 && data.content.length < 200, `len=${data.content && data.content.length}`);

    // ---- read ?full=1 (editor) ----
    res = await fetch(`${base}/read?path=${encodeURIComponent('big.txt')}&full=1`);
    data = await res.json();
    t('read full: whole file returned past preview cap', res.status === 200 && data.ok === true && data.full === true && data.content.length === 300 && data.content.includes('…[truncated') === false, `len=${data.content && data.content.length}`);
    res = await fetch(`${base}/read?path=${encodeURIComponent('huge.txt')}&full=1`);
    data = await res.json();
    t('read full: over full-read cap -> 413', res.status === 413 && data.ok === false && /too large/.test(data.error || ''), `${res.status} ${JSON.stringify(data).slice(0, 120)}`);
    res = await fetch(`${base}/read?path=${encodeURIComponent('hello.txt')}&full=1`);
    data = await res.json();
    t('read full: small file identical to plain read', res.status === 200 && data.ok === true && data.content === 'hello world\nfoo world\n', `${res.status}`);
    res = await fetch(`${base}/read?path=${encodeURIComponent('nope.txt')}&full=1`);
    data = await res.json();
    t('read full: missing file -> 400', res.status === 400 && data.ok === false, `${res.status}`);
    res = await fetch(`${base}/read?path=${encodeURIComponent('../x')}&full=1`);
    data = await res.json();
    t('read full: escape refused', res.status === 400 && data.ok === false, `${res.status} ${JSON.stringify(data)}`);

    // ---- write ----
    res = await jpost('/write', { path: 'sub/deep/new.txt', content: 'line1\nline2' });
    data = await res.json();
    t('write: creates file with parent dirs', res.status === 200 && data.ok === true && data.saved === true && data.bytes === 11 && fs.readFileSync(path.join(WORK, 'sub', 'deep', 'new.txt'), 'utf8') === 'line1\nline2', `${res.status} ${JSON.stringify(data)}`);
    res = await jpost('/write', { path: 'hello.txt', content: 'overwritten' });
    data = await res.json();
    t('write: overwrites existing file', res.status === 200 && data.ok === true && fs.readFileSync(path.join(WORK, 'hello.txt'), 'utf8') === 'overwritten', `${res.status} ${JSON.stringify(data)}`);
    res = await jpost('/write', { path: '../escape.txt', content: 'evil' });
    data = await res.json();
    t('write: ..-escape refused, nothing written outside', res.status === 400 && data.ok === false && !fs.existsSync(OUTSIDE + '.txt') && !fs.existsSync(path.join(path.dirname(WORK), 'escape.txt')), `${res.status} ${JSON.stringify(data)}`);
    res = await jpost('/write', { path: '/etc/pwned', content: 'evil' });
    data = await res.json();
    t('write: absolute path refused', res.status === 400 && data.ok === false, `${res.status} ${JSON.stringify(data)}`);
    res = await jpost('/write', { path: 'sub', content: 'x' });
    data = await res.json();
    t('write: existing directory path -> 400', res.status === 400 && data.ok === false, `${res.status}`);
    res = await jpost('/write', { content: 'x' });
    data = await res.json();
    t('write: missing path -> 400', res.status === 400 && data.ok === false, `${res.status}`);
    res = await jpost('/write', { path: 'x.txt' });
    data = await res.json();
    t('write: missing content -> 400', res.status === 400 && data.ok === false, `${res.status}`);
    res = await jpost('/write', { path: 'x.txt', content: 42 });
    data = await res.json();
    t('write: non-string content -> 400', res.status === 400 && data.ok === false, `${res.status}`);
    res = await jpost('/write', { path: 'x.txt', content: 'z'.repeat(1100) });
    data = await res.json();
    t('write: over size cap -> 413', res.status === 413 && data.ok === false && /too large/.test(data.error || ''), `${res.status}`);

    // ---- patch ----
    fs.writeFileSync(path.join(WORK, 'patchme.txt'), 'hello world\nfoo world\n');
    res = await jpost('/patch', { path: 'patchme.txt', old_text: 'world', new_text: 'there' });
    data = await res.json();
    t('patch: first occurrence replaced', res.status === 200 && data.ok === true && data.patched === true && fs.readFileSync(path.join(WORK, 'patchme.txt'), 'utf8') === 'hello there\nfoo world\n', `${res.status} ${JSON.stringify(data)}`);
    res = await jpost('/patch', { path: 'patchme.txt', old_text: 'there', new_text: 'world', replace_all: true });
    data = await res.json();
    t('patch: replace_all replaces every occurrence', res.status === 200 && data.ok === true && fs.readFileSync(path.join(WORK, 'patchme.txt'), 'utf8') === 'hello world\nfoo world\n', `${res.status}`);
    res = await jpost('/patch', { path: 'patchme.txt', old_text: 'NOPE', new_text: 'x' });
    data = await res.json();
    t('patch: old_text not found -> 400 with the tool error', res.status === 400 && data.ok === false && /not found/.test(data.error || ''), `${res.status} ${JSON.stringify(data)}`);
    res = await jpost('/patch', { path: 'patchme.txt', old_text: '', new_text: 'x' });
    data = await res.json();
    t('patch: empty old_text -> 400', res.status === 400 && data.ok === false, `${res.status}`);
    res = await jpost('/patch', { path: '../escape.txt', old_text: 'a', new_text: 'b' });
    t('patch: escape refused, nothing written outside', res.status === 400 && data.ok === false && !fs.existsSync(path.join(path.dirname(WORK), 'escape.txt')), `${res.status}`);
    fs.writeFileSync(path.join(WORK, 'grow.txt'), 'a'.repeat(900));
    res = await jpost('/patch', { path: 'grow.txt', old_text: 'a'.repeat(10), new_text: 'b'.repeat(500) });
    data = await res.json();
    t('patch: growth beyond cap -> 413, file untouched', res.status === 413 && data.ok === false && fs.readFileSync(path.join(WORK, 'grow.txt'), 'utf8').length === 900, `${res.status} ${JSON.stringify(data)}`);
    res = await jpost('/patch', { path: 'patchme.txt', new_text: 'x' });
    data = await res.json();
    t('patch: missing old_text param -> 400', res.status === 400 && data.ok === false, `${res.status}`);
  } finally {
    server.close();
    fs.rmSync(WORK, { recursive: true, force: true });
    fs.rmSync(OUTSIDE, { recursive: true, force: true });
  }

  const fails = results.filter((r) => r.startsWith('FAIL'));
  console.log(results.join('\n'));
  console.log(`\n${fails.length === 0 ? 'ALL' : fails.length + ' FAILED of'} ${results.length} PASSED`);
  process.exitCode = fails.length ? 1 : 0;
})();