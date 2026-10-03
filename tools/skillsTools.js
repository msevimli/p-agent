/**
 * Agent-facing skill tools (list_skills / run_skill / write_skill / delete_skill).
 *
 * Wrapping them as plain tools means the existing agentic loop and system prompt
 * automatically advertise them and can call them — no special-casing in
 * routes/chat.js. This is how the model becomes skill-aware: it can discover,
 * execute, and author skills in the workspace skills/ directory.
 */
const skillManager = require('../services/skillManager');

const listSkillsTool = {
  name: 'list_skills',
  description:
    'List all installed skills in the workspace skills/ directory, including each one\u2019s description and whether it is enabled. Call this to discover available capabilities before running a skill.',
  parameters: { type: 'object', properties: {} },
  execute() {
    const skills = skillManager
      .listSkills()
      .map(({ name, description, enabled, version, entry }) => ({ name, description, enabled, version, entry }));
    return { ok: true, count: skills.length, skills };
  },
};

const runSkillTool = {
  name: 'run_skill',
  description:
    'Execute an installed skill by name. Skills are Node.js scripts in the workspace skills/ directory; pass command-line style string arguments via "args". Returns the script\u2019s stdout/stderr and exit code.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The skill name to execute' },
      args: { type: 'array', items: { type: 'string' }, description: 'Positional string arguments for the script' },
    },
    required: ['name'],
  },
  execute: async (args) => skillManager.runSkill(args && args.name, (args && args.args) || []),
};

const writeSkillTool = {
  name: 'write_skill',
  description:
    'Create or update a skill in the workspace skills/ directory. Generates a standard SKILL.md (YAML frontmatter with name/version/description/entry plus a Markdown instructions body) and any executable files. Provide a unique "name", a "description", and a "files" object mapping filenames to content (e.g. { "run.js": "<code>" }); run.js becomes the entry point by default and is executed with run_skill. Optional "instructions" becomes the SKILL.md body.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Skill name (letters, digits, dots, dashes, underscores)' },
      description: { type: 'string', description: 'Short summary stored in SKILL.md frontmatter' },
      version: { type: 'string', description: 'Semantic version (optional)' },
      entry: { type: 'string', description: 'Entry script filename (default run.js)' },
      instructions: { type: 'string', description: 'Markdown instructions/details written as the SKILL.md body (optional)' },
      files: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'Filename → file content map; must be flat filenames inside the skill folder (SKILL.md is managed automatically)',
      },
    },
    required: ['name', 'description'],
  },
  execute: (args) => {
    const r = skillManager.writeSkill(args || {});
    return r.ok
      ? { ok: true, message: `Skill "${r.skill.name}" saved`, skill: r.skill }
      : r;
  },
};

const deleteSkillTool = {
  name: 'delete_skill',
  description: 'Permanently delete an installed workspace skill by name.',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string', description: 'The skill name to delete' } },
    required: ['name'],
  },
  execute: (args) => skillManager.deleteSkill(args && args.name),
};

module.exports = { tools: [listSkillsTool, runSkillTool, writeSkillTool, deleteSkillTool] };
