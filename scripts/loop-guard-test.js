#!/usr/bin/env node
/**
 * Regression tests for the tool-loop bugfixes:
 *
 *  1. Dedup guard (services/toolLoop.js): an exact repeat of a tool call
 *     (same name + canonical args) within one chat request is refused and the
 *     model gets a "duplicate tool call skipped" result instead of a second
 *     physical execution. run_shell is exempt from that ledger but has its
 *     own CONSECUTIVE guard: a back-to-back repeat of the identical command
 *     that just succeeded is skipped; repeats after other steps and retries
 *     of failed commands still execute.
 *  2. joinToolCallArgs (services/llamaClient.js): re-joins fragmented
 *     streaming tool-call arguments on JSON token boundaries.
 *  3. Automation enforcement settle (routes/chat.js): a model that creates
 *     the automation via the NORMAL tool path is NOT force-fed corrective
 *     rounds after its final answer; a model that never emits the call burns
 *     at most maxAutomationForcedRounds then the server takes over (or ends
 *     the loop truthfully).
 *  4. Crash-proofing: a throwing tool never rejects executeTool / the loop.
 *
 * Runs the real chat router with a mocked upstream (llamaClient.complete),
 * against a throwaway workRoot (PLIFE_WORK_ROOT). data/automations-state.json
 * is backed up and restored, so the automation entries created by the loop
 * do not pollute real state.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// MUST be set before any project module is required (config/fileTools read it
// at require time).
process.env.PLIFE_WORK_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'plife-work-'));

const ROOT = path.join(__dirname, '..');
const results = [];
const t = (name, cond, detail) =>
  results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`);

const STATE_FILE = path.join(ROOT, 'data', 'automations-state.json');
const stateBackup = fs.readFileSync(STATE_FILE, 'utf8');

;(async () => {

const { joinToolCallArgs, buildChatPayload } = require(path.join(ROOT, 'services', 'llamaClient'));
const toolLoop = require(path.join(ROOT, 'services', 'toolLoop'));
// registry = the live tool array (shared with tools/)
const registry = require(path.join(ROOT, 'tools'));

function restoreState() {
  fs.writeFileSync(STATE_FILE, stateBackup, 'utf8');
}

  // =========================================================================
  // 1) joinToolCallArgs — fragmented streaming fragments
  // =========================================================================
  {
    // Mid-token identifier split (seen in the real gemma traces):
    const a = joinToolCallArgs('{"path": "scripts/c', 'urrent-time.js", "content": "hi"}');
    let ok = false;
    try { ok = JSON.parse(a).path === 'scripts/current-time.js'; } catch {}
    t('join: mid-token identifier split reparses', ok, a);

    // Quote swallowed at the fragment boundary ("x" + "… = `""`):
    const b = joinToolCallArgs('{"path": "x"', '", "content": "hi"}');
    ok = false;
    try { ok = JSON.parse(b).path === 'x' && JSON.parse(b).content === 'hi'; } catch {}
    t('join: swallowed boundary quote rebalanced', ok, b);

    // Balanced join passes through unchanged:
    const c = joinToolCallArgs('{"a": 1', ', "b": 2}');
    ok = false;
    try { ok = JSON.parse(c).a === 1 && JSON.parse(c).b === 2; } catch {}
    t('join: balanced fragments unchanged', ok, c);

    // Empty first fragment:
    t('join: empty first fragment', joinToolCallArgs('', '{}') === '{}');
  }

  // =========================================================================
  // 2) Dedup guard (unit level, real registry, throwaway workRoot)
  // =========================================================================
  toolLoop.resetSeenCalls();
  {
    const W = path.join(process.env.PLIFE_WORK_ROOT, 'scripts', '__dedup_probe.txt'); // inside temp workRoot
    const r1 = await toolLoop.executeTool('write_file', { path: 'scripts/__dedup_probe.txt', content: 'one' });
    const r2 = await toolLoop.executeTool('write_file', { path: 'scripts/__dedup_probe.txt', content: 'one' });
    const afterDup = fs.readFileSync(W, 'utf8');
    const r3 = await toolLoop.executeTool('write_file', { path: 'scripts/__dedup_probe.txt', content: 'two' });
    t('dedup: first write executes', r1.ok === true, JSON.stringify(r1));
    t('dedup: identical repeat skipped', !r2.ok && r2.skippedDuplicate === true, JSON.stringify(r2));
    t('dedup: different content still executes', r3.ok === true, JSON.stringify(r3));
    t('dedup: file not clobbered by dup', afterDup === 'one');

    // Reset clears the ledger:
    toolLoop.resetSeenCalls();
    const r4 = await toolLoop.executeTool('write_file', { path: 'scripts/__dedup_probe.txt', content: 'one' });
    t('dedup: resetSeenCalls allows re-execution', r4.ok === true && !r4.skippedDuplicate, JSON.stringify(r4));

    // read_file dedup:
    const rd1 = await toolLoop.executeTool('read_file', { path: 'scripts/__dedup_probe.txt' });
    const rd2 = await toolLoop.executeTool('read_file', { path: 'scripts/__dedup_probe.txt' });
    t('dedup: read repeat skipped', rd1.ok && !rd2.ok && rd2.skippedDuplicate, JSON.stringify(rd2));

    // run_shell is exempt from the exact-args ledger (intentional repeats
    // stay possible), but the CONSECUTIVE guard (added later) refuses a
    // back-to-back repeat of the identical command that JUST succeeded —
    // re-quoted with the same tokens counts as identical. A repeat after an
    // intervening different command executes (intentional double run), and a
    // retry of a FAILED command executes (recovery).
    toolLoop.resetSeenCalls();
    const sh1 = await toolLoop.executeTool('run_shell', { command: 'node -e "console.log(1)"' });
    const sh2 = await toolLoop.executeTool('run_shell', { command: 'node -e "console.log(1)"' });
    t('dedup: run_shell back-to-back identical repeat skipped (consecutive guard)', sh1.ok && !sh2.ok && sh2.skippedDuplicate === true, JSON.stringify(sh2));
    const sh2b = await toolLoop.executeTool('run_shell', { command: "node -e 'console.log(1)'" });
    t('dedup: re-quoted identical command still skipped back-to-back', !sh2b.ok && sh2b.skippedDuplicate === true, JSON.stringify(sh2b));
    const sh3 = await toolLoop.executeTool('run_shell', { command: 'node -e "console.log(2)"' });
    const sh4 = await toolLoop.executeTool('run_shell', { command: 'node -e "console.log(1)"' });
    t('dedup: repeat after another step executes (intentional double run)', sh3.ok && sh4.ok && !sh4.skippedDuplicate, JSON.stringify(sh4));
    toolLoop.resetSeenCalls();
    const sf1 = await toolLoop.executeTool('run_shell', { command: 'node -e "process.exit(3)"' });
    const sf2 = await toolLoop.executeTool('run_shell', { command: 'node -e "process.exit(3)"' });
    t('dedup: retry of a FAILED command executes (recovery)', !sf1.ok && !sf2.ok && !sf2.skippedDuplicate, JSON.stringify(sf2));

    // create_automation dedup (execute stubbed — no real state writes here):
    toolLoop.resetSeenCalls();
    const createDef = registry.find((x) => x.name === 'create_automation');
    const origExec = createDef.execute;
    let execCount = 0;
    createDef.execute = () => { execCount += 1; return { ok: true, message: 'stub' }; };
    const caArgs = { name: 'Dup', schedule_type: 'interval', interval_minutes: 5, action_type: 'script', script: 'scripts/__dedup_probe.txt' };
    const ca1 = await toolLoop.executeTool('create_automation', caArgs);
    const ca2 = await toolLoop.executeTool('create_automation', caArgs);
    createDef.execute = origExec;
    t('dedup: create_automation first executes', ca1.ok && !ca1.skippedDuplicate);
    t('dedup: create_automation repeat skipped (no dup id error)', !ca2.ok && ca2.skippedDuplicate === true, JSON.stringify(ca2));
    t('dedup: create_automation executed once', execCount === 1);

    // Canonical key: key order must not matter
    toolLoop.resetSeenCalls();
    const k1 = toolLoop.canonicalArgsKey({ b: 1, a: 2 });
    const k2 = toolLoop.canonicalArgsKey({ a: 2, b: 1 });
    t('dedup: canonical key order-insensitive', k1 === k2, k1);
  }

  // =========================================================================
  // 3) Crash-proofing: a throwing tool executes to {ok:false}, not a throw
  // =========================================================================
  {
    const lf = registry.find((x) => x.name === 'list_files');
    const orig = lf.execute;
    lf.execute = () => { throw new Error('boom: disk on fire'); };
    let threw = false;
    let res = null;
    try { res = await toolLoop.executeTool('list_files', {}); } catch { threw = true; }
    lf.execute = orig;
    t('crash: throwing tool returns result', !threw && res.ok === false && /disk on fire/.test(res.error), JSON.stringify(res));
  }

  // =========================================================================
  // 3b) Strict argument validation (unit level, real registry)
  // =========================================================================
  toolLoop.resetSeenCalls();
  {
    const junk = path.join(process.env.PLIFE_WORK_ROOT, '?');
    const v1 = await toolLoop.executeTool('write_file', { content: 'x' });
    t('valid: missing required path rejected pre-execution', !v1.ok && v1.invalidArgs === true && v1.error.includes("'path'"), JSON.stringify(v1));
    const v2 = await toolLoop.executeTool('write_file', {});
    t('valid: empty args object rejected', !v2.ok && v2.invalidArgs === true && v2.error.includes('write_file'), JSON.stringify(v2));
    const v3 = await toolLoop.executeTool('write_file', { path: '?', content: 'x' });
    t('valid: ? path rejected', !v3.ok && v3.invalidArgs === true, JSON.stringify(v3));
    const v4 = await toolLoop.executeTool('write_file', { path: '<path>', content: 'x' });
    t('valid: angle-template path rejected', !v4.ok && v4.invalidArgs === true, JSON.stringify(v4));
    const v5 = await toolLoop.executeTool('write_file', { path: 'ok.txt', content: '' });
    t('valid: empty content rejected', !v5.ok && v5.invalidArgs === true, JSON.stringify(v5));
    const v5b = await toolLoop.executeTool('write_file', { path: 'ok.txt', content: [] });
    t('valid: empty content array rejected', !v5b.ok && v5b.invalidArgs === true, JSON.stringify(v5b));
    const v6 = await toolLoop.executeTool('write_file', { path: 'ok.txt', content: 'hello' });
    t('valid: corrected retry executes (ledger not poisoned)', v6.ok === true && !v6.skippedDuplicate, JSON.stringify(v6));
    t('valid: no junk ? file created', !fs.existsSync(junk) && !fs.existsSync(path.join(process.env.PLIFE_WORK_ROOT, '<path>')));

    // Type coercion: numeric string -> number; placeholder in OPTIONAL arg
    // (cron) still rejected when provided; no-required tools pass with {}.
    const createDef = registry.find((x) => x.name === 'create_automation');
    const origExec = createDef.execute;
    let seenArgs = null;
    createDef.execute = (a) => { seenArgs = a; return { ok: true, message: 'stub' }; };
    const c1 = await toolLoop.executeTool('create_automation', {
      name: 'T', schedule_type: 'interval', interval_minutes: '5', action_type: 'script', script: 's.js',
    });
    t('valid: interval_minutes string coerced to number', c1.ok === true && seenArgs.interval_minutes === 5, JSON.stringify(seenArgs));
    const c2 = await toolLoop.executeTool('create_automation', {
      name: 'T', schedule_type: 'cron', cron: '???', action_type: 'script', script: 's.js',
    });
    t('valid: cron placeholder rejected', !c2.ok && c2.invalidArgs === true, JSON.stringify(c2));
    const c3 = await toolLoop.executeTool('create_automation', { name: null, schedule_type: 'interval', action_type: 'script', script: 's.js' });
    t('valid: null required name rejected', !c3.ok && c3.invalidArgs === true, JSON.stringify(c3));
    createDef.execute = origExec;
    toolLoop.resetSeenCalls();
    const l1 = await toolLoop.executeTool('list_automations', {});
    t('valid: no-required tool with {} passes', l1.ok === true, JSON.stringify(l1));
    const l2 = await toolLoop.executeTool('read_file', { path: 'ok.txt' });
    t('valid: first read executes after validation', l2.ok === true);
    const l3 = await toolLoop.executeTool('read_file', { path: 'ok.txt' });
    t('valid: read_file dedup still active after validation', !l3.ok && l3.skippedDuplicate === true, JSON.stringify(l3));
  }

  // =========================================================================
  // 4) End-to-end: real chat router + mocked upstream
  // =========================================================================
  const express = require('express');
  const llamaClient = require(path.join(ROOT, 'services', 'llamaClient'));

  // -- patch complete(), then re-require the router so it binds the mock --
  const callLog = []; // every payload seen by the mock
  let seq = [];
  llamaClient.complete = function (opts) {
    const acc = seq.shift();
    if (acc === undefined) throw new Error('mock exhausted — loop ran more steps than canned');
    callLog.push({ payload: opts.payload, messages: opts.payload.messages.map((m) => ({ role: m.role, content: m.content })) });
    const p = Promise.resolve(acc);
    Object.defineProperty(p, 'position', { value: 1, enumerable: true });
    if (opts.onUsage && acc.usage) opts.onUsage(acc.usage);
    return p;
  };
  const chatPath = path.join(ROOT, 'routes', 'chat.js');
  delete require.cache[require.resolve(chatPath)];
  const chatRouter = require(chatPath);

  const app = express();
  app.use(express.json());
  app.use('/api/chat', chatRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;

  async function runChat(userText, canned) {
    seq = canned.map((c) => ({ content: c.content || '', toolCalls: c.toolCalls || [], finishReason: c.finishReason || 'stop', usage: { prompt_tokens: 100, completion_tokens: 50 } }));
    callLog.length = 0;
    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: userText }], generation: {} }),
    });
    const body = await res.text();
    // SSE parse: data: lines
    const events = [];
    for (const part of body.split('\n\n')) {
      for (const line of part.split('\n')) {
        const l = line.trim();
        if (!l.startsWith('data:')) continue;
        const d = l.slice(5).trim();
        if (d === '[DONE]') { events.push({ done: true }); continue; }
        try { events.push(JSON.parse(d)); } catch {}
      }
    }
    const statuses = events.filter((e) => e.type === 'status').map((e) => e.message);
    const text = events
      .filter((e) => e.choices && e.choices[0] && e.choices[0].delta && typeof e.choices[0].delta.content === 'string')
      .map((e) => e.choices[0].delta.content)
      .join('');
    return { events, statuses, text, steps: callLog.length, callLog };
  }

  // ----- A) regression: duplicate write_file + successful create -> final answer
  {
    const writeArgs = '{"path":"scripts/t.js","content":"console.log(new Date());"}';
    const { statuses, text, steps, callLog } = await runChat(
      'can you create for me a basic script under scripts directory that will output the current time, then create an automation that runs it every 5 minutes and writes a log of its output',
      [
        { toolCalls: [{ index: 0, id: 'c1', name: 'write_file', arguments: writeArgs }] },
        { toolCalls: [{ index: 0, id: 'c2', name: 'write_file', arguments: writeArgs }] }, // EXACT duplicate
        { toolCalls: [{ index: 0, id: 'c3', name: 'create_automation', arguments: '{"name":"Time Log","schedule_type":"interval","interval_minutes":5,"action_type":"script","script":"scripts/t.js"}' }] },
        { toolCalls: [{ index: 0, id: 'c4', name: 'list_automations', arguments: '{}' }] },
        { content: 'All set! The automation is running.', finishReason: 'stop' },
      ]
    );
    const dupResultVisible = callLog.some((c) =>
      c.messages.some((m) => typeof m.content === 'string' && m.content.includes('duplicate tool call skipped'))
    );
    // Only the FINAL payload's history matters: earlier payloads legitimately
    // also contain the first write's ok-result (full history is re-sent).
    const finalHistory = callLog[callLog.length - 1].messages.map((m) => m.content || '');
    const okWrites = finalHistory.filter((c) => c.includes('write_file: {"ok":true')).length;
    const dupSkips = finalHistory.filter((c) => c.includes('duplicate tool call skipped')).length;
    t('e2e-A: final answer streamed', /All set!/.test(text), text.slice(0, 80));
    t('e2e-A: completed in 5 steps', steps === 5, `steps=${steps}`);
    t('e2e-A: duplicate write reported to model', dupResultVisible);
    t('e2e-A: exactly one successful write result', okWrites === 1 && dupSkips === 1, `ok=${okWrites} skips=${dupSkips}`);
    t('e2e-A: no forcing rounds triggered', !statuses.some((s) => s.includes('forcing a tool call')), statuses.join(' | '));
    t('e2e-A: no interception triggered', !statuses.some((s) => s.includes('intercepted')), statuses.join(' | '));
    t('e2e-A: file written once to temp workRoot', fs.readFileSync(path.join(process.env.PLIFE_WORK_ROOT, 'scripts', 't.js'), 'utf8') === 'console.log(new Date());');
  }

  // ----- B) model explains repeatedly -> server-side intercept creates it, loop ends cleanly
  {
    const { statuses, text, steps, callLog } = await runChat(
      'create an automation that runs scripts/backup.js every 5 minutes',
      [
        { content: 'Sure! First, open the Automations panel in the sidebar...', finishReason: 'stop' },
        { content: 'You would POST to /api/automations with a JSON body containing...', finishReason: 'stop' },
        { content: 'Done, the automation was created and enabled.', finishReason: 'stop' },
      ]
    );
    const createdViaIntercept = callLog.some((c) =>
      // message is JSON-stringified, so the name quotes are escaped (\"...\")
      c.messages.some((m) => m.content && /Automation \\"[^\\"]*\\" created \(id: scheduled-backup-run\)/.test(m.content))
    );
    t('e2e-B: intercept created the automation', createdViaIntercept);
    t('e2e-B: final answer streamed', /created and enabled/.test(text), text.slice(0, 80));
    t('e2e-B: at least one forcing round was used', statuses.some((s) => s.includes('forcing a tool call')), statuses.join(' | '));
    t('e2e-B: loop terminated within budget', steps <= 4, `steps=${steps}`);
  }

  // ----- C) model incapable AND nothing inferable -> truthful abort, no hang
  {
    const { statuses, text, steps } = await runChat(
      'create an automation every 5 minutes',
      [
        { content: 'I can explain the automations feature...', finishReason: 'stop' },
        { content: 'The Automations engine supports interval schedules...', finishReason: 'stop' },
        { content: 'Open the Automations panel to add one.', finishReason: 'stop' },
      ]
    );
    t('e2e-C: truthful failure message', /could not complete the automation creation/.test(text), text.slice(0, 100));
    t('e2e-C: abort status surfaced', statuses.some((s) => s.includes('aborted after 2 forced round')), statuses.join(' | '));
    t('e2e-C: loop did not run away', steps === 3, `steps=${steps}`);
  }

  // ----- D) invalid args rejected pre-execution, model retries, no junk files
  {
    const { statuses, text, steps, callLog } = await runChat(
      'write a file called notes.txt containing hi there',
      [
        { toolCalls: [{ index: 0, id: 'c1', name: 'write_file', arguments: '{}' }] }, // empty args -> rejected
        { toolCalls: [{ index: 0, id: 'c2', name: 'write_file', arguments: '{"path":"?","content":"x"}' }] }, // placeholder -> rejected
        { toolCalls: [{ index: 0, id: 'c3', name: 'write_file', arguments: '{"path":"notes.txt","content":"hi there"}' }] }, // valid retry
        { content: 'Done, notes.txt is written.', finishReason: 'stop' },
      ]
    );
    const rejectedStatus = statuses.filter((s) => s.includes('Tool call rejected'));
    const rejections = callLog.filter((c) =>
      c.messages.some((m) => m.content && m.content.includes('invalid arguments for write_file'))
    ).length;
    const wroteOnce = callLog[callLog.length - 1].messages
      .filter((m) => m.content && m.content.includes('write_file: {"ok":true')).length === 1;
    t('e2e-D: rejected calls surfaced as status', rejectedStatus.length === 2, statuses.join(' | '));
    t('e2e-D: corrective error fed back to model', rejections >= 1, `rejections=${rejections}`);
    t('e2e-D: model retried and succeeded', wroteOnce);
    t('e2e-D: final answer streamed', /Done, notes\.txt is written/.test(text), text.slice(0, 80));
    t('e2e-D: completed in 4 steps', steps === 4, `steps=${steps}`);
    t('e2e-D: file has the real content', fs.readFileSync(path.join(process.env.PLIFE_WORK_ROOT, 'notes.txt'), 'utf8') === 'hi there');
    t('e2e-D: no junk ? file created', !fs.existsSync(path.join(process.env.PLIFE_WORK_ROOT, '?')));
  }

  await new Promise((resolve) => server.close(resolve));

  console.log(results.join('\n'));
  const failed = results.filter((r) => r.startsWith('FAIL'));
  if (failed.length) {
    console.log(`\n${failed.length} FAILED`);
    process.exitCode = 1;
    return; // no process.exit — the .finally() cleanup below must run
  }
  console.log(`\nALL ${results.length} PASSED`);
  process.exitCode = 0;
})().catch((e) => {
  console.error('harness crashed:', (e && e.stack) || e);
  process.exitCode = 1;
}).finally(() => {
  // Restore the pre-test automation state file (the harness creates real
  // automations through the real manager during e2e tests; remove what it
  // created so re-runs stay deterministic even against a live server).
  try {
    if (stateBackup) fs.writeFileSync(STATE_FILE, stateBackup, 'utf8');
  } catch {}
});