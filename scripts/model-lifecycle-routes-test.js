/**
 * Model lifecycle routes — wiring test for POST /api/models/:id/load and
 * POST /api/models/:id/eject (thin aliases over modelLifecycle.launch/eject).
 *
 * The lifecycle services themselves are NOT exercised here (they manage real
 * systemd units); modelLifecycle.launch/eject are stubbed to record calls and
 * return canned responses, and the test asserts the routes dispatch to the
 * right service with the right id, propagate {ok:false, code} as HTTP status,
 * and reject unknown ids. Mounts the REAL router on an ephemeral port.
 */
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const express = require(path.join(ROOT, 'node_modules', 'express'));

const called = [];
const ml = require(path.join(ROOT, 'services', 'modelLifecycle'));
const origLaunch = ml.launch;
const origEject = ml.eject;
ml.launch = async (id) => {
  called.push(['launch', id]);
  if (id === 'missing') return { ok: false, code: 404, error: `model not found: ${id}` };
  if (id === 'cloud-model') return { ok: false, code: 400, error: 'Load applies to local llama.cpp endpoints only.' };
  return { ok: true, started: true, id, unit: `llama-${id}.service`, detail: `llama-${id}.service started — server online` };
};
ml.eject = async (id) => {
  called.push(['eject', id]);
  if (id === 'missing') return { ok: false, code: 404, error: `model not found: ${id}` };
  if (id === 'cloud-model') return { ok: false, code: 400, error: 'Eject applies to local llama.cpp endpoints only.' };
  return { ok: true, ejected: true, id, detail: 'weights unloaded' };
};

const routes = require(path.join(ROOT, 'routes', 'models.js'));

const results = [];
const t = (name, pass, info) => {
  results.push(`${pass ? 'PASS' : 'FAIL'} ${name}${info ? ' | ' + String(info) : ''}`);
};

const URL = 'http://127.0.0.1:0';

(async () => {
  const app = express();
  app.use('/api/models', routes);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/models`;

  try {
    let res = await fetch(`${base}/qwen-coder/load`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    let data = await res.json();
    t('load: dispatches to modelLifecycle.launch with the model id', res.status === 200 && data.ok === true && data.unit === 'llama-qwen-coder.service', JSON.stringify(data));

    res = await fetch(`${base}/gemma4-4b/eject`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    data = await res.json();
    t('eject: dispatches to modelLifecycle.eject with the model id', res.status === 200 && data.ok === true && data.ejected === true, JSON.stringify(data));

    res = await fetch(`${base}/missing/load`, { method: 'POST' });
    data = await res.json();
    t('load: unknown model -> 404 with the service error', res.status === 404 && data.ok === false && /not found/.test(data.error || ''), `${res.status} ${JSON.stringify(data)}`);

    res = await fetch(`${base}/cloud-model/eject`, { method: 'POST' });
    data = await res.json();
    t('eject: remote model -> 400 with the local-only error', res.status === 400 && data.ok === false && /local llama.cpp/.test(data.error || ''), `${res.status} ${JSON.stringify(data)}`);

    res = await fetch(`${base}/qwen-coder/eject`, { method: 'POST' });
    data = await res.json();
    t('load/eject: distinct endpoints both work on the same model', res.status === 200 && data.ok === true, JSON.stringify(data));

    const seq = called.map(([op, id]) => `${op}:${id}`).join(',');
    t(
      'service call log matches the request order',
      seq === 'launch:qwen-coder,eject:gemma4-4b,launch:missing,eject:cloud-model,eject:qwen-coder',
      seq
    );
  } catch (e) {
    results.push('FAIL harness crashed: ' + ((e && e.stack) || e));
  } finally {
    server.close();
    ml.launch = origLaunch;
    ml.eject = origEject;
  }

  console.log(results.join('\n'));
  const failed = results.filter((r) => r.startsWith('FAIL'));
  if (failed.length) {
    console.log(`\n${failed.length} FAILED`);
    process.exitCode = 1;
  } else {
    console.log(`\nALL ${results.length} PASSED`);
  }
})();