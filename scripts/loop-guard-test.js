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
// at require time). The system-prompt override file is redirected to a
// throwaway path too, so e2e-L can exercise the override without touching
// the real data dir.
process.env.PLIFE_WORK_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'plife-work-'));
process.env.SYSTEM_PROMPT_FILE = path.join(os.tmpdir(), 'plife-sysprompt-' + process.pid + '.txt');

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

    // delete_file: single-file deletion strictly inside the sandbox
    toolLoop.resetSeenCalls();
    const P = 'scripts/__del_probe.txt';
    await toolLoop.executeTool('write_file', { path: P, content: 'bye' });
    toolLoop.resetSeenCalls(); // fresh request — a delete of it is legitimate
    const d1 = await toolLoop.executeTool('delete_file', { path: P });
    t('delete_file: removes an existing file', d1.ok === true && d1.deleted === true, JSON.stringify(d1));
    t('delete_file: file really gone', !fs.existsSync(path.join(process.env.PLIFE_WORK_ROOT, P)));
    const d2 = await toolLoop.executeTool('delete_file', { path: P });
    t('delete_file: identical repeat is deduped (no second attempt)', !d2.ok && d2.skippedDuplicate === true, JSON.stringify(d2));
    const d2b = await toolLoop.executeTool('delete_file', { path: 'nope.txt' });
    t('delete_file: missing file reports cleanly', !d2b.ok && /no such file/.test(d2b.error || ''), JSON.stringify(d2b));
    const d3 = await toolLoop.executeTool('delete_file', { path: 'scripts' });
    t('delete_file: directory refused (never recursive)', !d3.ok && /directory/.test(d3.error || ''), JSON.stringify(d3));
    const d4 = await toolLoop.executeTool('delete_file', { path: '../outside.txt' });
    t('delete_file: traversal outside workspace refused', !d4.ok, JSON.stringify(d4));
    const d5 = await toolLoop.executeTool('delete_file', { path: '/etc/passwd' });
    t('delete_file: absolute path outside workspace refused', !d5.ok, JSON.stringify(d5));

    // file-argument normalization: alias keys (file/filepath/filename/src)
    // and bare unkeyed strings map to `path` so the call EXECUTES instead of
    // being rejected into a repeated-invalid retry loop
    {
      const D = process.env.PLIFE_WORK_ROOT;
      fs.mkdirSync(path.join(D, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(D, 'scripts', '__norm_probe.txt'), 'norm-probe-content');
      fs.writeFileSync(path.join(D, 'scripts', '__norm_del.txt'), 'x');
      toolLoop.resetSeenCalls();
      const r1 = await toolLoop.executeTool('read_file', { file: 'scripts/__norm_probe.txt' });
      t('arg-norm: read_file with {file:...} executes', r1.ok === true && /norm-probe-content/.test(r1.content || ''), JSON.stringify(r1).slice(0, 120));
      toolLoop.resetSeenCalls();
      const r2 = await toolLoop.executeTool('read_file', 'scripts/__norm_probe.txt');
      t('arg-norm: read_file with bare string args executes', r2.ok === true && r2.path === 'scripts/__norm_probe.txt', JSON.stringify(r2).slice(0, 120));
      toolLoop.resetSeenCalls();
      const r3 = await toolLoop.executeTool('read_file', { filename: 'scripts/__norm_probe.txt' });
      t('arg-norm: read_file with {filename:...} executes', r3.ok === true && r3.path === 'scripts/__norm_probe.txt', JSON.stringify(r3).slice(0, 120));
      toolLoop.resetSeenCalls();
      const r4 = await toolLoop.executeTool('write_file', { file: 'scripts/__norm_probe2.txt', content: 'written via alias' });
      t('arg-norm: write_file with {file, content} executes', r4.ok === true && fs.readFileSync(path.join(D, 'scripts', '__norm_probe2.txt'), 'utf8') === 'written via alias', JSON.stringify(r4));
      const r4b = await toolLoop.executeTool('write_file', { file: 'scripts/__norm_probe2.txt', content: 'written via alias' });
      t('arg-norm: alias-keyed repeat dedups identically', !r4b.ok && r4b.skippedDuplicate === true, JSON.stringify(r4b));
      toolLoop.resetSeenCalls();
      const r5 = await toolLoop.executeTool('delete_file', { src: 'scripts/__norm_del.txt' });
      t('arg-norm: delete_file with {src:...} executes', r5.ok === true && r5.deleted === true, JSON.stringify(r5));
      toolLoop.resetSeenCalls();
      const r6 = await toolLoop.executeTool('edit_file', { file: 'scripts/__norm_probe.txt', old_text: 'norm-probe-content', new_text: 'edited' });
      t('arg-norm: edit_file with {file,...} executes', r6.ok === true && fs.readFileSync(path.join(D, 'scripts', '__norm_probe.txt'), 'utf8') === 'edited', JSON.stringify(r6));
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
            toolLoop.resetSeenCalls();
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
            toolLoop.resetSeenCalls();
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

    // read-only list tools are exempt from the dedup ledger — a repeated
    // list after a state change returns FRESH data, never a skip error
    toolLoop.resetSeenCalls();
    const la1 = await toolLoop.executeTool('list_automations', {});
    const la2 = await toolLoop.executeTool('list_automations', {});
    t('list_automations: repeat executes (read-only, exempt from dedup)', la1.ok === true && la2.ok === true && !la2.skippedDuplicate, JSON.stringify(la2));

    // redundant-churn guard: no delete-and-recreate within one request
    toolLoop.resetSeenCalls();
    await toolLoop.executeTool('write_file', { path: 'scripts/__churn.txt', content: 'x' });
    const ch1 = await toolLoop.executeTool('delete_file', { path: 'scripts/__churn.txt' });
    t('churn: delete of file created this request is skipped', ch1.ok === false && ch1.skippedRedundant === true, JSON.stringify(ch1));
    t('churn: the created file survives', fs.existsSync(path.join(process.env.PLIFE_WORK_ROOT, 'scripts/__churn.txt')));
    toolLoop.resetSeenCalls(); // fresh request → the same delete is legitimate
    const ch2 = await toolLoop.executeTool('delete_file', { path: 'scripts/__churn.txt' });
    t('churn: same delete in a fresh request executes', ch2.ok === true && ch2.deleted === true, JSON.stringify(ch2));

    toolLoop.resetSeenCalls();
    const ca = await toolLoop.executeTool('create_automation', {
      name: 'Churn Temp',
      description: 'temp',
      schedule_type: 'interval',
      interval_minutes: 5,
      action_type: 'script',
      script: 'scripts/churn.sh',
    });
    const da = await toolLoop.executeTool('delete_automation', { id: 'churn-temp' });
    t('churn: delete of automation created this request is skipped', ca.ok === true && da.ok === false && da.skippedRedundant === true, JSON.stringify(da));

    // unit checks of the churn mapping (explicit ledger, slash normalization)
    const uledger = [{ name: 'write_skill', args: { name: '/s1' } }];
    t('churn: delete_skill maps to write_skill with slash normalization', toolLoop.createdEarlierInRequest('delete_skill', { name: 's1' }, uledger) !== null);
    t('churn: unrelated delete has no churn', toolLoop.createdEarlierInRequest('delete_skill', { name: 'other' }, uledger) === null);
    t('churn: slugifyId mirrors the store slug', toolLoop.slugifyId('Print Current Date and Time') === 'print-current-date-and-time');
    t('churn: no churn when create failed earlier', toolLoop.createdEarlierInRequest('delete_automation', { id: 'x' }, []) === null);

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

    // ---- shell URL-quoting retry (the curl-&-quote dedup bug) --------------
    // An unquoted URL with & backgrounded the fetch and the shell 'succeeded'
    // (exit 0) on the stray assignment — the exit-0/empty-output run must NOT
    // block the corrected quoted retry as a duplicate.
    {
      toolLoop.resetSeenCalls();
      const bad = 'curl -s http://127.0.0.1:9/prices?ids=solana&vs_currencies=usd';
      const good = 'curl -s "http://127.0.0.1:9/prices?ids=solana&vs_currencies=usd"';
      const rBad = await toolLoop.executeTool('run_shell', { command: bad });
      t('url-dedup: unquoted & command exits 0 but produces no output', rBad.ok === true && !(rBad.stdout || rBad.stderr), JSON.stringify(rBad));
      const rGood = await toolLoop.executeTool('run_shell', { command: good });
      t('url-dedup: corrected quoted retry EXECUTES (not a duplicate)', !rGood.skippedDuplicate && rGood.ok !== undefined, JSON.stringify(rGood).slice(0, 140));
      // back-to-back identical EMPTY-output command is still subject to the
      // guard's intent? no — an empty-output repeat re-executes (that is the
      // fix); a repeat WITH output must still skip:
      toolLoop.resetSeenCalls();
      const e1 = await toolLoop.executeTool('run_shell', { command: 'echo url-ok' });
      const e2 = await toolLoop.executeTool('run_shell', { command: 'echo "url-ok"' });
      t('url-dedup: re-quoted command WITH output still skipped as duplicate', !e2.ok && e2.skippedDuplicate === true, JSON.stringify(e2));
      // WITH output AND an unquoted shell operator -> the shell parsed the
      // first run structurally differently; the corrected (quoted) retry must
      // execute even though the first run produced output (the exact smoke
      // failure: backgrounded curl's error JSON landed, blocking the retry):
      toolLoop.resetSeenCalls();
      const f1 = await toolLoop.executeTool('run_shell', { command: 'echo probe; x=1' });
      const f2 = await toolLoop.executeTool('run_shell', { command: 'echo "probe"; x=1' });
      t('url-dedup: quoted retry executes when first run had output AND unquoted ops', f1.ok === true && !f2.skippedDuplicate, JSON.stringify(f2).slice(0, 120));
      // A repeated CORRECT quoted command (ops inside quotes only) is still a
      // duplicate — successful runs are the only ones the guard records:
      toolLoop.resetSeenCalls();
      const g1 = await toolLoop.executeTool('run_shell', { command: 'echo "a&b"' });
      const g2 = await toolLoop.executeTool('run_shell', { command: 'echo "a&b"' });
      t('url-dedup: repeated correctly-quoted command still deduped', g1.ok === true && !g2.ok && g2.skippedDuplicate === true, JSON.stringify(g2).slice(0, 120));
      t('url-dedup: helper flags unquoted &', toolLoop.shellCommandHasUnquotedOps('curl -s URL?ids=x&v=y') === true);
      t('url-dedup: helper ignores ops inside quotes', toolLoop.shellCommandHasUnquotedOps('curl -s "URL?ids=x&v=y"') === false);
      // expansion-aware normalization: $VAR quoted vs unquoted differ
      toolLoop.resetSeenCalls();
      const kq = toolLoop.normalizeShellCommandKey('curl "$URL"');
      const ku = toolLoop.normalizeShellCommandKey('curl $URL');
      t('url-dedup: quoted $VAR and bare $VAR are DISTINCT commands', kq !== ku, `${kq} vs ${ku}`);
      const ku2 = toolLoop.normalizeShellCommandKey('curl "https://x/?a=1&b=2"');
      const kq2 = toolLoop.normalizeShellCommandKey('curl https://x/?a=1&b=2');
      t('url-dedup: quoted and bare plain URLs still compare equal', kq2 === ku2, `${kq2} vs ${ku2}`);
    }

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

    // ---- repetition detection (smart loop guard, DEDUP_EXEMPT tools) ------
    // Exempt tools are intentionally repeatable, but an IDENTICAL call
    // immediately after itself is a redundant re-emission, and a provable
    // A-B-A-B-A ping-pong cycle is a model loop — both are caught with a
    // constructive hint instead of burning rounds. A SINGLE A-B-A round-trip
    // still executes (re-checking a value after an action = intent), as does
    // any genuinely new step and any repeat after a FAILED call (recovery).
    {
      toolLoop.resetSeenCalls();
      const g1 = await toolLoop.executeTool('run_shell', { command: 'node -e "console.log(10)"' });
      const g2 = await toolLoop.executeTool('run_shell', { command: 'node -e "console.log(10)"' });
      t('rep: consecutive identical exempt call skipped with hint',
        g1.ok && !g2.ok && g2.skippedDuplicate === true && /already ran this tool with these exact arguments|duplicate shell command skipped/.test(g2.error || ''), JSON.stringify(g2));
      const g3 = await toolLoop.executeTool('run_shell', { command: 'node -e "console.log(11)"' });
      t('rep: fresh call after consecutive skip executes', g3.ok === true, JSON.stringify(g3));
    }
    {
      toolLoop.resetSeenCalls();
      const a = await toolLoop.executeTool('run_shell', { command: 'node -e "console.log(20)"' });
      const b = await toolLoop.executeTool('run_shell', { command: 'node -e "console.log(21)"' });
      const a2 = await toolLoop.executeTool('run_shell', { command: 'node -e "console.log(20)"' });
      t('rep: single A-B-A round-trip executes (intentional double run)',
        a.ok && b.ok && a2.ok === true && !a2.skippedDuplicate, JSON.stringify(a2));
      const b2 = await toolLoop.executeTool('run_shell', { command: 'node -e "console.log(21)"' });
      const a3 = await toolLoop.executeTool('run_shell', { command: 'node -e "console.log(20)"' });
      t('rep: A-B-A-B-A cycle caught as alternation with loop hint',
        !a3.ok && a3.skippedDuplicate === true && a3.repetition === 'alternation' && /looping/.test(a3.error || ''), JSON.stringify(a3));
      const c = await toolLoop.executeTool('run_shell', { command: 'node -e "console.log(22)"' });
      t('rep: genuinely new step after cycle skip executes', c.ok === true, JSON.stringify(c));
    }
    {
      toolLoop.resetSeenCalls();
      const f1 = await toolLoop.executeTool('run_shell', { command: 'node -e "process.exit(9)"' });
      const f2 = await toolLoop.executeTool('run_shell', { command: 'node -e "process.exit(9)"' });
      t('rep: repeat of a FAILED call executes (recovery, not a loop)', !f1.ok && !f2.ok && !f2.skippedDuplicate, '');
    }
    {
      // run_automation exemption + repetition (execute stubbed):
      toolLoop.resetSeenCalls();
      const raDef = registry.find((x) => x.name === 'run_automation');
      const origRa = raDef.execute;
      raDef.execute = async () => ({ ok: true, message: 'stub' });
      const r1 = await toolLoop.executeTool('run_automation', { id: 'probe-rule' });
      const r2 = await toolLoop.executeTool('run_automation', { id: 'probe-rule' });
      raDef.execute = origRa;
      t('rep: run_automation consecutive identical skipped (exempt guard)',
        r1.ok === true && !r2.ok && r2.skippedDuplicate === true && r2.repetition === 'consecutive', JSON.stringify(r2));
    }
    {
      // Long unique multi-step progression — no numeric ceiling: every step
      // executes as long as it is a genuinely new fingerprint.
      toolLoop.resetSeenCalls();
      let allOk = true;
      for (let i = 100; i < 130; i++) {
        const r = await toolLoop.executeTool('run_shell', { command: `node -e "console.log(${i})"` });
        if (!r.ok) { allOk = false; break; }
      }
      t('rep: 30-step unique progression all executes (no numeric ceiling)', allOk === true, '');
    }

    // Canonical key: key order must not matter
    toolLoop.resetSeenCalls();
    const k1 = toolLoop.canonicalArgsKey({ b: 1, a: 2 });
    const k2 = toolLoop.canonicalArgsKey({ a: 2, b: 1 });
    t('dedup: canonical key order-insensitive', k1 === k2, k1);

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
      toolLoop.resetSeenCalls();
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
    // Live-stream the canned round exactly like the real upstream: content
    // via onDelta and the reasoning trace via onReasoning. Deferred to a
    // microtask — the REAL upstream is async (its deltas arrive after the
    // SSE headers are open); a synchronous emit would write to the response
    // before openSse() and crash with ERR_HTTP_HEADERS_SENT. The callbacks
    // still fire before the round resolves, so the loop's round-boundary
    // events always follow the text they refer to (order pinned by e2e-G).
    const p = Promise.resolve().then(() => {
      if (acc.reasoning && opts.onReasoning) opts.onReasoning(acc.reasoning);
      if (acc.content && opts.onDelta) opts.onDelta(acc.content);
      return acc;
    });
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

  // ----- E) automation scripts run with the WORKSPACE ROOT as cwd: relative
  // `logs/...` redirections land in the workspace where the agent's file tools
  // (and the user) can inspect them, and logs/ is ensured to exist
  {
    const automationManager = require(path.join(ROOT, 'services', 'automationManager'));
    toolLoop.resetSeenCalls();
    const stamp = Date.now();
    const probe = `scripts/__logprobe_${stamp}.sh`;
    const logName = `__logprobe_${stamp}.log`;
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

  // ----- F) anti-spam abort: consecutive duplicate-only rounds freeze the
  // loop and force the final answer (no more than the canned rounds run)
  {
    const dupCall = {
      index: 0,
      id: 'x1',
      name: 'read_file',
      arguments: '{"path":"logs/__e2e_missing.log"}',
    };
    const { statuses, text, steps, callLog } = await runChat('check the file logs/__e2e_missing.log for me', [
      { toolCalls: [dupCall] }, // round 1: real (sharpened) error
      { toolCalls: [dupCall] }, // round 2: duplicate — skipped
      { toolCalls: [dupCall] }, // round 3: duplicate — skipped -> freeze armed
      { toolCalls: [dupCall] }, // round 4: STILL calling -> freeze fires (⛔, no exec)
      { content: 'No log yet — I checked and it is not there.', finishReason: 'stop' },
    ]);
    t('e2e-F: final answer served after the freeze', text.includes('I checked'), text.slice(0, 120));
    t('e2e-F: anti-spam stop status shown', statuses.some((s) => s.includes('⛔')), JSON.stringify(statuses).slice(0, 700));
    t(
      'e2e-F: frozen round tells the model to stop calling',
      callLog[callLog.length - 1].messages.some((m) => m.content.includes('Execution stopped')),
      JSON.stringify(callLog[callLog.length - 1].messages.map((m) => m.content.slice(0, 60)))
    );
    t(
      'e2e-F: loop did not burn extra rounds',
      steps === 5,
      `steps=${steps}`
    );
    t(
      'e2e-F: missing-logs read carried the schedule hint',
      statuses.some((s) => s.includes('duplicate tool call skipped')),
      JSON.stringify(statuses).slice(0, 300)
    );
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
    try { fs.unlinkSync(path.join(process.env.PLIFE_WORK_ROOT, 'scripts', '__rs_probe.txt')); } catch {}
  }

  // ----- H) the reported failure mode: alias-keyed read_file args must
  // EXECUTE (not be rejected into a 7-round retry -> anti-spam freeze)
  {
    const D = process.env.PLIFE_WORK_ROOT;
    fs.mkdirSync(path.join(D, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(D, 'scripts', 'get_solana_price.py'), 'import requests\nprint("solana price")\n');
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
    t('e2e-H: status shows the real path (no "Reading file: ?")', statuses.some((s) => s === '⚙ Reading file: scripts/get_solana_price.py'), JSON.stringify(statuses));
    t('e2e-H: final answer streamed', /I checked the file/.test(text), text.slice(0, 100));
    try { fs.unlinkSync(path.join(D, 'scripts', 'get_solana_price.py')); } catch {}
  }

  // ----- I) fail-fast: the SAME invalid emission repeated 3 times freezes
  // the loop immediately (previously it burned the full 7-round budget on
  // the identical broken call, which is the reported 2-minute freeze)
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
    fs.mkdirSync(path.join(D, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(D, 'scripts', 'get_solana_price.py'), 'import requests\nprint("solana price")\n');
    const { statuses, text, steps, callLog } = await runChat('can you check and refactor: scripts/get_solana_price.py', [
      { toolCalls: [{ index: 0, id: 'j1', name: 'read_file', arguments: '{}' }] },
      { content: 'I checked the file — it looks fine.', finishReason: 'stop' },
    ]);
    const executed = callLog.some((c) => c.messages.some((m) => m.content && m.content.includes('read_file: {"ok":true')));
    const inferredStatus = statuses.some((s) => s.includes('Reading file: scripts/get_solana_price.py (path inferred from conversation)'));
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
    const writeInferred = s2.some((s) => s === '⚙ Writing file: scripts/get_solana_price.py (path inferred from conversation)');
    const contentOnly = s2.some((s) => s.includes('missing required argument \'content\'') && !s.includes('missing required argument \'path\''));
    const wrote = log2.some((c) => c.messages.some((m) => m.content && m.content.includes('write_file: {"ok":true')));
    t('e2e-J: write_file empty args infers the path in the status', writeInferred, JSON.stringify(s2));
    t('e2e-J: write rejected for content only (path no longer the gap)', contentOnly, JSON.stringify(s2));
    t('e2e-J: valid retry with content executes', wrote);
    try { fs.unlinkSync(path.join(D, 'scripts', 'get_solana_price.py')); } catch {}
  }

  // ----- K) the reported gemma failure mode: run_shell with ALIAS keys must
  // normalize+execute (no rejection loop), and EMPTY args must reject WITH
  // the command format hint so the model can correct itself
  {
    const { statuses, text, steps, callLog } = await runChat('what is the current status of system resources?', [
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