#!/usr/bin/env node
/**
 * scripts/cache-check-short.js — ONE short real-server check (≤3 turns,
 * small tool outputs, total prompt < ~2500 tokens). Purpose: confirm that
 * the full 16-tool prefix is cached after warm-up (evaluated tokens stay
 * small on turn 2 and 3) and that the prefix hash stays identical.
 *
 * Uses llamaClient.complete directly (same code path as the chat route,
 * minus the agentic loop), so no tool-round/continuation surprises and the
 * whole thing runs in a couple of minutes even at ~7-15 tok/s prefill.
 *
 * Usage: node scripts/cache-check-short.js
 *   env: SIM_PROMPT_TOK_S / SIM_GEN_TOK_S used only for the simulated
 *        fallback when the server is unreachable.
 */
const config = require('../config');
const historyManager = require('../services/historyManager');
const toolLoop = require('../services/toolLoop');
const llamaClient = require('../services/llamaClient');
const modelManager = require('../services/modelManager');

const SIM_PP = Number(process.env.SIM_PROMPT_TOK_S || 10);
const SIM_GEN = Number(process.env.SIM_GEN_TOK_S || 2.5);

const fmt = (s) => `${s.toFixed(1)}s`;

async function serverUp() {
  const h = await llamaClient.checkLlamaHealth();
  return h.up;
}

async function one(label, messages) {
  const systemPrompt = toolLoop.buildSystemPrompt(config.llamaSystemPrompt);
  const tools = toolLoop.toOpenAITools(); // full 16, always
  const t0 = Date.now();
  const acc = await llamaClient.complete({
    payload: llamaClient.buildChatPayload(
      [{ role: 'system', content: systemPrompt }, ...messages],
      { max_tokens: 16, temperature: 0 },
      { tools }
    ),
  });
  const wallS = (Date.now() - t0) / 1000;
  const u = acc.usage || {};
  const tm = acc.timings || {};
  const prompt = Number.isFinite(u.prompt_tokens) ? u.prompt_tokens : null;
  const evalN = Number.isFinite(tm.prompt_n) ? tm.prompt_n : null;
  const cached = prompt !== null && evalN !== null ? Math.max(0, prompt - evalN) : null;
  const hash = historyManager.prefixHashFor(systemPrompt, JSON.stringify(tools));
  console.log(
    `${label}: prompt=${prompt ?? 'n/a'} evaluated=${evalN ?? 'n/a'} cached=${cached ?? 'n/a'} ` +
      `ttft=${fmt((acc.firstTokenMs || 0) / 1000)} wall=${fmt(wallS)} pp=${tm.prompt_per_second ? tm.prompt_per_second.toFixed(1) : 'n/a'}t/s prefix=${hash}`
  );
  return { prompt, evalN, cached, hash, wallS, content: acc.content };
}

function simulate() {
  console.log('SIMULATED (llama-server unreachable) — estimates only:');
  const prefix = 2390; // measured server-rendered warm-up prompt
  console.log(`  warm-up:   prompt≈${prefix} (full 16-tool prefix — would take ~${fmt(prefix / SIM_PP)} prefill)`);
  console.log(`  turn 2:    prompt≈${prefix + 150}, evaluated≈40 (only the new user message), cached≈${prefix}`);
  console.log(`  turn 3:    prompt≈${prefix + 300}, evaluated≈70 (new message + last reply), cached≈${prefix + 230}`);
  console.log('  prefix hash: constant by construction (identical serialization) — run with the server up for real numbers');
}

(async () => {
  const up = await serverUp();
  console.log(`llama-server ${up ? 'reachable — REAL check' : 'NOT reachable — simulation'}`);
  console.log('='.repeat(72));
  if (!up) {
    simulate();
    return;
  }

  // Small tool output (~250 chars) so turn history stays far below any
  // watermark: this check measures PREFIX caching, not compaction.
  const toolResult = historyManager.formatToolResults([
    { name: 'run_shell', result: { ok: true, stdout: 'small diagnostic output: all checks passed\n', stderr: '' } },
  ]);
  const hist = [
    { role: 'user', content: 'Run the diagnostic and tell me the result.' },
    { role: 'assistant', content: JSON.stringify({ tool: 'run_shell', args: { command: 'diag' } }) },
    { role: 'user', content: toolResult },
    { role: 'assistant', content: 'The diagnostic passed.' },
  ];

  const w = await one('warm-up (prefix only) ', [{ role: 'user', content: 'ping' }]);
  const t2 = await one('turn 2                ', [...hist, { role: 'user', content: 'Look at that output again and say OK.' }]);
  const t3 = await one('turn 3                ', [...hist, { role: 'user', content: 'Look at that output again and say OK.' }, { role: 'assistant', content: t2.content.trim() }, { role: 'user', content: 'And now try once more — just OK.' }]);

  const hashes = [w.hash, t2.hash, t3.hash];
  console.log('');
  console.log('checks:');
  console.log(`  prefix hash identical across all 3 completions: ${new Set(hashes).size === 1 ? `YES (${hashes[0]})` : 'NO — INVALIDATED: ' + hashes.join(' vs ')}`);
  const small = [t2.evalN, t3.evalN].every((n) => n !== null && n < 200);
  console.log(`  evaluated tokens stay small on turns 2+3 (<200): ${small ? 'YES' : 'NO'} (${t2.evalN} / ${t3.evalN})`);
  console.log(`  total prompt stayed under 2500 tokens: ${[w.prompt, t2.prompt, t3.prompt].every((p) => p !== null && p < 2500) ? 'YES' : 'NO'} (${w.prompt}/${t2.prompt}/${t3.prompt})`);
  if (!small || new Set(hashes).size !== 1) process.exitCode = 1;
})();