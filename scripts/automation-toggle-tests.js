#!/usr/bin/env node
/**
 * Automation enable/disable + global pause tests (services/automationManager.js):
 *   - per-item setEnabled: disables, nulls nextRunAt, skips the checkDue tick,
 *     restores scheduling when re-enabled
 *   - global setPaused: tick returns early (ran:0, paused:true), every
 *     nextRunAt nulled, unpause restores only enabled automations
 *   - update() inherits the paused state (no nextRunAt while paused)
 *
 * Uses the REAL store (data/automations-state.json) with a backup/restore
 * wrapper (loop-guard's proven pattern) and a throwaway automation whose
 * action targets a non-existent script — the assertions only check SKIPS, so
 * nothing is ever spawned.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const results = [];
const t = (name, cond, detail) => results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`);

const manager = require(path.join(ROOT, 'services', 'automationManager'));
const STATE_FILE = manager.STATE_FILE;

const readState = () => JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
const writeState = (s) => fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));

(async () => {
  const backup = fs.readFileSync(STATE_FILE, 'utf8');
  const testId = 'toggle-test-' + process.pid;
  const buddyId = 'toggle-buddy-' + process.pid;
  try {
    // ---------------- create -------------------------------------------------
    const created = manager.create({
      id: testId,
      name: 'Toggle test',
      schedule: { type: 'interval', intervalMinutes: 1 },
      action: { type: 'script', script: 'scripts/__nope__.py' },
    });
    t('create: temp automation ok', created.ok === true && created.automation.id === testId, created.error || created.automation && created.automation.id);
    t('create: enabled by default with a next run', created.automation.enabled === true && !!created.automation.nextRunAt, JSON.stringify(created.automation.nextRunAt));

    // An unrelated enabled automation — proves the global pause reaches rules
    // beyond the one under test (never depends on live store contents).
    const buddyCreate = manager.create({
      id: buddyId,
      name: 'Toggle buddy',
      schedule: { type: 'interval', intervalMinutes: 2 },
      action: { type: 'script', script: 'scripts/__nope__.py' },
    });
    t('create: buddy automation ok', buddyCreate.ok === true, buddyCreate.error || '');

    // ---------------- per-item disable ---------------------------------------
    let r = manager.setEnabled(testId, false);
    t('setEnabled(false): persisted', r.ok === true && r.automation.enabled === false, '');
    t('setEnabled(false): nextRunAt nulled', r.automation.nextRunAt === null, JSON.stringify(r.automation.nextRunAt));
    let st = readState();
    const mine = st.automations.find((a) => a.id === testId);
    mine.nextRunAt = new Date(Date.now() - 60000).toISOString(); // force overdue
    writeState(st);
    const due1 = manager.checkDue(Date.now());
    t('checkDue: disabled overdue automation NOT executed', due1.ran === 0, JSON.stringify(due1));

    // ---------------- re-enable ----------------------------------------------
    r = manager.setEnabled(testId, true);
    t('setEnabled(true): schedule restored', r.ok === true && r.automation.enabled === true && !!r.automation.nextRunAt, JSON.stringify(r.automation.nextRunAt));

    // ---------------- global pause -------------------------------------------
    st = readState();
    st.automations.find((a) => a.id === testId).nextRunAt = new Date(Date.now() - 60000).toISOString();
    writeState(st);
    r = manager.setPaused(true);
    t('setPaused(true): ok + paused flag', r.ok === true && r.paused === true, '');
    t('isPaused(): true', manager.isPaused() === true, '');
    st = readState();
    const buddy = st.automations.find((a) => a.id === buddyId);
    t('setPaused: an enabled unrelated automation nextRunAt ALSO nulled', buddy && buddy.nextRunAt === null, JSON.stringify(buddy && buddy.nextRunAt));
    t('setPaused: universe of nextRunAt is null while paused', st.automations.every((a) => a.nextRunAt === null), '');
    const due2 = manager.checkDue(Date.now());
    t('checkDue: paused tick returns early (ran 0)', due2.paused === true && due2.ran === 0, JSON.stringify(due2));

    // ---------------- update inherits pause ----------------------------------
    r = manager.update(testId, { name: 'Toggle test v2' });
    t('update while paused: no nextRunAt', r.ok === true && r.automation.nextRunAt === null, JSON.stringify(r.automation.nextRunAt));

    // ---------------- unpause ------------------------------------------------
    r = manager.setPaused(false);
    t('setPaused(false): resumed', r.ok === true && r.paused === false && manager.isPaused() === false, '');
    st = readState();
    const mine2 = st.automations.find((a) => a.id === testId);
    const buddy2 = st.automations.find((a) => a.id === buddyId);
    t('unpause: enabled temp automation rescheduled', mine2 && !!mine2.nextRunAt, JSON.stringify(mine2 && mine2.nextRunAt));
    t('unpause: unrelated enabled automation rescheduled', buddy2 && !!buddy2.nextRunAt, JSON.stringify(buddy2 && buddy2.nextRunAt));
    t('setPaused no-op when already unpaused (unchanged flag)', manager.setPaused(false).unchanged === true, '');

    // ---------------- tool layer (tools/automationsTools) ---------------------
    const autTools = require(path.join(ROOT, 'tools', 'automationsTools'));
    const byName = (n) => autTools.tools.find((x) => x.name === n);
    t('tools: registry has set_automation_enabled + set_automations_paused',
      !!byName('set_automation_enabled') && !!byName('set_automations_paused'), '');
    const t1 = await byName('set_automation_enabled').execute({ id: testId, enabled: false });
    t('tool set_automation_enabled: disables + nulls nextRunAt',
      t1.ok === true && t1.automation.enabled === false && t1.automation.nextRunAt === null, JSON.stringify(t1.automation || t1));
    const t2 = await byName('set_automation_enabled').execute({ id: testId, enabled: true });
    t('tool set_automation_enabled: re-enables (summarized)',
      t2.ok === true && t2.automation.enabled === true && !!t2.automation.nextRunAt, '');
    const t3 = await byName('set_automations_paused').execute({ paused: true });
    t('tool set_automations_paused: scheduler paused', t3.ok === true && t3.paused === true && manager.isPaused() === true, JSON.stringify(t3));
    const t4 = await byName('set_automations_paused').execute({ paused: false });
    t('tool set_automations_paused: resumed', t4.ok === true && t4.paused === false && manager.isPaused() === false, '');

    // ---------------- cleanup -------------------------------------------------
    manager.remove(buddyId);
    const removed = manager.remove(testId);
    t('cleanup: temp automation removed', removed.ok === true && removed.deleted === true, '');
  } finally {
    fs.writeFileSync(STATE_FILE, backup); // byte-for-byte restore
  }

  const fails = results.filter((x) => x.startsWith('FAIL')).length;
  console.log(results.join('\n'));
  console.log(`\n${results.length - fails}/${results.length} automation-toggle tests passed${fails ? ` (${fails} FAILED)` : ''}`);
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});