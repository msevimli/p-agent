/**
 * cascade-tests.js — pure unit tests for the two-stage cascade service
 * (services/cascade.js). No llama-server, no network: everything tested here
 * is deterministic string/logic behavior.
 *
 *   node scripts/cascade-tests.js
 *
 * Also asserts the LIVE registry contract (data/models-state.json carries a
 * 'router' and a 'primary' role) — the deployment state the cascade needs.
 */
const assert = require('assert');
const path = require('path');
const cascade = require('../services/cascade');

let passed = 0;
let failed = 0;

function t(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`FAIL  ${name} — ${e.message}`);
  }
}

console.log('markerMatch');
t('exact marker', () => assert.strictEqual(cascade.markerMatch('ROUTE_TO_PRIMARY'), true));
t('whitespace-padded marker', () => assert.strictEqual(cascade.markerMatch('  ROUTE_TO_PRIMARY\n'), true));
t('fenced marker (bare fence)', () => assert.strictEqual(cascade.markerMatch('```\nROUTE_TO_PRIMARY\n```'), true));
t('fenced marker (text fence)', () => assert.strictEqual(cascade.markerMatch('```text\nROUTE_TO_PRIMARY\n```'), true));
t('quoted marker', () => assert.strictEqual(cascade.markerMatch('"ROUTE_TO_PRIMARY"'), true));
t('trailing period', () => assert.strictEqual(cascade.markerMatch('ROUTE_TO_PRIMARY.'), true));
t('case-insensitive', () => assert.strictEqual(cascade.markerMatch('route_to_primary'), true));
t('fenced JSON tool-call variant (small-model habit)', () =>
  assert.strictEqual(cascade.markerMatch('```json\n{\n  "name": "route_to_primary",\n  "arguments": {}\n}\n```'), true));
t('plain phrase escalates', () => assert.strictEqual(cascade.markerMatch('please route to primary model'), true));
t('marker with trailing words still matches (intent phrase)', () => assert.strictEqual(cascade.markerMatch('ROUTE_TO_PRIMARY please'), true));
t('prose with intervening words is not escalation', () => assert.strictEqual(cascade.markerMatch('I think we should route this to the primary model.'), false));
t('ordinary answer is not a marker', () => assert.strictEqual(cascade.markerMatch('Sure, here is the explanation you asked for.'), false));
t('empty string', () => assert.strictEqual(cascade.markerMatch(''), false));

console.log('decideNoCall');
t('marker mode: marker escalates', () => assert.strictEqual(cascade.decideNoCall('ROUTE_TO_PRIMARY', 'marker'), 'escalate'));
t('marker mode: plain reply answers', () => assert.strictEqual(cascade.decideNoCall('Hello!', 'marker'), 'answer'));
t('always mode: everything escalates', () => assert.strictEqual(cascade.decideNoCall('Hello!', 'always'), 'escalate'));
t('never mode: marker replies answer', () => assert.strictEqual(cascade.decideNoCall('ROUTE_TO_PRIMARY', 'never'), 'answer'));
t('unknown mode falls back to marker behavior', () => assert.strictEqual(cascade.decideNoCall('ROUTE_TO_PRIMARY', 'bogus'), 'escalate'));

console.log('resolveFrom (pure)');
const mk = (id, role, endpoint) => ({ id, role, endpoint });
t('router+primary roles -> enabled', () => {
  const r = cascade.resolveFrom(
    { activeId: 'p', models: [mk('r', 'router', 'http://127.0.0.1:8081'), mk('p', 'primary', 'http://127.0.0.1:8080')] },
    { enabled: true, escalate: 'marker' }
  );
  assert.strictEqual(r.enabled, true);
  assert.strictEqual(r.router.id, 'r');
  assert.strictEqual(r.primary.id, 'p');
  assert.strictEqual(r.escalate, 'marker');
});
t('missing router -> disabled', () => {
  const r = cascade.resolveFrom(
    { activeId: 'p', models: [mk('p', 'primary', 'http://127.0.0.1:8080')] },
    { enabled: true }
  );
  assert.strictEqual(r.enabled, false);
});
t('no explicit primary -> single-model mode (router bypassed)', () => {
  const r = cascade.resolveFrom(
    { activeId: 'a', models: [mk('r', 'router', 'http://127.0.0.1:8081'), mk('a', '', 'http://127.0.0.1:8080')] },
    { enabled: true }
  );
  // A selected model without a configured pair disables the cascade: all
  // turns go straight to the selection — no router stage at all.
  assert.strictEqual(r.enabled, false);
  assert.strictEqual(r.primary.id, 'a');
});
t('selected model outside the pair -> cascade bypassed', () => {
  const r = cascade.resolveFrom(
    {
      activeId: 'gemma',
      models: [
        mk('r', 'router', 'http://127.0.0.1:8081'),
        mk('p', 'primary', 'http://127.0.0.1:8080'),
        mk('gemma', '', 'http://127.0.0.1:8081'),
      ],
    },
    { enabled: true }
  );
  // THE user-reported bug: selecting Gemma4-4B still routed via the 3B router.
  assert.strictEqual(r.enabled, false);
  assert.strictEqual(r.primary.id, 'gemma');
  assert.strictEqual(r.activeId, 'gemma');
});
t('selecting the router-role model itself -> single-model mode', () => {
  const r = cascade.resolveFrom(
    { activeId: 'r', models: [mk('r', 'router', 'http://127.0.0.1:8081'), mk('p', 'primary', 'http://127.0.0.1:8080')] },
    { enabled: true }
  );
  assert.strictEqual(r.enabled, false);
  assert.strictEqual(r.primary.id, 'r');
});
t('no active selection + roles present -> cascade default on', () => {
  const r = cascade.resolveFrom(
    { activeId: null, models: [mk('r', 'router', 'http://127.0.0.1:8081'), mk('p', 'primary', 'http://127.0.0.1:8080')] },
    { enabled: true }
  );
  assert.strictEqual(r.enabled, true);
  assert.strictEqual(r.primary.id, 'p');
});
t('router == primary id -> disabled (would ping-pong)', () => {
  const r = cascade.resolveFrom(
    { activeId: 'x', models: [mk('x', 'router', 'http://127.0.0.1:8081')] },
    { enabled: true }
  );
  assert.strictEqual(r.enabled, false);
});
t('remote (non-loopback) router -> disabled', () => {
  const r = cascade.resolveFrom(
    {
      activeId: 'p',
      models: [mk('r', 'router', 'https://openrouter.ai/api/v1'), mk('p', 'primary', 'http://127.0.0.1:8080')],
    },
    { enabled: true }
  );
  assert.strictEqual(r.enabled, false);
});
t('global switch off -> disabled', () => {
  const r = cascade.resolveFrom(
    { activeId: 'p', models: [mk('r', 'router', 'http://127.0.0.1:8081'), mk('p', 'primary', 'http://127.0.0.1:8080')] },
    { enabled: false }
  );
  assert.strictEqual(r.enabled, false);
});

console.log('looksLikeToolAttempt');
t('fenced JSON with tool key is a tool attempt', () => assert.strictEqual(cascade.looksLikeToolAttempt('```json\n{"tool": "documentation", "args": {"url": "https://x"}}\n```'), true));
t('XML tool tag is a tool attempt', () => assert.strictEqual(cascade.looksLikeToolAttempt('<tool_call>{"name":"read_file","arguments":{"path":"a"}}</tool_call>'), true));
t('bare JSON tool object is a tool attempt (no fence)', () => assert.strictEqual(cascade.looksLikeToolAttempt('{"tool": "print_datetime", "args": {}}'), true));
t('bare function-echo object is a tool attempt', () => assert.strictEqual(cascade.looksLikeToolAttempt('{"function": "run_skill", "arguments": {"name": "x"}}'), true));
t('plain prose is not a tool attempt', () => assert.strictEqual(cascade.looksLikeToolAttempt('TCP is a transport protocol that...'), false));
t('marker line alone is not a tool attempt', () => assert.strictEqual(cascade.looksLikeToolAttempt('ROUTE_TO_PRIMARY'), false));
t('code fence without tool keys is not a tool attempt', () => assert.strictEqual(cascade.looksLikeToolAttempt('```python\nprint("hi")\n```'), false));

console.log('looksLikeFabricatedConfirmation');
t('file-remove request + "Skill removed successfully" reply -> escalate', () =>
  assert.strictEqual(cascade.looksLikeFabricatedConfirmation('Skill removed successfully. Is there anything else I can assist you with?', 'remove greeting.txt in the workspace'), true));
t('file-remove request + "removed successfully" -> escalate', () =>
  assert.strictEqual(cascade.looksLikeFabricatedConfirmation('The file has been removed successfully.', 'please delete the file'), true));
t('skill-remove request + "deleted" confirmation -> escalate', () =>
  assert.strictEqual(cascade.looksLikeFabricatedConfirmation('Skill deleted.', 'delete the print_datetime skill'), true));
t('action request + "done" -> escalate (safer than trusting)', () =>
  assert.strictEqual(cascade.looksLikeFabricatedConfirmation('Done!', 'remove deleteme.txt'), true));
t('no action verb in user text -> never escalate', () =>
  assert.strictEqual(cascade.looksLikeFabricatedConfirmation('Done!', 'hello, tell me a joke'), false));
t('no confirmation wording in reply -> never escalate', () =>
  assert.strictEqual(cascade.looksLikeFabricatedConfirmation('I am not sure how to help with that.', 'remove greeting.txt'), false));
t('banal conversational reply to action-free chat -> never escalate', () =>
  assert.strictEqual(cascade.looksLikeFabricatedConfirmation('Sounds good.', 'hi'), false));
t('informational reply mentioning files -> never escalate', () =>
  assert.strictEqual(cascade.looksLikeFabricatedConfirmation('The directory listing shows greeting.txt.', 'what files are here'), false));

console.log('unitNameFor');
t('cascade router role -> stable unit name', () => assert.strictEqual(cascade.unitNameFor({ id: 'qwen-2-5-1-5b-q5', role: 'router' }), 'llama-router.service'));
t('cascade primary role -> stable unit name', () => assert.strictEqual(cascade.unitNameFor({ id: 'qwen-2-5-7b-q5', role: 'primary' }), 'llama-primary.service'));
t('other local model -> id-derived name', () => assert.strictEqual(cascade.unitNameFor({ id: 'gemma' }), 'llama-gemma.service'));
t('mixed case normalized', () => assert.strictEqual(cascade.unitNameFor({ id: 'My.Model_1' }), 'llama-my.model_1.service'));
t('missing id falls back', () => assert.strictEqual(cascade.unitNameFor(null), 'llama-model.service'));

console.log('live registry (deployment contract)');
t('router tool set advertises delete_file + the core-5', () => {
  const names = cascade.routerTools().map((t) => t.function && t.function.name);
  assert.ok(names.includes('delete_file') && names.includes('run_shell') && names.includes('write_file'),
    'router must advertise the core set incl. delete_file: ' + names.join(','));
  assert.ok(names.length >= 6, 'expected at least 6 core tools, got ' + names.length);
});
t('router tool set contains ONLY core tools (no skills/automations)', () => {
  const names = cascade.routerTools().map((t) => t.function && t.function.name);
  const forbidden = names.filter((n) => n.startsWith('list_skill') || n.startsWith('run_skill') || n.startsWith('write_skill') || n.startsWith('delete_skill') || n.includes('automation') || n.includes('library'));
  assert.deepStrictEqual(forbidden, [], 'no skills/automations/library tools may reach the router');
});
t('live registry: selection outside the pair bypasses the cascade', () => {
  const live = require('../data/models-state.json');
  const r = cascade.resolveFrom(live, { enabled: true });
  // The user currently has Gemma4-4B selected (activeId) — the cascade must
  // be OFF and the primary target must be the SELECTED model, not the
  // role-based qwen pair. (This is the exact Capture_8 bug as a regression
  // guard: selecting a single model used to leave the 3B router in charge.)
  assert.strictEqual(r.enabled, false, 'selection outside the pair must disable the cascade');
  assert.strictEqual(r.primary.id, live.activeId, 'the selected model must be the stage-2 target');
});
t('live registry: activating the configured primary re-enables the cascade', () => {
  const live = JSON.parse(JSON.stringify(require('../data/models-state.json')));
  const primary = live.models.find((m) => m && m.role === 'primary');
  assert.ok(primary, 'a primary role must exist');
  live.activeId = primary.id;
  const r = cascade.resolveFrom(live, { enabled: true });
  assert.strictEqual(r.enabled, true, 'selecting the configured primary must run the two-stage cascade');
  assert.strictEqual(r.primary.id, primary.id);
  assert.ok(r.router && r.router.role === 'router', 'a router role must exist');
  assert.notStrictEqual(r.router.id, r.primary.id, 'router and primary must differ');
});

console.log(`\n${failed === 0 ? 'ALL PASSED' : 'FAILURES: ' + failed} (${passed} passed, ${failed} failed)`);
process.exit(failed === 0 ? 0 : 1);