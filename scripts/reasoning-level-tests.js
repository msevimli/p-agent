/**
 * Reasoning effort/visibility controller — payload mapping tests for
 * buildChatPayload (services/llamaClient.js).
 *
 * Pure function tests (no server): asserts the payload param mapping for
 * every level x endpoint class pair, the Off semantics, invalid-level
 * safety, and that the PROMPT (messages) is byte-identical across levels
 * (KV-cache stability — reasoning params must never touch the prefix).
 */
'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const { buildChatPayload } = require(path.join(ROOT, 'services', 'llamaClient.js'));

const results = [];
const t = (name, pass, info) => results.push(`${pass ? 'PASS' : 'FAIL'} ${name}${info ? ' | ' + String(info) : ''}`);

const MSGS = [{ role: 'user', content: 'hello' }];
const LOCAL = { baseUrl: 'http://127.0.0.1:8080', model: 'local-model' };
const CLOUD = { baseUrl: 'https://openrouter.ai/api/v1', model: 'vendor/model' };

const level = (lvl, target) => {
  const opts = { target, ...(lvl ? { reasoningLevel: lvl } : {}) };
  return buildChatPayload(MSGS, {}, opts);
};

(function () {
  // --- default / absent: nothing injected, payload unchanged
  const base = level(null, LOCAL);
  t('default: no reasoning keys on local', !('reasoning_effort' in base) && !('thinking' in base), JSON.stringify(base));
  const baseC = level(null, CLOUD);
  t('default: no reasoning keys on cloud', !('reasoning_effort' in baseC) && !('thinking' in baseC), JSON.stringify(baseC));

  // --- cloud levels: reasoning_effort only, never the thinking field
  for (const [lvl, expect] of [['low', 'low'], ['medium', 'medium'], ['high', 'high']]) {
    const p = level(lvl, CLOUD);
    t(`cloud ${lvl}: reasoning_effort='${expect}'`, p.reasoning_effort === expect && !('thinking' in p), JSON.stringify(p));
  }
  const cloudOff = level('off', CLOUD);
  t('cloud off: reasoning_effort="none" disables reasoning', cloudOff.reasoning_effort === 'none' && !('thinking' in cloudOff), JSON.stringify(cloudOff));

  // --- local levels: reasoning_effort + Anthropic-style thinking budget
  const expectBudget = { low: 1024, medium: 4096, high: 16384 };
  for (const [lvl, budget] of Object.entries(expectBudget)) {
    const p = level(lvl, LOCAL);
    t(
      `local ${lvl}: effort + thinking budget ${budget}`,
      p.reasoning_effort === lvl &&
        p.thinking && p.thinking.type === 'enabled' && p.thinking.budget_tokens === budget,
      JSON.stringify(p.thinking)
    );
  }
  const localOff = level('off', LOCAL);
  t('local off: reasoning_effort="none", NO thinking field', localOff.reasoning_effort === 'none' && !('thinking' in localOff), JSON.stringify(localOff));

  // --- unknown levels are dropped (provider default), never garbage
  const bogus = level('extreme', CLOUD);
  t('unknown level: omitted entirely', !('reasoning_effort' in bogus) && !('thinking' in bogus), JSON.stringify(bogus));
  const bogusLocal = level('turbo', LOCAL);
  t('unknown level: omitted on local too', !('reasoning_effort' in bogusLocal) && !('thinking' in bogusLocal), '');

  // --- KV stability: the prompt bytes must be identical at every level
  const prompts = ['default', 'off', 'low', 'medium', 'high', 'extreme'].map((lvl) =>
    JSON.stringify(level(lvl, LOCAL).messages)
  );
  t('KV: messages byte-identical across all levels', prompts.every((p) => p === prompts[0]), `${prompts[0]}`);

  // --- generation-layer fallback (routes/chat.js threads it via gen)
  const viaGen = buildChatPayload(MSGS, { reasoningLevel: 'high' }, { target: CLOUD });
  t('gen-layer fallback: o.reasoningLevel || gen.reasoningLevel', viaGen.reasoning_effort === 'high', JSON.stringify(viaGen.reasoning_effort));
  const optsWins = buildChatPayload(MSGS, { reasoningLevel: 'low' }, { target: CLOUD, reasoningLevel: 'high' });
  t('opts-layer wins over gen-layer', optsWins.reasoning_effort === 'high', '');

  // --- active-model fallback (no explicit target) still maps (loopback
  //     detection falls back to cloud semantics when the target is unknown)
  const noTarget = buildChatPayload(MSGS, { reasoningLevel: 'medium' }, {});
  t('no target: level still injected (cloud-safe semantics)', noTarget.reasoning_effort === 'medium', JSON.stringify(noTarget.reasoning_effort));
})();

console.log(results.join('\n'));
const failed = results.filter((r) => r.startsWith('FAIL'));
if (failed.length) {
  console.log(`\n${failed.length} FAILED`);
  process.exitCode = 1;
} else {
  console.log(`\nALL ${results.length} PASSED`);
}