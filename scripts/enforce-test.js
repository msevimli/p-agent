/** Unit tests for the automation-tool enforcement helpers. */
const path = require('path');
const tl = require(path.join(__dirname, '..', 'services', 'toolLoop'));
const results = [];
const t = (name, cond, detail) => results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`);

// --- intent detection -----------------------------------------------------
t('intent: imperative create', tl.isAutomationCreationRequest('Create an automation that runs every 30 minutes.'));
t('intent: set up recurring', tl.isAutomationCreationRequest('Set up a recurring task to run hourly'));
t('intent: schedule + cron', tl.isAutomationCreationRequest('schedule a cron job for backups'));
t('intent: make + every N', tl.isAutomationCreationRequest('make something run every 5 minutes'));
t('intent: run X every N', tl.isAutomationCreationRequest('run the greetings skill every 2 hours'));
t('intent: can you create', tl.isAutomationCreationRequest('Can you create an automation that backs up daily?'));
t('intent-neg: how do i', !tl.isAutomationCreationRequest('How do I create an automation?'));
t('intent-neg: explain how', !tl.isAutomationCreationRequest('Explain how to schedule a task, please'));
t('intent-neg: unrelated', !tl.isAutomationCreationRequest('What is the weather like?'));

// --- findAutomationPayload ------------------------------------------------
const fenced = 'Here is the JSON body you would POST:\n```json\n{"name":"backup job","schedule":{"type":"interval","intervalMinutes":30},"action":{"type":"script","script":"scripts/backup.js"}}\n```\nHope that helps!';
const bare = 'You can create it by calling the API with {"name":"cleanup","cron":"0 9 * * *","actionType":"skill","skill":"scrape"} in the request body.';
const terse = 'just POST {"name":"x","schedule":{"type":"interval","intervalMinutes":1440},"action":{"type":"prompt","prompt":"refresh feed"}}';
const negative = 'You can open the Automations panel in the sidebar and click Add Automation.';
const incomplete = 'The payload needs a schedule and action, e.g. {"name":"job"}.';

let p = tl.findAutomationPayload(fenced);
t('payload: fenced body', !!p && p.name === 'backup job' && p.schedule_type === 'interval' && p.interval_minutes === 30 && p.script === 'scripts/backup.js', JSON.stringify(p));
p = tl.findAutomationPayload(bare);
t('payload: bare flattened', !!p && p.cron === '0 9 * * *' && p.action_type === 'skill' && p.skill === 'scrape', JSON.stringify(p));
p = tl.findAutomationPayload(terse);
t('payload: prompt action', !!p && p.action_type === 'prompt' && p.interval_minutes === 1440, JSON.stringify(p));
t('payload-neg: pure prose', tl.findAutomationPayload(negative) === null);
t('payload-neg: incomplete json', tl.findAutomationPayload(incomplete) === null);

// --- inferAutomationFromUser ----------------------------------------------
let i = tl.inferAutomationFromUser('Create an automation that runs scripts/backup.js every 30 minutes');
t('infer: interval+script', !!i && i.interval_minutes === 30 && i.script === 'scripts/backup.js' && i.action_type === 'script', JSON.stringify(i));
i = tl.inferAutomationFromUser('schedule a task at 9am daily to run scripts/backup.js');
t('infer: at 9am daily + script', !!i && i.schedule_type === 'cron' && i.cron === '0 9 * * *' && i.script === 'scripts/backup.js', JSON.stringify(i));
i = tl.inferAutomationFromUser('set up an hourly cleanup');
t('infer: hourly only (no action)', i === null, String(i));
i = tl.inferAutomationFromUser('run the greetings skill every 2 hours');
t('infer: every 2 hours + skill', !!i && i.interval_minutes === 120 && i.action_type === 'skill' && i.skill === 'greetings', JSON.stringify(i));
i = tl.inferAutomationFromUser('write me a poem');
t('infer-neg: no schedule/action', i === null);

console.log(results.join('\n'));
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);