#!/usr/bin/env node
/**
 * Identity-scoped lifecycle tests: several registry entries may share one
 * endpoint port — only the model the server REALLY serves may report online /
 * show Eject. Covers:
 *   - parseServedIdentity (pure /v1/models + /props parsing)
 *   - endpointServes / identityKeys matching (alias ids, absolute paths,
 *     /props basename, foreign occupants)
 *   - modelManager.listModels status mapping (online | conflict | unchanged
 *     for remotes)
 *   - modelLifecycle probe: conflict lifecycle (online:false) for foreign
 *     occupants; unloaded for dead ports
 *   - launch() 409 on foreign occupant (never spawn on a busy port),
 *     already:true for the genuinely served model
 *   - eject() 409 when the port serves a different model and the target has
 *     no active unit (never unload/stop a foreign server)
 *
 * Network seams are monkey-patched (probeStatus / probeContextLength /
 * servedIdentityFor); pure matchers stay real. Uses the REAL registry
 * (data/models-state.json) so entries match production config.
 */
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..');
const results = [];
const t = (name, cond, detail) => results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`);

const modelManager = require(path.join(ROOT, 'services', 'modelManager'));
const modelLifecycle = require(path.join(ROOT, 'services', 'modelLifecycle'));

// The eject positive path talks to the user systemd bus — set the env here so
// the test is hermetic (modelLifecycle.systemctlUser inherits process.env).
process.env.XDG_RUNTIME_DIR = process.env.XDG_RUNTIME_DIR || '/run/user/1002';
process.env.DBUS_SESSION_BUS_ADDRESS = process.env.DBUS_SESSION_BUS_ADDRESS || 'unix:path=/run/user/1002/bus';

const GEMMA = 'gemma-4-E4B-it-Q5_K_M.gguf';
const FOREIGN = 'some-other-model.gguf';

(async () => {
  // ---------------- 1. pure parsing -----------------------------------------
  let idn = modelManager.parseServedIdentity(`{"data":[{"id":"${GEMMA}"}]}`, '{}');
  t('parse: /v1/models alias id captured', idn.reachable && idn.ids[0] === GEMMA, JSON.stringify(idn.ids));

  idn = modelManager.parseServedIdentity('{"data":[]}', '{}');
  t('parse: empty /v1/models -> reachable, no ids (router with nothing loaded)', idn.reachable && idn.ids.length === 0, JSON.stringify(idn));

  idn = modelManager.parseServedIdentity('garbage', '{"model_path":"/home/hermesai/models/' + GEMMA + '"}');
  t('parse: /props model_path captured on unparseable /v1/models', idn.modelPath === '/home/hermesai/models/' + GEMMA, idn.modelPath);

  idn = modelManager.parseServedIdentity('garbage', '{"result":[{"id":"a"},{"model":"b"}]}');
  t('parse: router /props.result ids collected', idn.ids.includes('a') && idn.ids.includes('b'), JSON.stringify(idn.ids));

  // ---------------- 2. matching ---------------------------------------------
  const gemmaEntry = { id: 'gemma4-4b', model: GEMMA };
  t('match: /v1/models alias equals the gguf name (--alias <model-file>)',
    modelManager.endpointServes(gemmaEntry, { ids: [GEMMA], modelPath: null }), '');
  t('match: absolute-path alias ending with the gguf name (hand-run server)',
    modelManager.endpointServes(gemmaEntry, { ids: ['/home/hermesai/models/' + GEMMA], modelPath: null }), '');
  t('match: /props model_path basename equals the gguf name',
    modelManager.endpointServes(gemmaEntry, { ids: [], modelPath: '/mnt/models/' + GEMMA }), '');
  t('match: entry id itself as alias',
    modelManager.endpointServes(gemmaEntry, { ids: ['gemma4-4b'], modelPath: null }), '');
  t('match: foreign occupant does NOT match', !modelManager.endpointServes(gemmaEntry, { ids: [FOREIGN], modelPath: null }), '');
  t('match: unknown identity (ids empty) does NOT match', !modelManager.endpointServes(gemmaEntry, { ids: [], modelPath: null }), '');

  // ---------------- 3. listModels status mapping ----------------------------
  // NOTE: listModels binds the module-internal servedIdentityFor (closure),
  // so stubbing the export does not affect it — which turns this section into
  // a LIVE check of the exact reported bug: N registry entries share port
  // 8081; AT MOST ONE of them may be online. When the port is down, all
  // locals report unreachable/offline (also consistent).
  const realProbeStatus = modelManager.probeStatus;
  const realProbeCtx = modelManager.probeContextLength;
  const realServed = modelManager.servedIdentityFor;
  modelManager.probeStatus = realProbeStatus; // no stubbing here — live probes
  modelManager.probeContextLength = realProbeCtx;
  modelManager.servedIdentityFor = realServed;
  modelManager._identityCache.clear();

  const { models } = await modelManager.listModels();
  const byId = {};
  for (const m of models) byId[m.id] = m;
  const locals8081 = models.filter((m) => /8081/.test(m.endpoint || ''));
  const onlineOn8081 = locals8081.filter((m) => m.status === 'online');
  const liveIdn = await modelManager.servedIdentityFor('http://127.0.0.1:8081').catch(() => null);
  if (liveIdn && liveIdn.ids.length > 0) {
    t('listModels: at most ONE shared-port entry is online', onlineOn8081.length <= 1, `online: ${onlineOn8081.map((m) => m.id).join(',') || 'none'}`);
    t('listModels: the online entry is exactly the served model (serves=' + (liveIdn.ids[0] || '?') + ')',
      onlineOn8081.length === 1 && onlineOn8081.every((m) => modelManager.endpointServes({ id: m.id, model: m.model }, liveIdn)),
      JSON.stringify(onlineOn8081.map((m) => m.id)));
    for (const m of locals8081) {
      const expectOnline = modelManager.endpointServes({ id: m.id, model: m.model }, liveIdn);
      t(`listModels: ${m.id} status matches the served identity`, (m.status === 'online') === expectOnline, `${m.status} vs serves=${expectOnline}`);
    }
    const remote = Object.values(byId).find((mm) => /^https:\/\//i.test(mm.endpoint || ''));
    if (remote) {
      t('listModels: remote entry keeps its own status (never conflicted)', remote.status === 'online', `${remote.id}=${remote.status}`);
    }
  } else {
    // Port down (or identity unreadable): consistency = no false 'online'.
    t('listModels: port 8081 unreachable -> no entry claims online', onlineOn8081.length === 0, `online: ${onlineOn8081.map((m) => m.id).join(',') || 'none'}`);
  }

  // ---------------- 4. lifecycle probe --------------------------------------
  // (Section 3 restored the real probes; re-apply stubs for the guard paths.)
  modelManager.probeStatus = async () => 'online';
  modelManager.servedIdentityFor = async () => ({ reachable: true, ids: [GEMMA], modelPath: '/home/hermesai/models/' + GEMMA });

  let st = await modelLifecycle.getStatus('qwen-coder');
  t('probe: foreign occupant -> lifecycle conflict, online:false',
    st && st.lifecycle === 'conflict' && st.online === false, st && `${st.lifecycle}/${st.online}`);
  t('probe: conflict detail names the served model', st && /gemma-4-E4B/.test(st.detail), st && st.detail);

  modelManager.probeStatus = async () => 'offline';
  st = await modelLifecycle.getStatus('qwen-coder');
  t('probe: dead port -> unloaded, online:false', st && st.lifecycle === 'unloaded' && st.online === false, st && st.lifecycle);

  // ---------------- 5. load guard -------------------------------------------
  modelManager.probeStatus = async () => 'online';
  let r = await modelLifecycle.launch('qwen-coder');
  t('launch: foreign occupant -> 409 conflict (never spawn on a busy port)',
    r && r.ok === false && r.code === 409 && /already serves/.test(r.error), r && JSON.stringify(r));

  modelManager.servedIdentityFor = async () => ({ reachable: true, ids: [GEMMA], modelPath: null });
  r = await modelLifecycle.launch('gemma4-4b');
  t('launch: genuinely served model -> already:true', r && r.ok === true && r.already === true, JSON.stringify(r));

  // ---------------- 6. eject guard ------------------------------------------
  modelManager.servedIdentityFor = async () => ({ reachable: true, ids: [GEMMA], modelPath: null });
  r = await modelLifecycle.eject('qwen-2-5-1-5b-q5'); // same port as gemma, no unit file on disk
  t('eject: foreign occupant + no unit -> 409, never touches the foreign server',
    r && r.ok === false && r.code === 409 && /NOT the model/.test(r.error), r && JSON.stringify(r));

  // Busy guard: this llama.cpp build retains id_task on IDLE slots — a stale
  // id > 0 must never block eject of the active model (that bricked eject
  // permanently after the first request). is_processing is the busy signal.
  t('slotBusy: actively processing slot IS busy', modelLifecycle.slotBusy({ is_processing: true, id_task: 222 }) === true, '');
  t('slotBusy: idle slot with retained id_task is NOT busy', modelLifecycle.slotBusy({ is_processing: false, id_task: 222 }) === false, '');
  t('slotBusy: bare idle slot is NOT busy', modelLifecycle.slotBusy({ is_processing: false }) === false, '');

  // Positive path (safe): identity-matched entry whose own unit exists but is
  // INACTIVE -> eject proceeds to unit-stop, which is a no-op on an inactive
  // unit. Self-guarding: case runs only when the unit is confirmed inactive.
  const { execSync } = require('child_process');
  const unitActive = (name) => {
    try {
      return execSync(`systemctl --user is-active ${name}`, {
        env: { ...process.env, XDG_RUNTIME_DIR: '/run/user/1002', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1002/bus' },
        timeout: 5000,
      }).toString().trim() === 'active';
    } catch { return false; }
  };
  const gm = modelManager.getModel('gemma4-4b');
  if (gm && modelLifecycle.unitFilePath && !unitActive('llama-gemma4-4b.service')) {
    r = await modelLifecycle.eject('gemma4-4b');
    t('eject: own unit inactive -> proceeds to (harmless) unit stop',
      r && r.ok === true && r.stoppedUnit && /llama-gemma4-4b/.test(r.stoppedUnit), r && JSON.stringify(r));
  } else {
    t('eject: own-unit-inactive positive path (unit file present)', false, 'llama-gemma4-4b.service not on disk or ACTIVE — case skipped');
  }

  // ---------------- restore --------------------------------------------------
  modelManager.probeStatus = realProbeStatus;
  modelManager.probeContextLength = realProbeCtx;
  modelManager.servedIdentityFor = realServed;
  modelManager._identityCache.clear();

  const fails = results.filter((x) => x.startsWith('FAIL')).length;
  console.log(results.join('\n'));
  console.log(`\n${results.length - fails}/${results.length} lifecycle-identity tests passed${fails ? ` (${fails} FAILED)` : ''}`);
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});