#!/usr/bin/env node
/**
 * Cloud-vs-local payload policy tests (services/llamaClient.js):
 *   - llama.cpp-only params (repeat_penalty, repeat_last_n, cache_prompt) are
 *     ALWAYS stripped for cloud targets — strict OpenAI-compatible providers
 *     (Nvidia NIM etc.) reject them with HTTP 400 "Unsupported parameter(s)".
 *   - Local targets keep them by default; the frontend advanced toggle
 *     (body.generation.advancedParams === false) strips them locally too.
 *   - Resilience seam: isUnsupportedParamError + minimalCloudPayload for the
 *     one-shot cloud-400 retry in doComplete.
 *   - Reasoning mapping stays provider-correct (cloud: reasoning_effort only,
 *     no thinking budget).
 */
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const results = [];
const t = (name, cond, detail) => results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`);

const lc = require(path.join(ROOT, 'services', 'llamaClient'));
const { buildChatPayload, LOCAL_ONLY_PARAMS, isLoopbackBaseUrl, isUnsupportedParamError, minimalCloudPayload } = lc;

const MSGS = [{ role: 'user', content: 'hi' }];
const CLOUD = { baseUrl: 'https://integrate.api.nvidia.com/v1', model: 'nvidia/llama-3.1-8b-instruct' };
const LOCAL = { baseUrl: 'http://127.0.0.1:8081', model: 'local-model' };

(async () => {
  // ---------------- 1. local target keeps local-only params ----------------
  let p = buildChatPayload(MSGS, {}, { target: LOCAL, system: 'sys' });
  t('local: repeat_penalty present', typeof p.repeat_penalty === 'number', `=${p.repeat_penalty}`);
  t('local: repeat_last_n present', typeof p.repeat_last_n === 'number', `=${p.repeat_last_n}`);
  t('local: cache_prompt true (KV reuse)', p.cache_prompt === true, String(p.cache_prompt));

  // ---------------- 2. cloud target always strips them ---------------------
  p = buildChatPayload(MSGS, {}, { target: CLOUD, system: 'sys' });
  t('cloud: repeat_penalty stripped', !('repeat_penalty' in p), '');
  t('cloud: repeat_last_n stripped', !('repeat_last_n' in p), '');
  t('cloud: cache_prompt stripped', !('cache_prompt' in p), '');
  t('cloud: standard OpenAI params kept', p.temperature === 0.7 && p.top_p === 0.95 && p.max_tokens >= 1, JSON.stringify({ t: p.temperature, p: p.top_p, m: p.max_tokens }));
  t('cloud: stream_options kept (OpenAI spec)', p.stream && p.stream_options && p.stream_options.include_usage === true, '');
  t('cloud: no key from LOCAL_ONLY_PARAMS survives', !LOCAL_ONLY_PARAMS.some((k) => k in p), JSON.stringify(LOCAL_ONLY_PARAMS.filter((k) => k in p)));

  // ---------------- 3. local + advanced toggle off --------------------------
  p = buildChatPayload(MSGS, { advancedParams: false }, { target: LOCAL, system: 'sys' });
  t('local+off: repeat_penalty/repeat_last_n/cache_prompt all stripped',
    !LOCAL_ONLY_PARAMS.some((k) => k in p), JSON.stringify(LOCAL_ONLY_PARAMS.filter((k) => k in p)));
  p = buildChatPayload(MSGS, { advancedParams: true }, { target: LOCAL, system: 'sys' });
  t('local+on: all local-only params present', LOCAL_ONLY_PARAMS.every((k) => k in p), '');

  // ---------------- 4. reasoning mapping stays provider-correct -------------
  p = buildChatPayload(MSGS, { reasoningLevel: 'medium' }, { target: CLOUD, system: 'sys' });
  t('cloud+medium: reasoning_effort set, NO thinking budget', p.reasoning_effort === 'medium' && !('thinking' in p), JSON.stringify(p.reasoning_effort));
  p = buildChatPayload(MSGS, { reasoningLevel: 'medium' }, { target: LOCAL, system: 'sys' });
  t('local+medium: reasoning_effort + thinking budget', p.reasoning_effort === 'medium' && p.thinking && p.thinking.budget_tokens === 4096, JSON.stringify(p.thinking));

  // ---------------- 5. resilience seams -------------------------------------
  t('loopback: 127.0.0.1', isLoopbackBaseUrl('http://127.0.0.1:8081') === true, '');
  t('loopback: localhost', isLoopbackBaseUrl('https://localhost:1234/v1') === true, '');
  t('loopback: 0.0.0.0 + ::1', isLoopbackBaseUrl('http://0.0.0.0:8081') === true && isLoopbackBaseUrl('http://[::1]:8081') === true, '');
  t('loopback: nvidia/OpenRouter NOT loopback', isLoopbackBaseUrl('https://integrate.api.nvidia.com/v1') === false && isLoopbackBaseUrl('https://openrouter.ai/api/v1') === false, '');
  t('unsupported-param detection', isUnsupportedParamError('{"error":"Unsupported parameter(s): repeat_penalty, repeat_last_n, cache_prompt"}') === true, '');
  t('unsupported-param NEGATIVE (rate limit)', isUnsupportedParamError('{"error":"rate limit exceeded"}') === false, '');
  const full = buildChatPayload(MSGS, {}, { target: LOCAL, system: 'sys', tools: [{ type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object' } } }] });
  const min = minimalCloudPayload(full);
  t('minimal: strips local-only + stream_options', !LOCAL_ONLY_PARAMS.some((k) => k in min) && !('stream_options' in min), '');
  t('minimal: keeps model/messages/stream/temperature/max_tokens/tools',
    min.model && Array.isArray(min.messages) && min.stream === true && typeof min.temperature === 'number' && typeof min.max_tokens === 'number' && Array.isArray(min.tools), '');

  const fails = results.filter((x) => x.startsWith('FAIL')).length;
  console.log(results.join('\n'));
  console.log(`\n${results.length - fails}/${results.length} cloud-payload tests passed${fails ? ` (${fails} FAILED)` : ''}`);
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});