/**
 * Automations tools — let the dashboard agent CREATE, LIST, RUN and DELETE
 * automations itself through the built-in Automations engine, instead of
 * explaining curl commands for the user to run by hand.
 *
 * These call services/automationManager directly: the /api/automations routes
 * are thin wrappers over the same manager, so behavior is identical without a
 * self-HTTP round trip. Register in tools/index.js for the agent to see them.
 */
const manager = require('../services/automationManager');

// Compact, model-friendly summary (logs stripped to keep the tool loop's
// context small — the full record is available via the API/UI).
function summarize(a) {
  const action = { type: a.action && a.action.type };
  if (action.type === 'script') action.script = a.action.script;
  else if (action.type === 'skill') action.skill = a.action.skill;
  return {
    id: a.id,
    name: a.name,
    enabled: a.enabled !== false,
    schedule: a.schedule,
    action,
    nextRunAt: a.nextRunAt || null,
    lastStatus: a.lastStatus || null,
  };
}

const createAutomation = {
  name: 'create_automation',
  description:
    'Create a scheduled automation in the dashboard Automations engine (NOT Unix cron). ' +
    'Call this tool whenever the user asks to create an automation, schedule a recurring task, ' +
    'or run something periodically — you perform the creation yourself; never just explain how. ' +
    'Action types: "script" (workspace-relative .js file), "skill" (existing dashboard skill name), ' +
    'or "prompt" (text run by the local LLM). Schedule: "interval" with interval_minutes ' +
    '(every N minutes, wall-clock aligned) or "cron" with a 5-field expression ' +
    '(minute hour dom month dow; also @daily/@hourly/@weekly/@monthly/@yearly). ' +
    'After creating, confirm with list_automations. ' +
    'IMPORTANT — pass ALL required fields in one call: name, schedule_type, ' +
    'interval_minutes (when interval) or cron (when cron), action_type, and the ' +
    'matching action field (script/skill/prompt); a partial call fails validation. ' +
    'Example: schedule_type="interval", interval_minutes=30, action_type="script", ' +
    'script="scripts/backup.js" creates a backup script run every 30 minutes.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Human-readable name (required)' },
      description: { type: 'string', description: 'Optional description' },
      schedule_type: {
        type: 'string',
        enum: ['interval', 'cron'],
        description: 'interval = every N minutes; cron = 5-field expression (required)',
      },
      interval_minutes: { type: 'number', description: 'Minutes between runs when schedule_type=interval (positive integer)' },
      cron: { type: 'string', description: '5-field cron or @alias when schedule_type=cron' },
      action_type: {
        type: 'string',
        enum: ['script', 'skill', 'prompt'],
        description: 'What runs when the automation fires (required)',
      },
      script: { type: 'string', description: 'Required for script actions: workspace-relative path to a .js file' },
      skill: { type: 'string', description: 'Required for skill actions: name of an existing dashboard skill' },
      prompt: { type: 'string', description: 'Required for prompt actions: text to send to the local LLM' },
      args: { type: 'array', items: { type: 'string' }, description: 'Optional string arguments for script/skill actions (max 20)' },
    },
    required: ['name', 'schedule_type', 'action_type'],
  },
  execute(args) {
    const a = args || {};
    try {
      const body = {
        name: a.name,
        description: a.description,
        schedule:
          a.schedule_type === 'cron'
            ? { type: 'cron', cron: a.cron }
            : { type: 'interval', intervalMinutes: a.interval_minutes },
        action: {
          type: a.action_type,
          script: a.script,
          skill: a.skill,
          prompt: a.prompt,
          args: Array.isArray(a.args) ? a.args : [],
        },
      };
      const r = manager.create(body);
      if (!r.ok) {
        return { ok: false, error: (r.errors || ['validation failed']).join('; ') };
      }
      return {
        ok: true,
        message: `Automation "${r.automation.name}" created (id: ${r.automation.id})`,
        automation: summarize(r.automation),
      };
    } catch (e) {
      return { ok: false, error: `create_automation failed: ${String((e && e.message) || e)}` };
    }
  },
};

const listAutomations = {
  name: 'list_automations',
  description:
    'List existing scheduled automations (id, name, schedule, action, enabled, next run). ' +
    'Call this after creating an automation to confirm it registered, or when the user asks ' +
    'what automations exist or wants to manage/remove one.',
  parameters: {
    type: 'object',
    properties: {
      name_filter: { type: 'string', description: 'Optional case-insensitive substring to filter by name' },
    },
    required: [],
  },
  execute(args) {
    try {
      const filter = (args && args.name_filter) ? String(args.name_filter).toLowerCase() : '';
      const all = manager
        .list()
        .filter((a) => !filter || String(a.name).toLowerCase().includes(filter))
        .map(summarize);
      return { ok: true, count: all.length, automations: all };
    } catch (e) {
      return { ok: false, error: `list_automations failed: ${String((e && e.message) || e)}` };
    }
  },
};

const runAutomation = {
  name: 'run_automation',
  description:
    'Manually trigger an existing automation by id right now (runs in the background; works even while paused). ' +
    'The outcome lands in the automation log. Use with ids from list_automations.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Automation id to trigger' },
    },
    required: ['id'],
  },
  async execute(args) {
    const id = args && args.id;
    if (!id || typeof id !== 'string') return { ok: false, error: 'id is required' };
    try {
      const r = await manager.runNow(id);
      return r.ok
        ? { ok: true, message: `Automation "${id}" triggered — running in the background` }
        : { ok: false, error: r.error || 'could not trigger automation' };
    } catch (e) {
      return { ok: false, error: `run_automation failed: ${String((e && e.message) || e)}` };
    }
  },
};

const deleteAutomation = {
  name: 'delete_automation',
  description:
    'Delete an existing automation by id (e.g. when the user asks to remove/cancel one). ' +
    'Use ids from list_automations. Confirm the user asked for deletion before calling.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Automation id to delete' },
    },
    required: ['id'],
  },
  execute(args) {
    const id = args && args.id;
    if (!id || typeof id !== 'string') return { ok: false, error: 'id is required' };
    try {
      const r = manager.remove(id);
      return r.deleted
        ? { ok: true, message: `Automation "${id}" deleted` }
        : { ok: false, error: r.error || `automation not found: ${id}` };
    } catch (e) {
      return { ok: false, error: `delete_automation failed: ${String((e && e.message) || e)}` };
    }
  },
};

module.exports = { tools: [createAutomation, listAutomations, runAutomation, deleteAutomation] };