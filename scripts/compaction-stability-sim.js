#!/usr/bin/env node
/**
 * scripts/compaction-stability-sim.js — property test for the replay-based
 * history compaction: recomputing compaction from the raw client history on
 * every request must NOT invalidate the llama.cpp prompt cache on every turn.
 *
 * MOCKS ONLY: fake token counter (chars/3.4, same constant as the estimator)
 * and NO llama-server. Runs in a second or two.
 *
 * For each of 40 turns the conversation is built exactly as routes/chat.js
 * does (system prompt + tools + history which the client resends RAW +
 * compacted by the REAL historyManager.compactHistory + the new user
 * message) and the compacted prompt text of turn N is compared with turn
 * N-1 token-by-token (fake counter):
 *   prompt tokens | common prefix with previous turn | re-evaluated tokens
 *   (prompt - common) | compaction fired?
 *
 * Expected (post-fix): on turns without a compaction event the re-evaluated
 * tokens equal only the new messages; on an event there is one large
 * re-evaluation and the following turns are small again; the first-changed
 * position only moves at events (never one turn per request after the high
 * watermark is crossed — that would be a bug).
 *
 * The simulation is run three times with a usage.prompt_tokens calibration
 * perturbed by +/-10% between requests (the route's onUsage assignment):
 * the compaction boundary must be identical in all three runs. A --legacy
 * mode replicates the pre-replay compaction (re-compact the raw history from
 * scratch every request) to demonstrate the drift it had.
 *
 * Usage: node scripts/compaction-stability-sim.js [--legacy] [--summary]
 */
const config = require('../config');
const historyManager = require('../services/historyManager');
const toolLoop = require('../services/toolLoop');

process.env.TOOL_OUTPUT_MAX_CHARS = process.env.TOOL_OUTPUT_MAX_CHARS || '4000';

const LEGACY = process.argv.includes('--legacy');
const SUMMARY = process.argv.includes('--summary');
const TURNS = 40;
const KEEP = config.contextKeepLastTurns; // 3

// --- fake token counter (deterministic, length-based, same 3.4 constant) ---
const tokens = (text) => Math.ceil(String(text || '').length / 3.4);
const commonPrefixChars = (a, b) => {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
};

// --- deterministic conversation generator -----------------------------------
// Realistic tool results of VARYING size; several hits AT the 4000-char cap
// (truncateForHistory clamps them to the cap at insertion, marker included).
const SIZES = [4000, 900, 4000, 2600, 200, 4000, 1200, 4000, 3000, 600];
const body = (t) => {
  const size = SIZES[t % SIZES.length];
  const line = (k) => `  const v${t}_${k} = Math.sqrt(${(t * 97 + k * 13) % 997}) + ${(t + k) % 50}; // stage ${t}\n`;
  let s = `[stage ${t}] diagnostics batch\n`;
  for (let k = 0; s.length < size; k++) s += line(k);
  return s.slice(0, size);
};
const buildTurn = (t) => {
  const userMsg = `Turn ${t}: inspect the diagnostics and report what changed since stage ${t - 1}.`;
  const toolCall = JSON.stringify({ thought: `diagnose stage ${t}`, tool: 'run_shell', args: { command: `diag --stage ${t}` } });
  const results = historyManager.formatToolResults([
    { name: 'run_shell', result: { ok: true, stdout: body(t), stderr: '' } },
  ]);
  const reply = `Stage ${t} summary: batch ran cleanly (artifacts pending).`;
  return [
    { role: 'user', content: userMsg },
    { role: 'assistant', content: toolCall },
    { role: 'user', content: results },
    { role: 'assistant', content: reply },
  ];
};

const system = [{ role: 'system', content: toolLoop.buildSystemPrompt(config.llamaSystemPrompt) }];
const budget = historyManager.budgetFor(16384, config.promptPrefixTokens);

// --- route logic under test (mirrors routes/chat.js) ------------------------
// calibFactor simulates usage.prompt_tokens noise (-10%..+10%): the FIXED
// route never consults it for compaction decisions; the legacy mode does.
function simulateRoute(calibFactors, legacy) {
  const rows = [];
  let prevText = null;
  let prevCompacted = null;
  const events = [];

  // copies of the pre-fix behavior (re-compact raw from scratch + calibrated
  // mid-loop trigger) so the drift it caused is visible in numbers
  const legacyCompact = (messages) => {
    const work = messages.slice();
    const starts = historyManager.turnBoundaries ? null : null; // (not exported — recompute inline below)
    const boundaries = [];
    for (let i = 1; i < work.length; i++) {
      const m = work[i];
      if (m.role === 'user' && !String(m.content).startsWith('[Tool results]') && String(m.content) !== historyManager.STUB_TEXT) boundaries.push(i);
    }
    const removed = [];
    const protectFrom = boundaries.length > KEEP ? boundaries[boundaries.length - KEEP] : (boundaries.length ? boundaries[0] : 1);
    for (let i = 1; i < work.length && i < protectFrom && historyManager.historyTokens(work) > budget.low; i++) {
      const m = work[i];
      if (m.role === 'user' && String(m.content).startsWith('[Tool results]')) {
        removed.push(`stub ${i}`);
        work[i] = { role: 'user', content: historyManager.STUB_TEXT };
      }
    }
    let cut = 1;
    while (historyManager.historyTokens(work) > budget.low) {
      const bs = [];
      for (let i = 1; i < work.length; i++) {
        const m = work[i];
        if (m.role === 'user' && !String(m.content).startsWith('[Tool results]') && String(m.content) !== historyManager.STUB_TEXT) bs.push(i);
      }
      const dropUntil = bs.length > KEEP ? bs[bs.length - KEEP] : 1;
      if (cut >= dropUntil) break;
      const next = bs.find((s) => s > cut);
      const end = next === undefined ? work.length : next;
      if (end <= cut) break;
      removed.push(`drop ${cut}..${end - 1}`);
      work.splice(cut, end - cut);
    }
    return { messages: work, removed };
  };

  for (let n = 1; n <= TURNS; n++) {
    // client resends the RAW history (no session store) + the new message
    const raw = [...system, ...Array.from({ length: n }, (_, i) => buildTurn(i + 1)).flat()];
    const newMsg = { role: 'user', content: `(request ${n} entered)` };

    let compacted;
    let fired = false;
    let c = null;
    if (legacy) {
      // pre-fix: trigger on the (possibly calibrated) estimate, then
      // re-compact the RAW history from scratch
      const calibHist = Math.round((tokens(JSON.stringify([...raw, newMsg])) - 2390) * (calibFactors[n - 1] || 1));
      fired = calibHist > budget.high;
      let out = { messages: raw, removed: [] };
      if (fired || historyManager.historyTokens(raw) > budget.high) {
        out = legacyCompact(raw);
        fired = out.removed.length > 0;
      }
      compacted = out.messages;
    } else {
      c = historyManager.compactHistory(raw, { high: budget.high, low: budget.low, keepTurns: KEEP });
      compacted = c.messages;
    }

    // "compaction fired" = the compacted history DIFFERS from the previous
    // request's compacted history before its end (the boundary moved), not
    // merely that the replay re-applied the same stubs to the same raw list.
    if (prevCompacted) {
      const idx = historyManager.firstDiffIndex(prevCompacted, compacted);
      fired = idx < prevCompacted.length;
      if (fired && c) events.push({ turn: n, removed: c.removed.length, before: c.before, after: c.after });
    }
    prevCompacted = compacted.map((m) => ({ role: m.role, content: m.content }));

    const text = JSON.stringify([...compacted, newMsg]);
    const pTok = tokens(text);
    const common = prevText === null ? 0 : tokens(prevText.slice(0, commonPrefixChars(prevText, text)));
    const reEval = pTok - common;
    const firstChange = prevText === null ? 0 : commonPrefixChars(prevText, text);
    rows.push({ n, pTok, common, reEval, fired, firstChange });
    prevText = text;
  }
  return { rows, events };
}

// --- reporting --------------------------------------------------------------
const pad = (s, w) => String(s).padStart(w);
const printTable = (rows) => {
  console.log(`${pad('turn', 5)} ${pad('prompt', 7)} ${pad('common', 7)} ${pad('re-eval', 8)} ${pad('compacted', 9)} ${pad('firstChg', 9)}`);
  for (const r of rows) {
    console.log(`${pad(r.n, 5)} ${pad(r.pTok, 7)} ${pad(r.common, 7)} ${pad(r.reEval, 8)} ${pad(r.fired ? '✂ yes' : '—', 9)} ${pad(r.firstChange, 9)}`);
  }
};

const BASELINE = simulateRoute(Array(TURNS).fill(1), false);
const { rows, events } = BASELINE;

console.log(`compaction-stability sim: ${TURNS} turns, budget=${budget.budget} high=${budget.high} low=${budget.low}, keepTurns=${KEEP}`);
console.log(`fake token counter: chars/3.4 (same constant as the estimator); prompts built exactly as the route (system+tools prefix included in the text).`);
console.log(`mode: ${LEGACY ? 'LEGACY (pre-fix: re-compact raw every request)' : 'FIXED (replay: sticky cut, watermark-gated events)'}`);
console.log('');

const table = LEGACY ? simulateRoute(Array(TURNS).fill(1), true).rows : rows;
printTable(SUMMARY ? table.filter((r) => r.fired || r.n === 1 || r.n === TURNS) : table);

if (LEGACY) {
  console.log('');
  console.log('NOTE: legacy mode re-compacts the raw history from scratch on EVERY request.');
  console.log('After the first crossing the cut advances one turn per request (see firstChg):');
  console.log('the prompt changes at a new position every turn — the per-turn drift is the bug');
  console.log('the replay fixes. Max re-eval on NON-event turns is the tell:');
  const nonEv = table.filter((r) => !r.fired);
  const drift = nonEv.filter((r) => {
    const prev = table.find((x) => x.n === r.n - 1);
    return prev && r.reEval > r.pTok - prev.pTok + 2;
  });
  console.log(`  turns with re-eval > new content despite "no compaction": ${drift.length}/${nonEv.length}`);
  process.exit(0);
}

// --- checks on the fixed run ------------------------------------------------
// Tolerance: the table counts each prompt's tokens with ceil(len/3.4), so a
// quiet turn's re-eval can exceed the token delta by up to ~ceil(newMsg/3.4)
// tokens (the previous request's trailing user message is never re-sent).
const TOL = 25;
let fails = 0;
const bad = (m) => { fails++; console.log(`FAIL  ${m}`); };
for (const r of rows) {
  if (r.fired) {
    if (r.reEval <= 500) bad(`turn ${r.n}: compaction event with small re-eval (${r.reEval}) — expected one LARGE re-evaluation`);
    if (!(r.reEval >= (r.n > 1 ? r.pTok - rows[r.n - 2].pTok : 0) - TOL)) bad(`turn ${r.n}: event re-eval smaller than the appended content — unexpected`);
  } else {
    if (r.n > 1) {
      const delta = r.pTok - rows[r.n - 2].pTok;
      const dev = Math.abs(r.reEval - delta);
      if (dev > TOL) bad(`turn ${r.n}: re-eval ${r.reEval} != new messages only (delta ${delta}, deviation ${dev} > ${TOL})`);
    }
  }
}
// turns right after an event are small again (same quiet-row rule)
for (const e of events) {
  const next = rows.find((x) => x.n === e.turn + 1);
  if (next && !next.fired && next.n > 1) {
    const delta = next.pTok - rows[next.n - 2].pTok;
    if (Math.abs(next.reEval - delta) > TOL) bad(`turn ${next.n}: re-eval ${next.reEval} right after event at ${e.turn} — expected new content only (${delta})`);
  }
}

// --- calibration perturbation: +/-10% between requests ----------------------
console.log('');
console.log('calibration invariance: usage.prompt_tokens perturbed +/-10% BETWEEN requests');
const pertFactors = Array.from({ length: TURNS }, (_, i) => [0.9, 1.0, 1.1][i % 3]);
const PERT = simulateRoute(pertFactors, false);
let boundarySame = true;
for (let i = 0; i < TURNS; i++) {
  const a = rows[i], b = PERT.rows[i];
  if (a.firstChange !== b.firstChange || a.fired !== b.fired || a.pTok !== b.pTok) {
    boundarySame = false;
    bad(`turn ${i + 1}: perturbed run differs (fired ${a.fired}/${b.fired}, firstChg ${a.firstChange}/${b.firstChange})`);
  }
}
console.log(`  3 runs (0.9/1.0/1.1 cycling per request): compaction boundary${boundarySame ? ' IDENTICAL — calibration does not influence the cut' : ' DIFFERS — BUG'}`);
console.log('');
console.log(`events: ${events.map((e) => `turn ${e.turn} (before=${e.before}, after=${e.after}, ${e.removed} removed)`).join(' | ')}`);
console.log('');
console.log(`${rows.length} turns checked, ${fails} failed`);
process.exit(fails ? 1 : 0);