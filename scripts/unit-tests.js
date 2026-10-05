#!/usr/bin/env node
/**
 * scripts/unit-tests.js — unit tests for the prompt-cache machinery:
 * tool-result truncation, history compaction, context-budget watermarks,
 * prefix hash stability, and context-exceeded retry. Pure logic + a FAKE
 * LLM client — runs in seconds, NEVER calls llama-server.
 *
 * Usage: node scripts/unit-tests.js
 */
// Fixtures must exercise UN-truncated blocks (the cap truncates them and the
// watermark math changes). MUST be set before config is required below.
process.env.TOOL_OUTPUT_MAX_CHARS = process.env.TOOL_OUTPUT_MAX_CHARS || '20000';

const config = require('../config');
const historyManager = require('../services/historyManager');
const toolLoop = require('../services/toolLoop');

(async () => {
let failures = 0;
let checks = 0;
const check = (name, ok, extra) => {
  checks++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
};

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------
function toolResultsContent(name, payload, rawChars) {
  return historyManager.formatToolResults([{ name, result: JSON.parse(JSON.stringify(payload)) }]);
}

/** A realistic tool-loop turn: [user, assistant tool-call, results, assistant reply]. */
function fakeTurn(tag, resultsChars) {
  const blocker = `[[ t${tag} ]] ${'x'.repeat(resultsChars)}`;
  const results = historyManager.formatToolResults([{ name: 'run_shell', result: { ok: true, stdout: `cmd ${tag}\n${blocker}`, stderr: '' } }]);
  return [
    { role: 'user', content: `Turn ${tag}: run the diagnostic.` },
    { role: 'assistant', content: JSON.stringify({ tool: 'run_shell', args: { command: `diag ${tag}` } }) },
    { role: 'user', content: results },
    { role: 'assistant', content: `Done with turn ${tag}.` },
  ];
}
function withSystem(turns) {
  return [{ role: 'system', content: toolLoop.buildSystemPrompt(config.llamaSystemPrompt) }, ...turns];
}

// ---------------------------------------------------------------------------
// 1. deterministic ONE-TIME truncation of tool results
// ---------------------------------------------------------------------------
console.log('--- 1. truncation -------------------------------------------------');
{
  const big = 'H'.repeat(3000) + 'MIDDLE' + 'T'.repeat(7000) + 'TAILMARKER';
  const a = historyManager.truncateForHistory('read_file', big, 4000);
  const b = historyManager.truncateForHistory('read_file', big, 4000);
  check('same input → identical stored text (deterministic, once-only)', a === b);
  check('stored length ≤ cap including marker', a.length <= 4000, `len=${a.length}`);
  check('head kept', a.startsWith('HHH'));
  check('tail kept', a.endsWith('TAILMARKER'));
  check('marker states removed chars + how to get more', /truncated \d+ chars\./.test(a) && /offset and limit/.test(a), a.split('\n').find((l) => l.includes('truncated')));

  const shell = historyManager.truncateForHistory('run_shell', big, 4000);
  const headShare = shell.indexOf('…[truncated');
  const tailLen = shell.length - shell.lastIndexOf('…') - 1;
  check('run_shell keeps mostly the TAIL', tailLen > shell.slice(0, headShare).length, `tail=${tailLen} head=${shell.slice(0, headShare).length}`);

  const once = historyManager.truncateForHistory('run_shell', big, 4000);
  check('truncation is a no-op on already-stored (≤cap) text — the stored result never changes', historyManager.truncateForHistory('run_shell', once, 4000) === once);
  const f1 = historyManager.formatToolResults([{ name: 'run_shell', result: { ok: true, stdout: big, stderr: '' } }]);
  const f2 = historyManager.formatToolResults([{ name: 'run_shell', result: { ok: true, stdout: big, stderr: '' } }]);
  check('formatToolResults deterministic (same result → same stored message)', f1 === f2, `len=${f1.length}`);
}

// ---------------------------------------------------------------------------
// 2. high/low watermark behaviour
// ---------------------------------------------------------------------------
console.log('--- 2. watermarks -------------------------------------------------');
{
  const ctx = 16384;
  const b = historyManager.budgetFor(ctx, config.promptPrefixTokens);
  const expectedBudget = ctx - config.promptPrefixTokens - config.contextReserveTokens - Math.round((ctx * config.contextSafetyPct) / 100);
  check('budget math for 16384 ctx', b.budget === expectedBudget && b.high === Math.round((expectedBudget * 75) / 100) && b.low === Math.round((expectedBudget * 50) / 100),
    `budget=${b.budget} high=${b.high} low=${b.low}`);
  check('high > low and both inside budget', b.high > b.low && b.low < b.budget);

  // Grow a conversation past the high watermark: compaction fires once and
  // lands at/below low; below high → no compaction at all.
  const turns = withSystem([...fakeTurn('a', 8000), ...fakeTurn('b', 8000), ...fakeTurn('c', 8000), ...fakeTurn('d', 8000)]);
  turns.push({ role: 'user', content: 'current request' });
  const est = historyManager.historyTokens(turns);
  check('fixture exceeds high watermark', est > b.high, `est=${est} high=${b.high}`);
  const r = historyManager.compactHistory(turns, { low: b.low, keepTurns: 3 });
  check('compact fires (something removed)', r.removed.length > 0);
  check('lands at/below low', r.after <= b.low, `after=${r.after} low=${b.low}`);
  check('before > after', r.before > r.after, `before=${r.before} after=${r.after}`);

  const small = withSystem([...fakeTurn('x', 300)]);
  small.push({ role: 'user', content: 'hi' });
  const r2 = historyManager.compactHistory(small, { low: b.low, keepTurns: 3 });
  check('below high watermark → NO compaction', r2.removed.length === 0 && r2.messages.length === small.length);
}

// ---------------------------------------------------------------------------
// 3. never split a tool call from its result
// ---------------------------------------------------------------------------
console.log('--- 3. tool call ↔ result atomicity ------------------------------');
{
  const b = historyManager.budgetFor(16384, config.promptPrefixTokens);
  const turns = withSystem([...fakeTurn('a', 8000), ...fakeTurn('b', 8000), ...fakeTurn('c', 8000), ...fakeTurn('d', 8000)]);
  turns.push({ role: 'user', content: 'current' });
  const r = historyManager.compactHistory(turns, { low: b.low, keepTurns: 2 });

  // Every surviving tool-result block must still be immediately preceded by
  // its assistant tool-call message (or the whole turn was dropped).
  let atomic = true;
  for (let i = 1; i < r.messages.length; i++) {
    const m = r.messages[i];
    if (m.role === 'user' && String(m.content).startsWith('[Tool results]')) {
      if (!(r.messages[i - 1].role === 'assistant' && /"tool"/.test(String(r.messages[i - 1].content || '')))) {
        atomic = false;
        break;
      }
    }
    // a stub may replace a results block, but never leave the tool-call behind
    if (String(m.content).startsWith('[old tool result')) {
      if (!(r.messages[i - 1].role === 'assistant' && /"tool"/.test(String(r.messages[i - 1].content || '')))) atomic = false;
    }
  }
  check('no orphaned tool results / calls after compaction', atomic);
  check('system prompt still first and untouched', r.messages[0].role === 'system' && r.messages[0].content.startsWith('You are'));
}

// ---------------------------------------------------------------------------
// 4. protected recent turns
// ---------------------------------------------------------------------------
console.log('--- 4. protected recent turns -------------------------------------');
{
  const b = historyManager.budgetFor(16384, config.promptPrefixTokens);
  const turns = withSystem([...fakeTurn('a', 8000), ...fakeTurn('b', 8000), ...fakeTurn('c', 8000), ...fakeTurn('d', 8000), ...fakeTurn('e', 8000)]);
  turns.push({ role: 'user', content: 'current' }); // 6 user turns total
  const r = historyManager.compactHistory(turns, { low: b.low, keepTurns: 3 });

  // keepTurns=3 → user turns d, e and the current request are untouchable:
  // their FULL content (including the heavy results blocks) must survive the
  // replay; the oldest turns must be compacted away instead.
  const joined = JSON.stringify(r.messages);
  check('last 3 user turns fully intact (d, e results + current request)', joined.includes('[[ td ]]') && joined.includes('[[ te ]]') && joined.includes('current'), `kept ${r.messages.length}/${turns.length} msgs`);
  check('older turns compacted away by the replay (removed >= 2)', r.removed.length >= 2, `${r.removed.length} removed`);
  check('system prompt first and untouched', r.messages[0].role === 'system');
}

// ---------------------------------------------------------------------------
// 5. retry after a context-exceeded error (FAKE llm client, mirrors
//    routes/chat.js): compact once → retry once → second overflow errors out
// ---------------------------------------------------------------------------
console.log('--- 5. context-exceeded retry ------------------------------------');
{
  const b = historyManager.budgetFor(16384, config.promptPrefixTokens);
  // 20 light turns + the current request: crosses high at ~step 18, stubs the
  // 15+ unprotected results (lands far below low), protected window intact.
  const sizes = Array(20).fill(1200);
  const msgs0 = withSystem(sizes.flatMap((sz, i) => fakeTurn(String.fromCharCode(97 + (i % 26)), sz)));
  msgs0.push({ role: 'user', content: 'now' });
  let history = msgs0.slice();

  // fake complete: throws a llama.cpp context error until the history has
  // been compacted, then "succeeds"
  let calls = 0;
  const fakeComplete = async () => {
    calls++;
    if (historyManager.historyTokens(history) > b.high) {
      throw new Error('llama.cpp 400: Requested tokens (17301) exceed context window of 16384');
    }
    return { content: 'ok', usage: { prompt_tokens: 2500 }, timings: { prompt_n: 50 } };
  };

  // mirror routes/chat.js catch block (replay + force, exactly as the route
  // calls it after a context-exceeded error)
  let ctxRetried = false;
  let result = null;
  let caught = null;
  for (let i = 0; i < 10; i++) {
    try {
      result = await fakeComplete();
      break;
    } catch (e) {
      if (historyManager.isContextError(e) && !ctxRetried) {
        ctxRetried = true;
        const c = historyManager.compactHistory(history, {
          high: b.high,
          low: b.low,
          keepTurns: 3,
          force: true,
        });
        history = c.messages;
        continue; // retry once
      }
      caught = e;
      break;
    }
  }
  check('context error detected (isContextError)', historyManager.isContextError(new Error('Requested tokens (999) exceed context window of 16384')) &&
    historyManager.isContextError(new Error('prompt is too long')) &&
    historyManager.isContextError(new Error('context window exceeded')));
  check('retried exactly once and succeeded', ctxRetried && result !== null && calls === 2, `calls=${calls}`);
  check('history was compacted before the retry', historyManager.historyTokens(history) <= b.low, `after=${historyManager.historyTokens(history)} low=${b.low}`);

  // second overflow → error out, NO third call
  calls = 0;
  let history2 = msgs0.slice();
  let ctxRetried2 = false;
  let caught2 = null;
  const alwaysOverflow = async () => {
    calls++;
    throw new Error('context window exceeded');
  };
  for (let i = 0; i < 10; i++) {
    try {
      await alwaysOverflow();
      break;
    } catch (e) {
      if (historyManager.isContextError(e) && !ctxRetried2) {
        ctxRetried2 = true;
        const c = historyManager.compactHistory(history2, { low: b.low, keepTurns: 3 });
        history2 = c.messages;
        continue;
      }
      caught2 = e;
      break;
    }
  }
  check('second overflow errors out after ONE retry (no loop)', caught2 !== null && calls === 2, `calls=${calls}`);
}

// ---------------------------------------------------------------------------
// 5b. re-prefill estimate = tokens AFTER the first changed position
// ---------------------------------------------------------------------------
console.log('--- 5b. re-prefill estimate ---------------------------------------');
{
  const mk = (role, content) => ({ role, content });
  const base = [mk('system', 'sys'), mk('user', 'u1'), mk('assistant', 'a1'), mk('user', 'u2')];
  check('identical lists -> 0 re-prefill tokens', historyManager.repreffillTokens(base, base) === 0);
  const grows = [...base, mk('user', 'u3 new message')];
  const onlyNew = historyManager.repreffillTokens(base, grows);
  check('appended message -> only the new message counts', onlyNew === historyManager.estimateTokens('u3 new message'), `=${onlyNew}`);
  const stubbed = [mk('system', 'sys'), mk('user', 'u1'), mk('assistant', 'a1'), mk('user', historyManager.STUB_TEXT), mk('user', 'u2')];
  const afterStub = historyManager.repreffillTokens(base, stubbed);
  check('stub at index 3 -> everything from the stub on counts', afterStub === historyManager.estimateTokens(historyManager.STUB_TEXT) + historyManager.estimateTokens('u2'), `=${afterStub}`);
  const droppedMid = [mk('system', 'sys'), mk('user', 'u2')];
  const afterDrop = historyManager.repreffillTokens(base, droppedMid);
  check('dropped middle -> everything after the first diff counts', afterDrop === historyManager.estimateTokens('u2'), `=${afterDrop}`);
}

// ---------------------------------------------------------------------------
// 6. compaction stability ---------------------------------------------------
//    (re-compaction property that keeps the llama.cpp prefix cache valid)
// ---------------------------------------------------------------------------
console.log('--- 6. compaction stability ---------------------------------------');
{
  const b = historyManager.budgetFor(16384, config.promptPrefixTokens);
  const raw = withSystem([...fakeTurn('a', 8000), ...fakeTurn('b', 8000), ...fakeTurn('c', 8000), ...fakeTurn('d', 8000)]);
  raw.push({ role: 'user', content: 'turn 5' });

  const c1 = historyManager.compactHistory(JSON.parse(JSON.stringify(raw)), { low: b.low, keepTurns: 2 });
  const c2 = historyManager.compactHistory(JSON.parse(JSON.stringify(raw)), { low: b.low, keepTurns: 2 });
  check('same input → byte-identical compacted history', JSON.stringify(c1.messages) === JSON.stringify(c2.messages));

  // Next request arrives with the RAW history again (clients resend full
  // messages) plus a new turn; deterministic re-compaction must reproduce
  // the SAME compacted text for every turn that survives in both.
  const rawNext = withSystem([
    ...fakeTurn('a', 8000), ...fakeTurn('b', 8000), ...fakeTurn('c', 8000), ...fakeTurn('d', 8000),
    { role: 'user', content: 'turn 5' },
    { role: 'assistant', content: 'ack 5' },
    { role: 'user', content: 'turn 6' },
  ]);
  const c3 = historyManager.compactHistory(JSON.parse(JSON.stringify(rawNext)), { low: b.low, keepTurns: 2 });

  const common = (A, B) => A.messages.filter((m) => B.messages.some((n) => JSON.stringify(n) === JSON.stringify(m)));
  const shared = common(c1, c3);
  check('shared surviving turns byte-identical across requests (cache stability)', shared.length > 0 && shared.length === c1.messages.length, `shared=${shared.length}/${c1.messages.length}`);
  check('compacted history is stable as the STORED history (idempotent)', (() => {
    const again = historyManager.compactHistory(JSON.parse(JSON.stringify(c1.messages)), { low: b.low, keepTurns: 2 });
    return JSON.stringify(again.messages) === JSON.stringify(c1.messages);
  })());
}

// ---------------------------------------------------------------------------
// 7. prefix hash: identical across conversations, sorted order, warn on change
// ---------------------------------------------------------------------------
console.log('--- 7. prefix hash ------------------------------------------------');
{
  const sys = toolLoop.buildSystemPrompt(config.llamaSystemPrompt);
  const toolsJson = JSON.stringify(toolLoop.toOpenAITools());
  const h1 = historyManager.prefixHashFor(sys, toolsJson);
  const h2 = historyManager.prefixHashFor(sys, toolsJson);
  check('hash identical across recomputations', h1 === h2, h1);
  const names = toolLoop.toOpenAITools().map((t) => t.function.name);
  check('tools sorted by name (fixed order, 16 tools)', JSON.stringify(names) === JSON.stringify([...names].sort()), `${names.length} tools`);

  // Capture the ONE warning the module emits on a runtime prefix change
  // (the guard is one-shot by design — set the capture BEFORE the change).
  let warned = false;
  const origWarn = console.warn;
  console.warn = (m) => { if (/prefix hash changed/.test(String(m))) warned = true; };
  try {
    const different = historyManager.prefixHashFor(sys, JSON.stringify(toolLoop.toOpenAITools().slice(0, 5)));
    check('hash changes when the tool set changes', different !== h1);
  } finally {
    console.warn = origWarn;
  }
  check('mid-process hash change logs a warning', warned);
}

console.log('');
console.log(`${checks} checks, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('unit-tests crashed:', e && e.stack ? e.stack : e);
  process.exit(2);
});