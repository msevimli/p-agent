#!/usr/bin/env node
/**
 * Regression tests for launch templates (services/templateStore.js,
 * modelLifecycle.buildUnitFile, modelManager templateId wiring):
 *
 *  1. First-run seeding: exactly one built-in "default" template with the
 *     standard performance flags (22 tokens, incl. the <model-file>
 *     placeholder).
 *  2. Built-in protections: delete rejected, name locked, args editable.
 *  3. Template CRUD: create/get/update/delete, duplicate + unknown ids.
 *  4. Validation: empty args rejected; -m/--host/--port (derived flags)
 *     rejected; oversize arg lists rejected.
 *  5. resolve(): model template id, '' and unknown ids all resolve (fallback
 *     to built-in) — a deleted template never blocks a launch.
 *  6. buildUnitFile(): unit renders the template flags with <model-file>
 *     substituted, the entry-derived -m/--host/--port appended, and systemd
 *     quoting for tokens with spaces.
 *  7. modelManager: create/update accept an existing templateId, reject an
 *     unknown one; public model carries templateId.
 *
 * Backs up + restores data/templates-state.json AND data/models-state.json
 * (same pattern as model-role-tests.js) — safe against a live server.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TPL_FILE = path.join(ROOT, 'data', 'templates-state.json');
const MOD_FILE = path.join(ROOT, 'data', 'models-state.json');
const tplBackup = (() => { try { return fs.readFileSync(TPL_FILE, 'utf8'); } catch { return null; } })();
const modBackup = (() => { try { return fs.readFileSync(MOD_FILE, 'utf8'); } catch { return null; } })();

const results = [];
const t = (name, cond, detail) =>
  results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`);

const templateStore = require('../services/templateStore');
const modelLifecycle = require('../services/modelLifecycle');
const modelManager = require('../services/modelManager');

try {
  // ---------------------------------------------------------------- 1. seed
  let list = templateStore.list();
  // User-created templates may exist in the store (models panel); the seed
  // contract is about BUILT-INS, not the total count.
  const builtins = list.filter((t) => t.builtin === true);
  t('seeded with exactly one built-in template', builtins.length === 1 && builtins[0].builtin === true, `${builtins.length} built-in(s) of ${list.length}`);
  const def = builtins[0];
  t('built-in id/name', def.id === 'default' && def.name === 'Default');
  t('built-in flag count', Array.isArray(def.args) && def.args.length === 23, `${def.args && def.args.length} tokens`);
  t('built-in has <model-file> placeholder', def.args.includes('--alias') && def.args.includes('<model-file>'));
  t('built-in carries the required flags', ['-fa', '1', '--jinja', '-c', '16384', '-np', '1', '-b', '512', '-ub', '512', '-t', '6', '-tb', '2', '--cache-type-k', 'f16', '--cache-type-v', 'f16', '--cache-reuse', '256'].every((x, i) => !i || def.args.includes(x)));

  // ------------------------------------------------------- 2. built-in rules
  let r = templateStore.remove('default');
  t('built-in delete rejected', r.ok === false && /cannot be deleted/.test(r.error), r.error);
  r = templateStore.update('default', { name: 'Renamed' });
  t('built-in name locked', r.ok === false && /name is locked/.test(r.error), r.error);
  r = templateStore.update('default', { args: ['--jinja', '-c', '8192'] });
  t('built-in args editable', r.ok === true && r.template.args.length === 3, r.error || '');
  r = templateStore.update('default', { args: def.args }); // restore flags
  t('built-in args restored', r.ok === true && r.template.args.length === 23, r.error || '');

  // -------------------------------------------------------------- 3. CRUD
  r = templateStore.create({ name: 'Tiny ctx', description: 'small window', args: ['-c', '4096', '--jinja'] });
  t('custom template created', r.ok === true, r.error || '');
  const tid = r.template.id;
  t('custom id slugged from name', tid === 'tiny-ctx', tid);
  r = templateStore.create({ name: 'Tiny ctx', args: ['-c', '4096'] });
  t('duplicate id rejected', r.ok === false && /already exists/.test(r.error));
  r = templateStore.get(tid);
  t('get returns custom template', r && r.id === tid && r.args.length === 3);
  r = templateStore.update(tid, { args: ['-c', '2048'] });
  t('custom update ok', r.ok === true && r.template.args[1] === '2048');
  r = templateStore.update('no-such-tpl', { args: ['--jinja'] });
  t('update unknown id rejected', r.ok === false && /not found/.test(r.error));
  r = templateStore.remove('no-such-tpl');
  t('delete unknown id reported', r.ok === true && r.deleted === false);
  r = templateStore.remove(tid);
  t('custom delete ok', r.ok === true && r.deleted === true);
  t('custom gone after delete', templateStore.get(tid) === null);

  // ---------------------------------------------------------- 4. validation
  r = templateStore.create({ name: 'Empty', args: [] });
  t('empty args rejected', r.ok === false && /at least one/.test(r.errors.join(';')), r.errors && r.errors.join(';'));
  for (const bad of ['-m', '--port', '--host', '--model=foo', '-port 8081']) {
    r = templateStore.create({ name: 'Bad ' + bad, args: [bad, 'x'] });
    t(`derived flag ${bad} rejected`, r.ok === false && /not allowed/.test(r.errors.join(';')), r.errors && r.errors.join(';'));
  }
  const many = [];
  for (let i = 0; i < 100; i++) many.push('-t', '2');
  r = templateStore.create({ name: 'Huge', args: many });
  t('oversize flag list rejected', r.ok === false && /too many flags/.test(r.errors.join(';')));
  r = templateStore.create({ name: 'From string', args: '--jinja  -c 4096' });
  t('string args tokenized', r.ok === true && r.template.args.length === 3);

  // ------------------------------------------------------------ 5. resolve
  const custom = templateStore.create({ name: 'Cust', args: ['--jinja'] }).template;
  t('resolve by id', templateStore.resolve(custom.id).id === custom.id);
  t('resolve "" falls back to built-in', templateStore.resolve('').id === 'default');
  t('resolve unknown id falls back to built-in', templateStore.resolve('ghost').id === 'default');
  templateStore.remove(custom.id);

  // -------------------------------------------------------- 6. unit builder
  const model = {
    id: 'tpl-test', name: 'Template Test',
    endpoint: 'http://127.0.0.1:8090',
    model: 'qwen2.5-coder-1.5b-instruct-q5_k_m.gguf',
    templateId: '',
  };
  const unit = modelLifecycle.buildUnitFile(model, templateStore.resolve(''));
  t('unit has absolute llama-server bin', unit.includes('/llama.cpp/build/bin/llama-server'), unit.split('\n').find((l) => l.startsWith('ExecStart=')).slice(0, 80));
  t('unit applies template -c 16384', unit.includes('-c 16384'));
  t('unit applies template -fa 1 --jinja', unit.includes('-fa 1 --jinja'));
  t('unit substitutes <model-file> into --alias', unit.includes(`--alias qwen2.5-coder-1.5b-instruct-q5_k_m.gguf`));
  t('unit derives -m from the model', unit.includes('-m /home/hermesai/models/qwen2.5-coder-1.5b-instruct-q5_k_m.gguf'));
  t('unit renders fixed --host 0.0.0.0 bind + --port from endpoint', unit.includes('--host 0.0.0.0') && unit.includes('--port 8090'));
  t('unit is a valid systemd skeleton', unit.includes('[Unit]') && unit.includes('[Service]') && unit.includes('Type=simple') && unit.includes('[Install]'));
  const quoted = modelLifecycle.buildUnitFile({ id: 'q', name: 'n', endpoint: 'http://127.0.0.1:1', model: 'my file.gguf' }, { name: 'T', args: ['--alias', 'my alias'] });
  t('systemd quoting for tokens with spaces', quoted.includes('my file.gguf"') && quoted.includes('"my alias"'));

  // ---------------------------------------------- 7. modelManager wiring
  const stateFile = modelManager.STATE_FILE;
  const beforeModels = fs.readFileSync(stateFile, 'utf8');
  try {
    const a = modelManager.createModel({
      id: `tplm-${Date.now()}`, name: 'TPL M', endpoint: 'http://127.0.0.1:8099',
      model: 'x.gguf', contextLength: 4096, templateId: 'default',
    });
    t('model create with existing templateId ok', a.ok === true && a.model.templateId === 'default');
    const m2 = modelManager.createModel({
      id: `tplm2-${Date.now()}`, name: 'TPL M2', endpoint: 'http://127.0.0.1:8098',
      model: 'x.gguf', contextLength: 4096, templateId: 'no-such-template',
    });
    t('model create with unknown templateId rejected', m2.ok === false && /template not found/.test((m2.errors || []).join(';')), (m2.errors || []).join(';'));
    const up = modelManager.updateModel(a.model.id, { name: 'TPL M renamed' });
    t('partial update keeps templateId', up.ok === true && up.model.templateId === 'default');
    const got = modelManager.getModel(a.model.id);
    t('public model exposes templateId', got.templateId === 'default');
    modelManager.deleteModel(a.model.id);
  } finally {
    fs.writeFileSync(stateFile, beforeModels, 'utf8');
  }

  const failed = results.filter((l) => l.startsWith('FAIL'));
  console.log(results.join('\n'));
  console.log(`\n${results.length - failed.length}/${results.length} passed (${failed.length} failed)`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  if (tplBackup !== null) fs.writeFileSync(TPL_FILE, tplBackup, 'utf8');
  else { try { fs.unlinkSync(TPL_FILE); } catch { /* absent */ } }
  if (modBackup !== null) fs.writeFileSync(MOD_FILE, modBackup, 'utf8');
  else { try { fs.unlinkSync(MOD_FILE); } catch { /* absent */ } }
}