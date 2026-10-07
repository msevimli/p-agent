#!/usr/bin/env node
/**
 * scripts/cache-sim-test.js — measure time-to-first-token (TTFT) and KV-cache
 * reuse of the agent's prompt against the active llama.cpp endpoint.
 *
 * REAL MODE (llama-server reachable): sends
 *   1. warm-up   — the static prefix only (system + ALL tools, max_tokens=1)
 *   2. message 1 — "Hi" (expect a cache hit on the warm-up prefix)
 *   3. message 2 — "Hi again" (expect cache hits on prefix + msg1 + reply)
 * and reports real TTFT + cached-token counts from usage/timings.
 *
 * SIMULATED MODE (server down): prints the same table using the prompt sizes
 * measured with the real Qwen2 tokenizer (scripts/measure-prompts.js +
 * scripts/tokenize-prompt.py) and the speed profile from env
 * (SIM_PROMPT_TOK_S default 10, SIM_GEN_TOK_S default 2.5 — the measured
 * profile of this VPS). Clearly labelled as an estimate; re-run with the
 * server up for real numbers.
 *
 * Usage: node scripts/cache-sim-test.js
 */
const config = require('../config');
const modelManager = require('../services/modelManager');
const toolLoop = require('../services/toolLoop');
const llamaClient = require('../services/llamaClient');

// Measured with the real Qwen2.5 tokenizer (see tokenize-prompt.py): prompt
// token counts of the CURRENT system prompt + FULL 16-tool array (raw text).
const PREFIX_TOKENS_ALL = 1922; // system + all 16 tools (raw text)
const TEMPLATE_OVERHEAD = 42; // Qwen chat-template + "Hi" message wrapper
const OLD_PREFIX_TOKENS = 5444; // pre-round-1 baseline (system + 16 tools, verbose)

const PROMPT_TOK_S = Number(process.env.SIM_PROMPT_TOK_S) || 10; // measured ~10 t/s
const GEN_TOK_S = Number(process.env.SIM_GEN_TOK_S) || 2.5; // measured ~2-3 t/s
const REPLY_TOKENS = 60; // typical short first reply

const fmt = (s) => `${s.toFixed(1)}s`;

async function serverUp() {
  const active = modelManager.getActiveModel();
  const target = { baseUrl: active.endpoint, model: active.model };
  const h = await llamaClient.checkLlamaHealth();
  return { up: h.up, target };
}

function simulate() {
  const userMsgTokens = 3; // "Hi"
  const prefixAll = PREFIX_TOKENS_ALL + TEMPLATE_OVERHEAD;
  const oldPrefix = OLD_PREFIX_TOKENS + TEMPLATE_OVERHEAD;
  const cold = (prefix) => prefix / PROMPT_TOK_S + REPLY_TOKENS / GEN_TOK_S;
  const warm = (prefix, histTokens) => (userMsgTokens + histTokens) / PROMPT_TOK_S + REPLY_TOKENS / GEN_TOK_S;

  console.log('llama-server NOT reachable — SIMULATED numbers (estimates from real token counts + measured speeds).');
  console.log('Start llama-server and re-run to get real measurements.\n');
  console.log(`prompt speed: ${PROMPT_TOK_S} tok/s · gen speed: ${GEN_TOK_S} tok/s (defaults from your measured profile; override SIM_PROMPT_TOK_S / SIM_GEN_TOK_S)`);
  console.log('');
  console.log('prompt prefix (system + tools):');
  console.log(`  OLD: ${OLD_PREFIX_TOKENS} tokens (16 tools, embedded schema)`);
  console.log(`  NEW: ${PREFIX_TOKENS_ALL} tokens — FULL 16-tool set, always (stable prefix)`);
  console.log('');
  console.log('time to FIRST TOKEN (cold start, no warm-up):');
  console.log(`  OLD: ~${fmt(cold(oldPrefix))}   (prefix ${oldPrefix} tokens at ${PROMPT_TOK_S} tok/s + ${REPLY_TOKENS} reply tokens)`);
  console.log(`  NEW: ~${fmt(cold(prefixAll))}   (prefix ${prefixAll} tokens + reply)`);
  console.log('');
  console.log('time to FIRST TOKEN after warm-up / on 2nd message (cache hit):');
  const newHist = userMsgTokens + REPLY_TOKENS; // msg1 + assistant reply
  console.log(`  NEW msg2: ~${fmt(warm(prefixAll, newHist))}  (only ${userMsgTokens + newHist} new prompt tokens processed — the rest come from the KV cache)`);
  console.log('');
  console.log('expected cache behaviour (real server): msg2 usage would report');
  console.log(`  prompt_tokens ≈ ${prefixAll + newHist}, evaluated ≈ ${userMsgTokens + newHist}, cached ≈ ${prefixAll}`);
}

async function realRun(target) {
  const systemPrompt = toolLoop.buildSystemPrompt(config.llamaSystemPrompt);
  const tools = toolLoop.toOpenAITools(); // FULL set — same as every request
  const msgs = (extra) => [{ role: 'system', content: systemPrompt }, ...extra];
  const one = async (label, messages) => {
    const t0 = Date.now();
    const acc = await llamaClient.complete({
      payload: llamaClient.buildChatPayload(messages, { max_tokens: 16, temperature: 0 }, { tools }),
    });
    const ms = Date.now() - t0;
    const u = acc.usage || {};
    const tm = acc.timings || {};
    const cached = Number.isFinite(u.prompt_tokens) && Number.isFinite(tm.prompt_n)
      ? Math.max(0, u.prompt_tokens - tm.prompt_n) : null;
    console.log(
      `${label}: ttft=${fmt(acc.firstTokenMs / 1000)} wall=${fmt(ms / 1000)} ` +
      `prompt=${u.prompt_tokens} evaluated=${tm.prompt_n} cached=${cached ?? 'n/a'} ` +
      `pp=${tm.prompt_per_second?.toFixed(1)}t/s gen=${tm.predicted_per_second?.toFixed(1)}t/s`
    );
    return acc;
  };

  console.log(`REAL measurement against ${target.baseUrl} (model ${target.model})`);
  const r1 = await one('warm-up (prefix only) ', [{ role: 'user', content: 'ping' }]);
  const msg1 = r1.content.trim() ? r1.content : '(no content)';
  const r2 = await one('message 1 ("Hi")      ', [{ role: 'user', content: 'Hi' }]);
  const r3 = await one('message 2 ("Hi again")', [
    { role: 'user', content: 'Hi' },
    { role: 'assistant', content: r2.content.trim() },
    { role: 'user', content: 'Hi again' },
  ]);
  console.log('\nnote: msg1 prefixed reply was:', JSON.stringify(msg1.slice(0, 40)));
  void r1;
  void r3;
}

(async () => {
  const { up, target } = await serverUp();
  console.log(`active endpoint: ${target.baseUrl} (model ${target.model})`);
  console.log('='.repeat(64));
  if (up) {
    try {
      await realRun(target);
    } catch (e) {
      console.log(`REAL run failed: ${e.message}`);
      console.log('falling back to simulation:\n');
      simulate();
    }
  } else {
    simulate();
  }
})();