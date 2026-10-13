#!/usr/bin/env node
/**
 * Regression tests for cascade role assignment (services/modelManager.js):
 *
 *  1. setCascadeRoles() atomically stamps the router/primary pair and clears
 *     every other role — the file can never hold two routers (the current
 *     pre-fix state actually did).
 *  2. Same model for both roles / unknown ids are rejected and change nothing.
 *  3. Empty ids unset a stage; both empty clears the whole cascade.
 *  4. updateModel/createModel with a role STEAL it from the previous holder
 *     (role exclusivity via clearDuplicateRoles).
 *  5. The live cascade resolver (services/cascade.js resolveFrom) sees the
 *     newly assigned pair from the file — no restart needed.
 *
 * Runs against the REAL registry file: data/models-state.json is backed up
 * before the run and restored on exit (same pattern as loop-guard-test.js),
 * so the suite is safe against a live server — while it runs, the cascade
 * momentarily reflects the test pair, which is harmless.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STATE_FILE = path.join(ROOT, 'data', 'models-state.json');
const backup = fs.readFileSync(STATE_FILE, 'utf8');

const results = [];
const t = (name, cond, detail) =>
  results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`);

const modelManager = require('../services/modelManager');
const cascade = require('../services/cascade');

const readRoles = () => {
  const st = modelManager.getState();
  const router = (st.models || []).find((m) => m.role === 'router') || null;
  const primary = (st.models || []).find((m) => m.role === 'primary') || null;
  return { router, primary };
};

try {
  // ---------------------------------------------------------------- fixtures
  const { models } = JSON.parse(backup);
  const ids = models.map((m) => m.id);
  const [a, b, c] = ids;
  if (ids.length < 2) throw new Error('need >= 2 models in models-state.json for the role tests');

  // ------------------------------------------------------------------ 1. pair
  let r = modelManager.setCascadeRoles(a, b);
  t('setCascadeRoles ok', r.ok === true, JSON.stringify(r));
  t('pair stamped in response', r.router && r.router.id === a && r.primary && r.primary.id === b);
  let roles = readRoles();
  t('pair persisted to disk', roles.router && roles.router.id === a && roles.primary && roles.primary.id === b);
  const st = modelManager.getState();
  const holders = st.models.filter((m) => m.role);
  t('no role duplicates on disk', holders.length === 2 && holders.every((m) => m.id === a || m.id === b));

  //                                             2. same model both roles
  const before = JSON.stringify(modelManager.getState());
  r = modelManager.setCascadeRoles(a, a);
  t('same model for both roles rejected', r.ok === false && /different models/.test(r.error), r.error);
  t('rejected call left file untouched', JSON.stringify(modelManager.getState()) === before);

  //                                             3. unknown id
  r = modelManager.setCascadeRoles('no-such-model', b);
  t('unknown router id rejected', r.ok === false && /not found/.test(r.error), r.error);
  t('unknown-id call left file untouched', JSON.stringify(modelManager.getState()) === before);
  r = modelManager.setCascadeRoles(a, 'no-such-model');
  t('unknown primary id rejected', r.ok === false && /not found/.test(r.error), r.error);

  //                                             4. swap pair
  r = modelManager.setCascadeRoles(b, a);
  t('pair swap works', r.ok === true);
  roles = readRoles();
  t('swap persisted', roles.router && roles.router.id === b && roles.primary && roles.primary.id === a);

  //                                             5. unset stages
  r = modelManager.setCascadeRoles('', a);
  t('router unset (primary kept)', r.ok === true && r.router === null && r.primary && r.primary.id === a);
  roles = readRoles();
  t('unset persisted', roles.router === null && roles.primary && roles.primary.id === a);
  r = modelManager.setCascadeRoles(null, null);
  t('both unset clears cascade', r.ok === true && r.router === null && r.primary === null);
  roles = readRoles();
  t('full clear persisted', roles.router === null && roles.primary === null);

  //                               6. editor path: updateModel steals the role
  const aFull = models.find((m) => m.id === a);
  const bFull = models.find((m) => m.id === b);
  modelManager.setCascadeRoles(a, b); // a=router, b=primary
  const up = modelManager.updateModel(b, {
    id: b,
    name: bFull.name,
    endpoint: bFull.endpoint,
    model: bFull.model,
    contextLength: bFull.contextLength,
    role: 'router', // b takes over the router role from a (and loses primary)
  });
  t('updateModel with role ok', up.ok === true);
  roles = readRoles();
  t('updateModel stole router role', roles.router && roles.router.id === b && roles.primary === null,
    `router=${roles.router && roles.router.id} primary=${roles.primary && roles.primary.id}`);

  //                                  7. create path steals the role too
  const fresh = `tmp-model-${Date.now()}`;
  const created = modelManager.createModel({
    id: fresh,
    name: 'Temp Role Test',
    endpoint: 'http://127.0.0.1:9999',
    model: 'test.gguf',
    contextLength: 8192,
    role: 'primary', // nobody holds primary now — fresh becomes primary
  });
  t('createModel with role ok', created.ok === true);
  roles = readRoles();
  t('createModel set primary', roles.primary && roles.primary.id === fresh && roles.router && roles.router.id === b);
  modelManager.deleteModel(fresh);

  //                8. live resolver sees the pair from disk (instant switch)
  modelManager.setCascadeRoles(a, b);
  const resolved = cascade.resolve();
  t('cascade.resolve uses the new pair', resolved.enabled && resolved.router.id === a && resolved.primary.id === b);

  const failed = results.filter((l) => l.startsWith('FAIL'));
  console.log(results.join('\n'));
  console.log(`\n${results.length - failed.length}/${results.length} passed (${failed.length} failed)`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  fs.writeFileSync(STATE_FILE, backup + '\n', 'utf8');
}