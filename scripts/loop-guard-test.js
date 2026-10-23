#!/usr/bin/env node
/**
 * Regression tests for the tool-loop bugfixes:
 *
 *  1. NO duplicate suppression (services/toolLoop.js): identical repeats of
 *     any tool call — including back-to-back run_shell commands, repeated
 *     reads, and delete-after-create — all EXECUTE. The reported failure
 *     mode was the opposite: a model re-running a grep or re-reading a file
 *     after an edit got blocked as a "duplicate". Since 2026-10-18 there is
 *     no repetition detection AND no round ceiling: the only bounds are the
 *     repeated-invalid-call freeze in routes/chat.js (identical broken
 *     emissions) and the static anti-spam guardrails (chmod-on-.py,
 *     missing-logs hint).
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
// at require time). The system-prompt override file is redirected to a
// throwaway path too, so e2e-L can exercise the override without touching
// the real data dir.
process.env.PLIFE_WORK_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'plife-work-'));
process.env.SYSTEM_PROMPT_FILE = path.join(os.tmpdir(), 'plife-sysprompt-' + process.pid + '.txt');
// Semantic memory: hermetically redirected so e2e-N (memory-context
// injection) never touches the real vector store (env binds at require).
process.env.VECTOR_MEMORY_DB = path.join(os.tmpdir(), 'plife-vecmem-' + process.pid + '.db');
process.env.VECTOR_MEMORY_EMBEDDER = 'hash';

const ROOT = path.join(__dirname, '..');
const results = [];
const t = (name, cond, detail) =>
  results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`);

const STATE_FILE = path.join(ROOT, 'data', 'automations-state.json');
const stateBackup = fs.readFileSync(STATE_FILE, 'utf8');

// Two-stage cascade: strip role fields while the harness runs so the e2e
// loop tests exercise the CLASSIC single-model flow deterministically
// (cascade.resolve() re-reads the registry on every request). The original
// file is restored on exit. If stripping fails (missing/invalid file), the
// harness still runs — the cascade tests in cascade-tests.js cover that path.
const MODELS_STATE_FILE = path.join(ROOT, 'data', 'models-state.json');
const modelsStateBackup = fs.readFileSync(MODELS_STATE_FILE, 'utf8');
try {
  const ms = JSON.parse(modelsStateBackup);
  (Array.isArray(ms.models) ? ms.models : []).forEach((m) => {
    if (m) delete m.role;
  });
  fs.writeFileSync(MODELS_STATE_FILE, JSON.stringify(ms, null, 2) + '\n', 'utf8');
} catch (e) {
  console.error('loop-guard: could not strip cascade roles from models-state.json:', e.message);
}

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
  // 2) NO duplicate suppression (unit level, real registry, throwaway
  //    workRoot): every identical repeat executes and returns fresh state.
  // =========================================================================
  {
    // The reported scenario: write (edit) → re-run checks — all execute.
    // Zone note: bare paths land in the AGENT WORKSPACE now (workRoot/
    // workspaces/), which is also where run_shell starts — both sides of
    // the net agree without extra "../" prefixes.
    const W = path.join(process.env.PLIFE_WORK_ROOT, 'workspaces', 'scripts', '__repeat_probe.txt');
    const r1 = await toolLoop.executeTool('write_file', { path: 'scripts/__repeat_probe.txt', content: 'one' });
    const r2 = await toolLoop.executeTool('write_file', { path: 'scripts/__repeat_probe.txt', content: 'one' });
    const afterDup = fs.readFileSync(W, 'utf8');
    const r3 = await toolLoop.executeTool('write_file', { path: 'scripts/__repeat_probe.txt', content: 'two' });
    const rr1 = await toolLoop.executeTool('read_file', { path: 'scripts/__repeat_probe.txt' });
    const rr2 = await toolLoop.executeTool('read_file', { path: 'scripts/__repeat_probe.txt' });
    const rp = await toolLoop.executeTool('run_shell', { command: 'grep -c two scripts/__repeat_probe.txt' });
    const rp2 = await toolLoop.executeTool('run_shell', { command: 'grep -c two scripts/__repeat_probe.txt' });
    t('repeat: first write executes', r1.ok === true, JSON.stringify(r1));
    t('repeat: identical write executes again (no skip)', r2.ok === true && !r2.skippedDuplicate, JSON.stringify(r2));
    t('repeat: identical write overwrote the file (real execution)', afterDup === 'one');
    t('repeat: different content executes', r3.ok === true, JSON.stringify(r3));
    t('repeat: identical read executes (fresh result, no skip)', rr1.ok === true && rr2.ok === true && !rr2.skippedDuplicate && rr2.content.includes('two'), JSON.stringify(rr2).slice(0, 120));
    t('repeat: identical grep re-run executes (verification after edit)', rp.ok === true && rp2.ok === true && !rp2.skippedDuplicate && /1/.test(String(rp2.stdout || '')), JSON.stringify(rp2).slice(0, 120));

    // delete_file: single-file deletion strictly inside the sandbox — and a
    // repeat of the delete EXECUTES too (clean missing-file error, no skip)
    const P = 'scripts/__del_probe.txt';
    await toolLoop.executeTool('write_file', { path: P, content: 'bye' });
    const d1 = await toolLoop.executeTool('delete_file', { path: P });
    t('delete_file: removes an existing file', d1.ok === true && d1.deleted === true, JSON.stringify(d1));
    t('delete_file: file really gone', !fs.existsSync(path.join(process.env.PLIFE_WORK_ROOT, 'workspaces', P)));
    const d2 = await toolLoop.executeTool('delete_file', { path: P });
    t('delete_file: identical repeat executes (clean missing-file error)', !d2.ok && !d2.skippedDuplicate && /no such file/.test(d2.error || ''), JSON.stringify(d2));
    const d2b = await toolLoop.executeTool('delete_file', { path: 'nope.txt' });
    t('delete_file: missing file reports cleanly', !d2b.ok && /no such file/.test(d2b.error || ''), JSON.stringify(d2b));
    const d3 = await toolLoop.executeTool('delete_file', { path: 'scripts' });
    t('delete_file: directory refused (never recursive)', !d3.ok && /directory/.test(d3.error || ''), JSON.stringify(d3));
    const d4 = await toolLoop.executeTool('delete_file', { path: '../../outside.txt' });
    t('delete_file: two-level traversal outside the project refused', !d4.ok, JSON.stringify(d4));
    const d4b = await toolLoop.executeTool('delete_file', { path: '../outside.txt' });
    t('delete_file: single ../ is project-root-zone now (missing file, not an escape error)', !d4b.ok && /no such file/.test(d4b.error || '') && !/escape|traversal/i.test(d4b.error || ''), JSON.stringify(d4b));
    const d5 = await toolLoop.executeTool('delete_file', { path: '/etc/passwd' });
    t('delete_file: absolute path outside workspace refused', !d5.ok, JSON.stringify(d5));

    // file-argument normalization: alias keys (file/filepath/filename/src)
    // and bare unkeyed strings map to `path` so the call EXECUTES instead of
    // being rejected into a repeated-invalid retry loop
    {
      const D = process.env.PLIFE_WORK_ROOT;
      const WS = path.join(D, 'workspaces');
      fs.mkdirSync(path.join(WS, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(WS, 'scripts', '__norm_probe.txt'), 'norm-probe-content');
      fs.writeFileSync(path.join(WS, 'scripts', '__norm_del.txt'), 'x');
      const r1 = await toolLoop.executeTool('read_file', { file: 'scripts/__norm_probe.txt' });
      t('arg-norm: read_file with {file:...} executes', r1.ok === true && /norm-probe-content/.test(r1.content || ''), JSON.stringify(r1).slice(0, 120));
      const r2 = await toolLoop.executeTool('read_file', 'scripts/__norm_probe.txt');
      t('arg-norm: read_file with bare string args executes', r2.ok === true && r2.path === 'workspaces/scripts/__norm_probe.txt', JSON.stringify(r2).slice(0, 120));
      const r3 = await toolLoop.executeTool('read_file', { filename: 'scripts/__norm_probe.txt' });
      t('arg-norm: read_file with {filename:...} executes', r3.ok === true && r3.path === 'workspaces/scripts/__norm_probe.txt', JSON.stringify(r3).slice(0, 120));
      const r4 = await toolLoop.executeTool('write_file', { file: 'scripts/__norm_probe2.txt', content: 'written via alias' });
      t('arg-norm: write_file with {file, content} executes', r4.ok === true && fs.readFileSync(path.join(WS, 'scripts', '__norm_probe2.txt'), 'utf8') === 'written via alias', JSON.stringify(r4));
      const r4b = await toolLoop.executeTool('write_file', { file: 'scripts/__norm_probe2.txt', content: 'written via alias' });
      t('arg-norm: alias-keyed repeat executes', r4b.ok === true && !r4b.skippedDuplicate, JSON.stringify(r4b));
      const r5 = await toolLoop.executeTool('delete_file', { src: 'scripts/__norm_del.txt' });
      t('arg-norm: delete_file with {src:...} executes', r5.ok === true && r5.deleted === true, JSON.stringify(r5));
      const r6 = await toolLoop.executeTool('edit_file', { file: 'scripts/__norm_probe.txt', old_text: 'norm-probe-content', new_text: 'edited' });
      t('arg-norm: edit_file with {file,...} executes', r6.ok === true && fs.readFileSync(path.join(WS, 'scripts', '__norm_probe.txt'), 'utf8') === 'edited', JSON.stringify(r6));
      const r7 = await toolLoop.executeTool('read_file', {});
            t(
              'arg-norm: still-empty args rejected WITH the expected format hint',
              !r7.ok && r7.invalidArgs === true && /Expected format: {"path": "relative\/file\/path\.ext"}/.test(r7.error || ''),
              JSON.stringify(r7)
            );
          }

          // run_shell argument normalization: alias keys (cmd/exec/script/c/
          // shell_command) and bare unkeyed strings map to `command` so the call
          // EXECUTES (the gemma 4B reported failure mode — empty/aliased commands)
          {
            for (const [alias, cmd] of [
              ['cmd', 'printf shell-norm-cmd'],
              ['exec', 'printf shell-norm-exec'],
              ['script', 'printf shell-norm-script'],
              ['c', 'printf shell-norm-c'],
              ['shell_command', 'printf shell-norm-sc'],
            ]) {
              const r = await toolLoop.executeTool('run_shell', { [alias]: cmd });
              t(`arg-norm: run_shell {${alias}:...} executes`, r.ok === true && /shell-norm-/.test(String(r.stdout || '')), JSON.stringify(r).slice(0, 100));
            }
            const rs = await toolLoop.executeTool('run_shell', 'printf shell-norm-bare');
            t('arg-norm: run_shell bare string executes', rs.ok === true && /shell-norm-bare/.test(String(rs.stdout || '')), JSON.stringify(rs).slice(0, 100));
            const rEmpty = await toolLoop.executeTool('run_shell', {});
            t(
              'arg-norm: empty run_shell rejected WITH the command format hint',
              !rEmpty.ok && rEmpty.invalidArgs === true && /Expected format: {"command": "your_shell_command_here"}/.test(rEmpty.error || ''),
              JSON.stringify(rEmpty)
            );
            const rPlaceholder = await toolLoop.executeTool('run_shell', { command: 'your_shell_command_here' });
            t('arg-norm: placeholder command still rejected (hint text never executes)', !rPlaceholder.ok && rPlaceholder.invalidArgs === true && /placeholder/.test(rPlaceholder.error || ''), JSON.stringify(rPlaceholder));
          }

    // groupIndependent: parallel-grouping contract for the batch scheduler
    {
      const g = toolLoop.groupIndependent;
      const WW = (p) => ({ name: 'write_file', args: { path: p, content: 'x' } });
      const RR = (p) => ({ name: 'read_file', args: { path: p } });
      t('batch: independent file ops share one group', g([WW('a.txt'), WW('b.txt')]).length === 1);
      t('batch: same-path write+read split into two groups', g([WW('a.txt'), RR('a.txt')]).length === 2);
      t('batch: different-path read+delete stay parallel', g([RR('a.txt'), { name: 'delete_file', args: { path: 'b.txt' } }]).length === 1);
      t('batch: run_shell serializes with everything', g([{ name: 'run_shell', args: { command: 'ls' } }, WW('a.txt')]).length === 2);
      t('batch: write-then-run same file split (dependency order)', g([WW('run.py'), { name: 'run_shell', args: { command: 'python run.py' } }]).length === 2);
      t('batch: dir listing splits from writes inside it', g([{ name: 'list_files', args: { path: 'scripts' } }, WW('scripts/x.sh')]).length === 2);
      t('batch: sibling writes inside one dir stay parallel', g([WW('d/x.txt'), WW('d/y.txt')]).length === 1);
      t('batch: automations serialize (shared state store)', g([{ name: 'create_automation', args: { name: 'a' } }, { name: 'list_automations', args: {} }]).length === 2);
      t('batch: run_skill serializes (arbitrary code)', g([{ name: 'run_skill', args: { name: 'p' } }, WW('a.txt')]).length === 2);
      t('batch: skill store ops serialize with each other', g([{ name: 'write_skill', args: { name: 's' } }, { name: 'delete_skill', args: { name: 't' } }]).length === 2);
      t('batch: unknown tool is conservative (serializes)', g([{ name: 'mystery_tool', args: {} }, WW('a.txt')]).length === 2);
      t('batch: identical duplicates never share a group', g([WW('a.txt'), WW('a.txt')]).length === 2);
    }

    // repeated list after a state change returns FRESH data
    const la1 = await toolLoop.executeTool('list_automations', {});
    const la2 = await toolLoop.executeTool('list_automations', {});
    t('list_automations: repeat executes (fresh data, never a skip)', la1.ok === true && la2.ok === true && !la2.skippedDuplicate, JSON.stringify(la2));

    // No redundant-churn guard either: a delete of something created this
    // request is a normal call and executes (the model decides; guidance
    // only)
    await toolLoop.executeTool('write_file', { path: 'scripts/__churn.txt', content: 'x' });
    const ch1 = await toolLoop.executeTool('delete_file', { path: 'scripts/__churn.txt' });
    t('churn: delete of file created this request executes', ch1.ok === true && ch1.deleted === true, JSON.stringify(ch1));
    t('churn: the file is really gone', !fs.existsSync(path.join(process.env.PLIFE_WORK_ROOT, 'workspaces', 'scripts/__churn.txt')));
    const ch2 = await toolLoop.executeTool('delete_file', { path: 'scripts/__churn.txt' });
    t('churn: repeated delete reports the missing file cleanly', !ch2.ok && !ch2.skippedDuplicate && /no such file/.test(ch2.error || ''), JSON.stringify(ch2));

    const ca = await toolLoop.executeTool('create_automation', {
      name: 'Churn Temp',
      description: 'temp',
      schedule_type: 'interval',
      interval_minutes: 5,
      action_type: 'script',
      script: 'scripts/churn.sh',
    });
    const da = await toolLoop.executeTool('delete_automation', { id: 'churn-temp' });
    t('churn: automation delete executes right after create', ca.ok === true && da.ok === true, JSON.stringify(da));

    // read repeat (identical re-reads execute — the verification workflow):
    const rrA = await toolLoop.executeTool('read_file', { path: 'scripts/__repeat_probe.txt' });
    const rrB = await toolLoop.executeTool('read_file', { path: 'scripts/__repeat_probe.txt' });
    t('repeat: read_file repeat executes with fresh content', rrA.ok === true && rrB.ok === true && !rrB.skippedDuplicate && rrB.content.includes('two'), JSON.stringify(rrB).slice(0, 120));

    // run_shell: no consecutive guard — identical back-to-back commands all
    // execute (intentional double runs and verification re-runs both work)
    const sh1 = await toolLoop.executeTool('run_shell', { command: 'node -e "console.log(1)"' });
    const sh2 = await toolLoop.executeTool('run_shell', { command: 'node -e "console.log(1)"' });
    t('repeat: run_shell back-to-back identical repeat executes', sh1.ok && sh2.ok && !sh2.skippedDuplicate, JSON.stringify(sh2));
    const sh2b = await toolLoop.executeTool('run_shell', { command: "node -e 'console.log(1)'" });
    t('repeat: re-quoted identical command executes too', sh2b.ok === true && !sh2b.skippedDuplicate, JSON.stringify(sh2b));
    const sh3 = await toolLoop.executeTool('run_shell', { command: 'node -e "console.log(2)"' });
    const sh4 = await toolLoop.executeTool('run_shell', { command: 'node -e "console.log(1)"' });
    t('repeat: repeat after another step executes', sh3.ok && sh4.ok && !sh4.skippedDuplicate, JSON.stringify(sh4));
    const sf1 = await toolLoop.executeTool('run_shell', { command: 'node -e "process.exit(3)"' });
    const sf2 = await toolLoop.executeTool('run_shell', { command: 'node -e "process.exit(3)"' });
    t('repeat: retry of a FAILED command executes (recovery)', !sf1.ok && !sf2.ok && !sf2.skippedDuplicate, JSON.stringify(sf2));

    // ---- shell URL-quoting (guidance, not enforcement) ---------------------
    // The quoted-vs-unquoted retry saga is moot: every command executes as
    // emitted. The URL-quoting guidance lives in the prompt; the only thing
    // to pin here is that corrected retries NEVER bounce off any guard.
    {
      const bad = 'curl -s http://127.0.0.1:9/prices?ids=solana&vs_currencies=usd';
      const good = 'curl -s "http://127.0.0.1:9/prices?ids=solana&vs_currencies=usd"';
      const rBad = await toolLoop.executeTool('run_shell', { command: bad });
      t('url-retry: unquoted & command exits 0 but produces no output', rBad.ok === true && !(rBad.stdout || rBad.stderr), JSON.stringify(rBad));
      const rGood = await toolLoop.executeTool('run_shell', { command: good });
      t('url-retry: corrected quoted retry executes (never blocked)', !rGood.skippedDuplicate && rGood.ok === false && rGood.code === 7, JSON.stringify(rGood).slice(0, 140));
      const e1 = await toolLoop.executeTool('run_shell', { command: 'echo url-ok' });
      const e2 = await toolLoop.executeTool('run_shell', { command: 'echo "url-ok"' });
      t('url-retry: re-quoted command with output executes', e1.ok === true && e2.ok === true && !e2.skippedDuplicate, JSON.stringify(e2));
      const f1 = await toolLoop.executeTool('run_shell', { command: 'echo probe; x=1' });
      const f2 = await toolLoop.executeTool('run_shell', { command: 'echo "probe"; x=1' });
      t('url-retry: quoted retry after output+unquoted-ops executes', f1.ok === true && f2.ok === true && !f2.skippedDuplicate, JSON.stringify(f2).slice(0, 120));
      const g1 = await toolLoop.executeTool('run_shell', { command: 'echo "a&b"' });
      const g2 = await toolLoop.executeTool('run_shell', { command: 'echo "a&b"' });
      t('url-retry: repeated correctly-quoted command executes', g1.ok === true && g2.ok === true && !g2.skippedDuplicate, JSON.stringify(g2).slice(0, 120));
    }

    // create_automation repeats (execute stubbed — no real state writes here):
    const createDef = registry.find((x) => x.name === 'create_automation');
    const origExec = createDef.execute;
    let execCount = 0;
    createDef.execute = () => { execCount += 1; return { ok: true, message: 'stub' }; };
    const caArgs = { name: 'Dup', schedule_type: 'interval', interval_minutes: 5, action_type: 'script', script: 'scripts/__repeat_probe.txt' };
    const ca1 = await toolLoop.executeTool('create_automation', caArgs);
    const ca2 = await toolLoop.executeTool('create_automation', caArgs);
    createDef.execute = origExec;
    t('repeat: create_automation first executes', ca1.ok && !ca1.skippedDuplicate);
    t('repeat: identical create_automation executes again (no skip)', ca2.ok === true && !ca2.skippedDuplicate, JSON.stringify(ca2));
    t('repeat: create_automation executed twice (real repeat)', execCount === 2);

    // ---- no repetition detection, no round ceiling ---------------------
    // Identical consecutive calls and A-B-A-B-A cycles all EXECUTE: a model
    // re-running a check after an edit is legitimate, not a loop.
    {
      const g1 = await toolLoop.executeTool('run_shell', { command: 'node -e "console.log(10)"' });
      const g2 = await toolLoop.executeTool('run_shell', { command: 'node -e "console.log(10)"' });
      t('rep: consecutive identical exempt call executes', g1.ok && g2.ok && !g2.skippedDuplicate, JSON.stringify(g2));
      const g3 = await toolLoop.executeTool('run_shell', { command: 'node -e "console.log(11)"' });
      t('rep: fresh call after repeat executes', g3.ok === true, JSON.stringify(g3));
    }
    {
      const a = await toolLoop.executeTool('run_shell', { command: 'node -e "console.log(20)"' });
      const b = await toolLoop.executeTool('run_shell', { command: 'node -e "console.log(21)"' });
      const a2 = await toolLoop.executeTool('run_shell', { command: 'node -e "console.log(20)"' });
      t('rep: single A-B-A round-trip executes', a.ok && b.ok && a2.ok === true && !a2.skippedDuplicate, JSON.stringify(a2));
      const b2 = await toolLoop.executeTool('run_shell', { command: 'node -e "console.log(21)"' });
      const a3 = await toolLoop.executeTool('run_shell', { command: 'node -e "console.log(20)"' });
      t('rep: A-B-A-B-A cycle also executes (no alternation guard)', a3.ok === true && !a3.skippedDuplicate, JSON.stringify(a3));
      const c = await toolLoop.executeTool('run_shell', { command: 'node -e "console.log(22)"' });
      t('rep: fresh step after cycle executes', c.ok === true, JSON.stringify(c));
    }
    {
      const f1 = await toolLoop.executeTool('run_shell', { command: 'node -e "process.exit(9)"' });
      const f2 = await toolLoop.executeTool('run_shell', { command: 'node -e "process.exit(9)"' });
      t('rep: repeat of a FAILED call executes (recovery)', !f1.ok && !f2.ok && !f2.skippedDuplicate, '');
    }
    {
      // run_automation identical repeat executes (execute stubbed):
      const raDef = registry.find((x) => x.name === 'run_automation');
      const origRa = raDef.execute;
      raDef.execute = async () => ({ ok: true, message: 'stub' });
      const r1 = await toolLoop.executeTool('run_automation', { id: 'probe-rule' });
      const r2 = await toolLoop.executeTool('run_automation', { id: 'probe-rule' });
      raDef.execute = origRa;
      t('rep: run_automation identical repeat executes (no exempt guard)', r1.ok === true && r2.ok === true && !r2.skippedDuplicate, JSON.stringify(r2));
    }
    {
      // Long unique multi-step progression — no ceiling anywhere: every step
      // executes until the model naturally answers.
      let allOk = true;
      for (let i = 100; i < 130; i++) {
        const r = await toolLoop.executeTool('run_shell', { command: `node -e "console.log(${i})"` });
        if (!r.ok) { allOk = false; break; }
      }
      t('rep: 30-step unique progression all executes', allOk === true, '');
    }

    // ---- anti-spam nets (chmod on .py / pre-reading logs) ------------------
    {
      const cp = await toolLoop.executeTool('run_shell', { command: 'chmod +x scripts/whatever.py' });
      t('anti-spam: chmod on .py skipped', cp.ok === false && cp.skippedAntiSpam === true, JSON.stringify(cp));
      t('anti-spam: chmod message explains the runner', /python3 runner/.test(cp.error || ''), String((cp.error || '').slice(0, 80)));
      const multi = await toolLoop.executeTool('run_shell', { command: 'chmod 755 scripts/a.py scripts/b.py' });
      t('anti-spam: chmod 755 on .py skipped too', multi.ok === false && multi.skippedAntiSpam === true, JSON.stringify(multi));
      const okSh = await toolLoop.executeTool('run_shell', { command: 'chmod +x scripts/real.sh' });
      t('anti-spam: chmod on .sh still executes (not skipped)', okSh.ok === true || (okSh.code !== undefined && !okSh.skippedAntiSpam), JSON.stringify(okSh));
    }
    {
      const m1 = await toolLoop.executeTool('read_file', { path: 'logs/__never.log' });
      t('anti-spam: missing logs/ read explains the schedule', m1.ok === false && /schedule/.test(m1.error || ''), JSON.stringify(m1));
      const m2 = await toolLoop.executeTool('read_file', { path: 'src/__absent.txt' });
      t('anti-spam: non-log missing file keeps the generic error', m2.ok === false && !/schedule/.test(m2.error || ''), JSON.stringify(m2));
    }
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
    t('valid: corrected retry executes', v6.ok === true && !v6.skippedDuplicate, JSON.stringify(v6));
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
    const l1 = await toolLoop.executeTool('list_automations', {});
    t('valid: no-required tool with {} passes', l1.ok === true, JSON.stringify(l1));
    const l2 = await toolLoop.executeTool('read_file', { path: 'ok.txt' });
    t('valid: first read executes after validation', l2.ok === true);
    const l3 = await toolLoop.executeTool('read_file', { path: 'ok.txt' });
    t('valid: repeated read executes (fresh result, no dedup)', l3.ok === true && !l3.skippedDuplicate, JSON.stringify(l3));
  }

  // =========================================================================
  // 3c) Workspace zones — the two-zone resolution contract: bare relative
  // paths land in the AGENT WORKSPACE (workRoot/workspaces/), ".." walks UP
  // to the project root, two-level traversal and absolute paths stay
  // rejected. run_shell starts in the workspace.
  // =========================================================================
  {
    const WORK = process.env.PLIFE_WORK_ROOT;
    const WS = path.join(WORK, 'workspaces');
    const z1 = await toolLoop.executeTool('write_file', { path: 'zones/a.txt', content: 'zone-a' });
    t('zone: bare write lands in the agent workspace', z1.ok === true && fs.existsSync(path.join(WS, 'zones', 'a.txt')) && !fs.existsSync(path.join(WORK, 'zones', 'a.txt')), JSON.stringify(z1));
    const z2 = await toolLoop.executeTool('read_file', { path: 'zones/a.txt' });
    t('zone: bare read round-trips from the workspace', z2.ok === true && z2.content === 'zone-a' && z2.path === 'workspaces/zones/a.txt', JSON.stringify(z2).slice(0, 100));
    const z3 = await toolLoop.executeTool('write_file', { path: 'workspaces/zones/b.txt', content: 'zone-b' });
    t('zone: a path that already names the workspace is not doubled', z3.ok === true && fs.existsSync(path.join(WS, 'zones', 'b.txt')) && !fs.existsSync(path.join(WS, 'workspaces')), JSON.stringify(z3));
    // project-root zone
    fs.writeFileSync(path.join(WORK, 'zone-root.txt'), 'root-content');
    const z4 = await toolLoop.executeTool('read_file', { path: '../zone-root.txt' });
    t('zone: ../x reaches the project root', z4.ok === true && z4.content === 'root-content' && z4.path === 'zone-root.txt', JSON.stringify(z4).slice(0, 100));
    const z5 = await toolLoop.executeTool('write_file', { path: '../zone-write.txt', content: 'root-write' });
    t('zone: ../ write targets the project root', z5.ok === true && fs.existsSync(path.join(WORK, 'zone-write.txt')) && !fs.existsSync(path.join(WS, 'zone-write.txt')), JSON.stringify(z5));
    const z6 = await toolLoop.executeTool('edit_file', { path: '../zone-root.txt', old_text: 'root-content', new_text: 'root-edited' });
    t('zone: ../ edit targets the project root', z6.ok === true && fs.readFileSync(path.join(WORK, 'zone-root.txt'), 'utf8') === 'root-edited', JSON.stringify(z6));
    const z7 = await toolLoop.executeTool('delete_file', { path: '../zone-root.txt' });
    t('zone: ../ delete targets the project root', z7.ok === true && !fs.existsSync(path.join(WORK, 'zone-root.txt')), JSON.stringify(z7));
    // listings
    const z8 = await toolLoop.executeTool('list_files', {});
    t('zone: list_files with no path lists the agent workspace', z8.ok === true && Array.isArray(z8.entries) && z8.entries.some((e) => /^zones$/.test(e.name)), JSON.stringify(z8).slice(0, 120));
    const z9 = await toolLoop.executeTool('list_files', { path: '..' });
    t('zone: list_files .. lists the project root', z9.ok === true && Array.isArray(z9.entries) && z9.entries.some((e) => /^workspaces$/.test(e.name)), JSON.stringify(z9).slice(0, 160));
    // shell cwd
    const z10 = await toolLoop.executeTool('run_shell', { command: 'pwd' });
    t('zone: run_shell starts in the agent workspace', z10.ok === true && /\/workspaces\/?\s*$/.test(z10.stdout || ''), JSON.stringify(z10).slice(0, 140));
    const z11 = await toolLoop.executeTool('run_shell', { command: 'cd .. && pwd' });
    t('zone: run_shell cd .. reaches the project root', z11.ok === true && String(z11.stdout || '').trim() === path.resolve(WORK), JSON.stringify(z11).slice(0, 140));
    // escapes stay rejected
    const z12 = await toolLoop.executeTool('read_file', { path: '../../esc-probe.txt' });
    t('zone: two-level traversal still refused', !z12.ok && /escape|outside|traversal/i.test(z12.error || ''), JSON.stringify(z12));
    const z13 = await toolLoop.executeTool('read_file', { path: '/etc/hostname' });
    t('zone: absolute path still refused', !z13.ok && /escape|outside|traversal/i.test(z13.error || ''), JSON.stringify(z13));
    try { fs.unlinkSync(path.join(WORK, 'zone-write.txt')); } catch {}
  }

  // =========================================================================
  // 4) End-to-end: real chat router + mocked upstream
  // =========================================================================
  const express = require('express');
  const llamaClient = require(path.join(ROOT, 'services', 'llamaClient'));

  // -- patch complete(), then re-require the router so it binds the mock --
  const callLog = []; // every payload seen by the mock
  let seq = [];
  let mockDeferSeen = false; // registry net: set when a deferred round is pending
  llamaClient.complete = function (opts) {
    const acc = seq.shift();
    if (acc === undefined) throw new Error('mock exhausted — loop ran more steps than canned');
    callLog.push({ payload: opts.payload, messages: opts.payload.messages.map((m) => ({ role: m.role, content: m.content })) });
    // Live-stream the canned round exactly like the real upstream: content
    // via onDelta and the reasoning trace via onReasoning. Deferred to a
    // microtask — the REAL upstream is async (its deltas arrive after the
    // SSE headers are open); a synchronous emit would write to the response
    // before openSse() and crash with ERR_HTTP_HEADERS_SENT. The callbacks
    // still fire before the round resolves, so the loop's round-boundary
    // events always follow the text they refer to (order pinned by e2e-G).
    // `defer: <promise>` (registry net) blocks the round on a test gate so a
    // mid-turn state snapshot can be taken.
    const emit = () => {
      if (acc.reasoning && opts.onReasoning) opts.onReasoning(acc.reasoning);
      if (acc.content && opts.onDelta) opts.onDelta(acc.content);
      return acc;
    };
    const p = acc.defer ? acc.defer.then(emit) : Promise.resolve().then(emit);
    Object.defineProperty(p, 'position', { value: 1, enumerable: true });
    if (opts.onUsage && acc.usage) opts.onUsage(acc.usage);
    if (acc.defer) mockDeferSeen = true;
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
    seq = canned.map((c) => ({ content: c.content || '', reasoning: c.reasoning || '', toolCalls: c.toolCalls || [], finishReason: c.finishReason || 'stop', usage: { prompt_tokens: 100, completion_tokens: 50 } }));
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
    const toolEvents = events.filter((e) => e.type === 'tool');
    const text = events
      .filter((e) => e.choices && e.choices[0] && e.choices[0].delta && typeof e.choices[0].delta.content === 'string')
      .map((e) => e.choices[0].delta.content)
      .join('');
    return { events, statuses, toolEvents, text, steps: callLog.length, callLog };
  }

  // ----- REG) turn-state registry: GET /api/chat/state/:sessionId ----------
  // Mid-turn the frontend can re-attach to a stream it lost the reader for
  // (hard refresh); after completion the record stays readable for a grace
  // window. The deferred round holds the loop open so we can snapshot it.
  {
    let release = null;
    const gate = new Promise((r) => { release = r; });
    mockDeferSeen = false;
    seq = [
      { content: '', reasoning: '', toolCalls: [{ index: 0, id: 'r1', name: 'run_shell', arguments: '{"command":"free -h"}' }], finishReason: 'tool_calls', usage: { prompt_tokens: 100, completion_tokens: 10 }, defer: gate },
      { content: 'Here is the current memory usage.', reasoning: '', toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 110, completion_tokens: 20 } },
    ];
    const regFetch = fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'memory status' }], generation: {}, sessionId: 'sess-reg' }),
    });
    for (let i = 0; i < 100 && !mockDeferSeen; i++) await new Promise((r) => setTimeout(r, 20));
    const mid = await (await fetch(`http://127.0.0.1:${port}/api/chat/state/sess-reg`)).json();
    t('reg: mid-turn state is active with a statuses/text buffer', mid.ok === true && mid.active === true && Array.isArray(mid.statuses) && typeof mid.text === 'string', JSON.stringify(mid).slice(0, 120));
    release();
    const regBody = await (await regFetch).text();
    t('reg: turn completes normally', regBody.includes('[DONE]'), regBody.slice(-40));
    const done = await (await fetch(`http://127.0.0.1:${port}/api/chat/state/sess-reg`)).json();
    t('reg: after completion active:false + final text captured', done.ok === true && done.active === false && done.text.includes('memory usage'), JSON.stringify(done).slice(0, 160));
    const unknown = await fetch(`http://127.0.0.1:${port}/api/chat/state/no-such-session`);
    t('reg: unknown session -> 404', unknown.status === 404);
  }

  // ----- A) regression: duplicate write_file + successful create -> final answer
  {
    const writeArgs = '{"path":"scripts/t.js","content":"console.log(new Date());"}';
    const { statuses, text, steps, callLog } = await runChat(
      'can you create for me a basic script under scripts directory that will output the current time, then create an automation that runs it every 5 minutes and writes a log of its output',
      [
        { toolCalls: [{ index: 0, id: 'c1', name: 'write_file', arguments: writeArgs }] },
        { toolCalls: [{ index: 0, id: 'c2', name: 'write_file', arguments: writeArgs }] }, // EXACT duplicate
        { toolCalls: [{ index: 0, id: 'c3', name: 'create_automation', arguments: '{"name":"Time Log","schedule_type":"interval","interval_minutes":5,"action_type":"script","script":"workspaces/scripts/t.js"}' }] },
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
    t('e2e-A: final answer streamed', /All set!/.test(text), text.slice(0, 80));
    t('e2e-A: completed in 5 steps', steps === 5, `steps=${steps}`);
    t('e2e-A: duplicate write EXECUTED — two successful write results', okWrites === 2, `ok=${okWrites}`);
    t('e2e-A: no duplicate-skip message anywhere', !dupResultVisible);
    t('e2e-A: no forcing rounds triggered', !statuses.some((s) => s.includes('forcing a tool call')), statuses.join(' | '));
    t('e2e-A: no interception triggered', !statuses.some((s) => s.includes('intercepted')), statuses.join(' | '));
    t('e2e-A: file written once to temp workspace', fs.readFileSync(path.join(process.env.PLIFE_WORK_ROOT, 'workspaces', 'scripts', 't.js'), 'utf8') === 'console.log(new Date());');
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
    t('e2e-D: file has the real content', fs.readFileSync(path.join(process.env.PLIFE_WORK_ROOT, 'workspaces', 'notes.txt'), 'utf8') === 'hi there');
    t('e2e-D: no junk ? file created', !fs.existsSync(path.join(process.env.PLIFE_WORK_ROOT, '?')));
  }

  // ----- E) automation scripts run with the WORKSPACE ROOT as cwd: relative
  // `logs/...` redirections land in the workspace where the agent's file tools
  // (and the user) can inspect them, and logs/ is ensured to exist
  {
    const automationManager = require(path.join(ROOT, 'services', 'automationManager'));
    const stamp = Date.now();
    const probe = `scripts/__logprobe_${stamp}.sh`;
    const logName = `__logprobe_${stamp}.log`;
    fs.mkdirSync(path.join(process.env.PLIFE_WORK_ROOT, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(process.env.PLIFE_WORK_ROOT, probe), `#!/bin/sh\ndate '+%Y-%m-%d %H:%M:%S' > logs/${logName}\necho probe-ran\n`);
    const created = await toolLoop.executeTool('create_automation', {
      name: 'Log Probe',
      description: 'probe',
      schedule_type: 'interval',
      interval_minutes: 5,
      action_type: 'script',
      script: probe,
    });
    t('e2e-E: probe automation created', created.ok === true, JSON.stringify(created));
    const rn = await automationManager.runNow('log-probe');
    t('e2e-E: runNow accepted the trigger', rn.ok === true, JSON.stringify(rn));
    let found = null;
    for (let i = 0; i < 100 && found === null; i++) {
      const p = path.join(process.env.PLIFE_WORK_ROOT, 'logs', logName);
      if (fs.existsSync(p)) {
        // shell redirection creates the file empty, then the command fills
        // it — wait for actual content, not just the inode
        const raw = fs.readFileSync(p, 'utf8');
        if (raw && raw.trim()) found = raw;
      }
      if (found === null) await new Promise((r) => setTimeout(r, 100));
    }
    t('e2e-E: relative logs/ resolved to the workspace root', found !== null, found === null ? 'log file never appeared' : found.trim());
    t('e2e-E: log content is the script output', found !== null && /\d{4}-\d{2}-\d{2}/.test(found), String(found));
    try { fs.unlinkSync(path.join(process.env.PLIFE_WORK_ROOT, probe)); } catch {}
    try { fs.unlinkSync(path.join(process.env.PLIFE_WORK_ROOT, 'logs', logName)); } catch {}
  }

  // ----- F) identical repeated calls keep executing: no duplicate-skip and
  // no duplicate-based freeze (the reported failure mode — a model re-
  // checking a file gets fresh results every time, never a block)
  {
    const dupCall = {
      index: 0,
      id: 'x1',
      name: 'read_file',
      arguments: '{"path":"logs/__e2e_missing.log"}',
    };
    const { statuses, text, steps, callLog } = await runChat('check the file logs/__e2e_missing.log for me', [
      { toolCalls: [dupCall] }, // round 1: executes (fresh error result)
      { toolCalls: [dupCall] }, // round 2: executes again
      { toolCalls: [dupCall] }, // round 3: executes again
      { toolCalls: [dupCall] }, // round 4: executes again
      { content: 'No log yet — I checked and it is not there.', finishReason: 'stop' },
    ]);
    const executed = callLog.filter((c) =>
      c.messages.some((m) => m.content && m.content.includes('read_file: {"ok":false'))
    ).length;
    const scheduleHint = callLog.every((c) =>
      c.messages.some((m) => m.content && m.content.includes('schedule'))
    );
    t('e2e-F: final answer served after four identical re-checks', text.includes('I checked'), text.slice(0, 120));
    t('e2e-F: NO freeze status (no duplicate-based stop)', !statuses.some((s) => s.includes('⛔')), JSON.stringify(statuses).slice(0, 700));
    t('e2e-F: all four identical reads executed', executed >= 4, `executed=${executed}`);
    t('e2e-F: every re-check carried the schedule hint', scheduleHint);
    t('e2e-F: loop bounded by the canned rounds', steps === 5, `steps=${steps}`);
  }

  // ----- G) live streaming: reasoning relay + round boundary events
  // Every loop round's deltas stream to the client live; the round events
  // tell the frontend to keep the final round's text and wipe transient
  // tool-JSON rounds. The final answer must arrive BEFORE its round-final
  // event and must NOT be re-emitted by the end-of-request flush.
  {
    const { events, text } = await runChat('live-stream check', [
      { content: '<tools>\n{"tool":"write_file","args":{"path":"scripts/__rs_probe.txt","content":"rs"}}\n</tools>' },
      {
        content: 'The file is written.',
        reasoning: 'User asked to write a file; write_file is the right tool for that.',
      },
    ]);
    const idxFinalRound = events.findIndex((e) => e.type === 'round' && e.final === true);
    const idxToolRound = events.findIndex((e) => e.type === 'round' && e.final === false);
    const idxFinalText = events.findIndex(
      (e) => e.choices && e.choices[0] && e.choices[0].delta && typeof e.choices[0].delta.content === 'string' && e.choices[0].delta.content.includes('The file is written')
    );
    const idxFirstJson = events.findIndex(
      (e) => e.choices && e.choices[0] && e.choices[0].delta && typeof e.choices[0].delta.content === 'string' && e.choices[0].delta.content.includes('write_file')
    );
    const idxReasoning = events.findIndex(
      (e) => e.choices && e.choices[0] && e.choices[0].delta && typeof e.choices[0].delta.reasoning === 'string'
    );
    t('e2e-G: tool round closed non-final, final round closed final', idxToolRound !== -1 && idxFinalRound !== -1 && idxToolRound < idxFinalRound, `tool@${idxToolRound} final@${idxFinalRound}`);
    t('e2e-G: tool JSON reached the client live before its wipe event', idxFirstJson !== -1 && idxFirstJson < idxToolRound, `json@${idxFirstJson}`);
    t('e2e-G: final answer streamed BEFORE the round-final event', idxFinalText !== -1 && idxFinalRound !== -1 && idxFinalText < idxFinalRound, `text@${idxFinalText} round@${idxFinalRound}`);
    t('e2e-G: reasoning trace streamed before the round-final event', idxReasoning !== -1 && idxReasoning < idxFinalRound, `reasoning@${idxReasoning}`);
    const afterFinal = events
      .slice(idxFinalRound + 1)
      .filter((e) => e.choices && e.choices[0] && e.choices[0].delta && typeof e.choices[0].delta.content === 'string');
    t('e2e-G: no duplicate re-emission after the final round', afterFinal.length === 0, `after=${afterFinal.length}`);
    const occ = (text.match(/The file is written\./g) || []).length;
    t('e2e-G: final answer appears exactly once end-to-end', occ === 1, `occ=${occ} text=${text.slice(0, 140)}`);
    try { fs.unlinkSync(path.join(process.env.PLIFE_WORK_ROOT, 'workspaces', 'scripts', '__rs_probe.txt')); } catch {}
  }

  // ----- H) the reported failure mode: alias-keyed read_file args must
  // EXECUTE (not be rejected into a 7-round retry -> anti-spam freeze)
  {
    const D = process.env.PLIFE_WORK_ROOT;
    const WS = path.join(D, 'workspaces');
    fs.mkdirSync(path.join(WS, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(WS, 'scripts', 'get_solana_price.py'), 'import requests\nprint("solana price")\n');
    const { statuses, text, steps, callLog } = await runChat('can you check and refactor: scripts/get_solana_price.py', [
      { toolCalls: [{ index: 0, id: 'h1', name: 'read_file', arguments: '{"file":"scripts/get_solana_price.py"}' }] },
      { content: 'I checked the file — it fetches the Solana price via the CoinGecko API.', finishReason: 'stop' },
    ]);
    const executed = callLog.some((c) => c.messages.some((m) => m.content && m.content.includes('read_file: {"ok":true')));
    const rejected = statuses.filter((s) => s.includes('Tool call rejected'));
    const froze = statuses.some((s) => s.includes('⛔'));
    t('e2e-H: alias-keyed read_file executed (not rejected)', executed, JSON.stringify(callLog.map((c) => c.messages.map((m) => String(m.content).slice(0, 60)))));
    t('e2e-H: zero rejections for the alias call', rejected.length === 0, statuses.join(' | '));
    t('e2e-H: no anti-spam freeze', !froze, statuses.join(' | '));
    t('e2e-H: loop completed in exactly 2 steps', steps === 2, `steps=${steps}`);
    t('e2e-H: status shows the zoned path (workspace default)', statuses.some((s) => s === '⚙ Reading file: workspaces/scripts/get_solana_price.py'), JSON.stringify(statuses));
    t('e2e-H: final answer streamed', /I checked the file/.test(text), text.slice(0, 100));
    try { fs.unlinkSync(path.join(WS, 'scripts', 'get_solana_price.py')); } catch {}
  }

  // ----- I) fail-fast: the SAME invalid emission repeated 3 times freezes
  // the loop immediately (the only structural stop left — identical broken
  // emissions make zero progress, so they must never spin forever)
  {
    const broken = { index: 0, id: 'i1', name: 'read_file', arguments: '{}' };
    const { statuses, text, steps, callLog } = await runChat('check the file for me please', [
      { toolCalls: [broken] }, // rejected (1st identical)
      { toolCalls: [broken] }, // rejected (2nd identical)
      { toolCalls: [broken] }, // rejected (3rd identical) -> freeze armed here
      { toolCalls: [broken] }, // frozen round: no execution, stop note
      { content: 'I could not read the file.', finishReason: 'stop' }, // deterministic close
    ]);
    const rejections = statuses.filter((s) => s.includes('Tool call rejected'));
    const repeated = statuses.some((s) => s.includes('same invalid tool call was repeated 3 times'));
    const executed = callLog.some((c) => c.messages.some((m) => m.content && m.content.includes('read_file: {"ok":true')));
    t('e2e-I: all three identical calls rejected', rejections.length === 3, JSON.stringify(statuses));
    t('e2e-I: 3rd identical emission froze the loop explicitly', repeated, JSON.stringify(statuses));
    t('e2e-I: no call ever executed', !executed);
    t('e2e-I: loop ended within 5 rounds (not 7)', steps === 5, `steps=${steps}`);
    t('e2e-I: final answer served', /could not read the file/.test(text), text.slice(0, 80));
  }

  // ----- J) conversation-aware recovery: read_file with EMPTY args still
  // works when the conversation names exactly one existing workspace file
  {
    const D = process.env.PLIFE_WORK_ROOT;
    const WS = path.join(D, 'workspaces');
    fs.mkdirSync(path.join(WS, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(WS, 'scripts', 'get_solana_price.py'), 'import requests\nprint("solana price")\n');
    const { statuses, text, steps, callLog } = await runChat('can you check and refactor: scripts/get_solana_price.py', [
      { toolCalls: [{ index: 0, id: 'j1', name: 'read_file', arguments: '{}' }] },
      { content: 'I checked the file — it looks fine.', finishReason: 'stop' },
    ]);
    const executed = callLog.some((c) => c.messages.some((m) => m.content && m.content.includes('read_file: {"ok":true')));
    const inferredStatus = statuses.some((s) => s.includes('Reading file: workspaces/scripts/get_solana_price.py (path inferred from conversation)'));
    t('e2e-J: empty-args read_file executed via conversation path', executed, JSON.stringify(callLog.map((c) => c.messages.map((m) => String(m.content).slice(0, 80)))));
    t('e2e-J: status names the inferred path', inferredStatus, JSON.stringify(statuses));
    t('e2e-J: zero rejections', !statuses.some((s) => s.includes('Tool call rejected')), JSON.stringify(statuses));
    t('e2e-J: completed in 2 steps', steps === 2, `steps=${steps}`);
    t('e2e-J: final answer streamed', /I checked the file/.test(text), text.slice(0, 100));
    // write_file with empty args: path is inferred, but the call still must
    // not execute without content — the rejection names ONLY content
    const { statuses: s2, callLog: log2 } = await runChat('can you check and refactor: scripts/get_solana_price.py', [
      { toolCalls: [{ index: 0, id: 'j2', name: 'write_file', arguments: '{}' }] },
      { toolCalls: [{ index: 0, id: 'j3', name: 'write_file', arguments: '{"path":"scripts/get_solana_price.py","content":"print(42)"}' }] },
      { content: 'Refactored.', finishReason: 'stop' },
    ]);
    const writeInferred = s2.some((s) => s === '⚙ Writing file: workspaces/scripts/get_solana_price.py (path inferred from conversation)');
    const contentOnly = s2.some((s) => s.includes('missing required argument \'content\'') && !s.includes('missing required argument \'path\''));
    const wrote = log2.some((c) => c.messages.some((m) => m.content && m.content.includes('write_file: {"ok":true')));
    t('e2e-J: write_file empty args infers the path in the status', writeInferred, JSON.stringify(s2));
    t('e2e-J: write rejected for content only (path no longer the gap)', contentOnly, JSON.stringify(s2));
    t('e2e-J: valid retry with content executes', wrote);
    try { fs.unlinkSync(path.join(WS, 'scripts', 'get_solana_price.py')); } catch {}
  }

  // ----- K) the reported gemma failure mode: run_shell with ALIAS keys must
  // normalize+execute (no rejection loop), and EMPTY args must reject WITH
  // the command format hint so the model can correct itself
  {
    const { statuses, text, steps, callLog, toolEvents } = await runChat('what is the current status of system resources?', [
      { toolCalls: [{ index: 0, id: 'k1', name: 'run_shell', arguments: '{"cmd":"free -h"}' }] },
      { content: 'Here is the current memory usage.', finishReason: 'stop' },
    ]);
    const executed = callLog.some((c) => c.messages.some((m) => m.content && m.content.includes('run_shell: {"ok":true')));
    const rejected = statuses.filter((s) => s.includes('Tool call rejected'));
    t('e2e-K: alias-keyed run_shell executed (not rejected)', executed, JSON.stringify(callLog.map((c) => c.messages.map((m) => String(m.content).slice(0, 60)))));
    t('e2e-K: zero rejections for the alias call', rejected.length === 0, statuses.join(' | '));
    t('e2e-K: no anti-spam freeze', !statuses.some((s) => s.includes('⛔')), statuses.join(' | '));
    t('e2e-K: status shows the real command (no "Running command: ")', statuses.some((s) => s === '⚙ Running command: free -h'), JSON.stringify(statuses));
    t('e2e-K: completed in exactly 2 steps', steps === 2, `steps=${steps}`);
    t('e2e-K: final answer streamed', /memory usage/.test(text), text.slice(0, 100));
    // Durable tool-run events (persisted history records) — one per executed
    // tool step with tool name, args, outcome and a timestamp.
    const kTools = toolEvents.filter((e) => e.tool === 'run_shell');
    t('e2e-K: tool event streamed for the executed call', kTools.length === 1 && kTools[0].ok === true, JSON.stringify(kTools[0] || {}));
    t('e2e-K: tool event carries args + ts', typeof kTools[0].args === 'string' && kTools[0].args.includes('free -h') && Number.isFinite(kTools[0].ts), JSON.stringify((kTools[0] || {}).args));

    // empty payload: the rejection names the gap AND the expected shape
    const { statuses: s2, steps: st2 } = await runChat('what is the current status of system resources?', [
      { toolCalls: [{ index: 0, id: 'k2', name: 'run_shell', arguments: '{}' }] },
      { content: 'I could not run the command.', finishReason: 'stop' },
    ]);
    const hint = s2.some(
      (s) => s.includes("missing required argument 'command'") && s.includes('Expected format: {"command": "your_shell_command_here"}')
    );
    t('e2e-K: empty run_shell rejected WITH the command format hint', hint, JSON.stringify(s2));
    t('e2e-K: empty-payload run still closed cleanly in 2 steps', st2 === 2, `steps=${st2}`);
  }

  // ----- L) persisted system-prompt override (System view): the chat router
  // sends the OVERRIDE byte-for-byte as the system message, and falls back
  // to the generated template when no override is set.
  {
    const systemPromptSvc = require(path.join(ROOT, 'services', 'systemPrompt'));

    // baseline: no override -> generated template in the payload
    await runChat('anything', [{ content: 'fine.', finishReason: 'stop' }]);
    t('e2e-L: baseline system message is the generated template', /FILE TOOL PAYLOADS/.test(callLog[0].messages[0].content || ''), callLog[0].messages[0].content.slice(0, 40));

    // set an override -> the chat payload carries it verbatim (full replace)
    const custom = 'You are a custom prompt. Reply with exactly: override-ok';
    systemPromptSvc.setOverride(custom);
    await runChat('anything', [{ content: 'override-ok', finishReason: 'stop' }]);
    const sysMsg = callLog[0].messages[0].content || '';
    t('e2e-L: override reaches the model payload verbatim', sysMsg === custom, sysMsg.slice(0, 60));

    // reset -> template again
    systemPromptSvc.resetOverride();
    await runChat('anything', [{ content: 'fine.', finishReason: 'stop' }]);
    t('e2e-L: after reset the template is back in the payload', /FILE TOOL PAYLOADS/.test(callLog[0].messages[0].content || ''), callLog[0].messages[0].content.slice(0, 40));

    // the real override file must not exist afterwards
    t('e2e-L: override file cleaned up (no pollution)', !fs.existsSync(systemPromptSvc.FILE), systemPromptSvc.FILE);
  }

  // ----- N) semantic-memory context reaches the PRIMARY payload (memory
  // tail rides the LAST message; the system prefix stays byte-stable)
  {
    const vectorMemory = require(path.join(ROOT, 'services', 'vectorMemory'));
    const workspaceMemory = require(path.join(ROOT, 'services', 'workspaceMemory'));
    await vectorMemory.addFact('the user prefers TypeScript for backend projects', 'preference');
    workspaceMemory.writeMemory('# Project notes\n- The deployment is docker-based');
    const { callLog: memLog } = await runChat('project language choice', [
      { content: 'TypeScript it is.', finishReason: 'stop' },
    ]);
    const last = memLog[0].messages[memLog[0].messages.length - 1];
    t('e2e-N: payload carries the memory-context tail as the last message',
      last.role === 'user' && /Memory context/.test(last.content), JSON.stringify(last && last.content && last.content.slice(0, 60)));
    t('e2e-N: <workspace_memory> block with the file contents',
      /<workspace_memory>/i.test(last.content) && last.content.includes('docker-based'), '');
    t('e2e-N: <global_user_memory> block with the retrieved fact',
      /<global_user_memory>/i.test(last.content) && last.content.includes('TypeScript'), '');
    const sys = memLog[0].messages[0];
    t('e2e-N: system message carries only static guidance (no dynamic memory content)',
      sys.role === 'system' && !sys.content.includes('TypeScript') && !sys.content.includes('docker-based'), '');
    // Cleanup: later nets must see pristine payloads (no memory tail).
    workspaceMemory.clearMemory();
    vectorMemory.reset();
  }

  // ----- M) NO round ceiling: 70 identical valid calls all execute and the
  // loop keeps going past the old 64-round cap until the model answers
  // naturally (the mock exhausts if the loop overruns its canned rounds, so
  // this also pins that the router never stops on its own)
  {
    const dupCall = {
      index: 0,
      id: 'm1',
      name: 'read_file',
      arguments: '{"path":"ok.txt"}',
    };
    const canned = [];
    for (let i = 0; i < 70; i++) canned.push({ toolCalls: [dupCall] });
    canned.push({ content: 'Done after many checks.', finishReason: 'stop' });
    const { statuses, text, steps } = await runChat('check ok.txt seventy times then answer', canned);
    const executed = callLog.filter((c) =>
      c.messages.some((m) => m.content && m.content.includes('read_file: {"ok":true'))
    ).length;
    t('e2e-M: all 70 identical reads executed (no dedup, no early stop)', executed === 70, `executed=${executed}`);
    t('e2e-M: loop ran past the old 64-round cap (71 steps total)', steps === 71, `steps=${steps}`);
    t('e2e-M: no freeze anywhere on valid repeats', !statuses.some((s) => s.includes('⛔')), JSON.stringify(statuses).slice(0, 200));
    t('e2e-M: final answer served naturally', /Done after many checks/.test(text), text.slice(0, 80));
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
  // Restore the registry roles stripped at startup (cascade re-enables).
  try {
    if (modelsStateBackup) fs.writeFileSync(MODELS_STATE_FILE, modelsStateBackup, 'utf8');
  } catch {}
});