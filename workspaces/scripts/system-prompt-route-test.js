#!/usr/bin/env node
/**
 * Route tests for GET/POST/DELETE /api/system/prompt (services/systemPrompt
 * + routes/systemPrompt). The override FILE is redirected to a throwaway
 * temp path via SYSTEM_PROMPT_FILE BEFORE any project module is required
 * (the path binds at require time) — the real data dir is never touched.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sysprompt-r-'));
process.env.SYSTEM_PROMPT_FILE = path.join(tmpDir, 'override.txt');

const ROOT = path.join(__dirname, '..', '..');
const results = [];
const t = (name, cond, detail) => results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`);

const express = require('express');
const systemPrompt = require(path.join(ROOT, 'services', 'systemPrompt'));
const router = require(path.join(ROOT, 'routes', 'systemPrompt'));

(async () => {
  t('route: override file bound to the temp path (env honored)', systemPrompt.FILE === process.env.SYSTEM_PROMPT_FILE, systemPrompt.FILE);

  const app = express();
  app.use(express.json());
  app.use('/api/system/prompt', router);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/system/prompt`;

  // 1. GET with no override -> the generated template (tool payloads section included)
  let res = await fetch(base);
  let d = await res.json();
  t('GET: template when no override', res.status === 200 && d.ok && d.overridden === false && d.source === 'template', `source=${d.source}`);
  t('GET: full template includes the tool payloads section', /FILE TOOL PAYLOADS/.test(String(d.prompt || '')), `len=${String(d.prompt).length}`);
  const templatePrompt = d.prompt;

  // 2. POST a custom prompt -> overridden, applies byte-for-byte
  const custom = 'You are a custom prompt.\nReply in exactly three words.';
  res = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: custom }) });
  d = await res.json();
  t('POST: saves the override', res.status === 200 && d.ok && d.overridden === true && d.source === 'override', `source=${d.source}`);
  t('POST: returned prompt is byte-identical', d.prompt === custom, '');

  // 3. GET now returns the override, not the template
  res = await fetch(base);
  d = await res.json();
  t('GET: returns the override after POST', d.ok && d.overridden === true && d.prompt === custom, '');

  // the override really replaced the template (not concatenated)
  res = await fetch(base);
  d = await res.json();
  t('GET: override fully replaces the template', !String(d.prompt).includes('FILE TOOL PAYLOADS'), '');

  // 4. validation: empty / whitespace / absent -> 400
  for (const [label, body] of [
    ['empty string', { prompt: '' }],
    ['whitespace only', { prompt: '   \n ' }],
    ['absent key', {}],
    ['non-string', { prompt: 42 }],
  ]) {
    res = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    d = await res.json();
    t(`POST: ${label} rejected 400`, res.status === 400 && d.ok === false && /empty/.test(d.error || ''), String(d.error));
  }

  // 5. oversized -> 400
  res = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'x'.repeat(systemPrompt.MAX_LEN + 1) }) });
  d = await res.json();
  t('POST: oversized rejected 400', res.status === 400 && /too long/.test(d.error || ''), String(d.error));

  // 6. DELETE -> back to template
  res = await fetch(base, { method: 'DELETE' });
  d = await res.json();
  t('DELETE: resets to the template', res.status === 200 && d.ok && d.overridden === false && d.source === 'template', `source=${d.source}`);
  t('DELETE: template text is the same as the original', d.prompt === templatePrompt, '');

  // the override file is gone from disk
  t('reset: override file removed', !fs.existsSync(systemPrompt.FILE), '');

  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmpDir, { recursive: true, force: true });

  const fails = results.filter((r) => r.startsWith('FAIL')).length;
  console.log(results.join('\n'));
  console.log(fails || results.length ? `\n${results.length - fails}/${results.length} system-prompt route tests passed${fails ? ` (${fails} FAILED)` : ''}` : '');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});