/**
 * Agent-facing skill tools (list_skills / run_skill / write_skill / delete_skill).
 *
 * Wrapping them as plain tools means the existing agentic loop and system prompt
 * automatically advertise them and can call them — no special-casing in
 * routes/chat.js. This is how the model becomes skill-aware: it can discover,
 * execute, and author skills in the workspace skills/ directory.
 */
const skillManager = require('../services/skillManager');

// Chat mentions may carry a leading slash ("/print_datetime" — the picker's
// old insert form or the user typing one manually). Strip it at the tool
// boundary so the ledger, logs and the manager all see the on-disk slug
// (skillManager also normalizes internally — belt and braces).
const cleanSkillName = (n) => (typeof n === 'string' ? n.replace(/^\/+/, '') : n);

const listSkillsTool = {
  name: 'list_skills',
  description:
    'List installed skills (name, description, enabled). Call this to discover available capabilities before running a skill.',
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
    'Run an installed skill by name with optional string args (Node.js script in workspace skills/). Returns stdout/stderr and exit code.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Skill name to execute' },
      args: { type: 'array', items: { type: 'string' }, description: 'Positional string arguments' },
    },
    required: ['name'],
  },
  execute: async (args) =>
    skillManager.runSkill(cleanSkillName(args && args.name), (args && args.args) || []),
};

const writeSkillTool = {
  name: 'write_skill',
  description:
    'Create or update a skill: name + description + files map {"run.js": "<code>"} (run.js is the default entry). Optional instructions become the SKILL.md body. JSON RULE: escape every internal double quote inside the content strings as \\" — e.g. data["solana"] becomes data[\\"solana\\"]; for large or quote-heavy code prefer ONE write_file call per script file instead of nesting many files in this map.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Skill name (letters, digits, dots, dashes, underscores)' },
      description: { type: 'string', description: 'Short summary stored in SKILL.md frontmatter' },
      version: { type: 'string', description: 'Semantic version (optional)' },
      entry: { type: 'string', description: 'Entry script filename (default run.js)' },
      instructions: { type: 'string', description: 'Markdown instructions written as the SKILL.md body (optional)' },
      files: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'Filename to content map (flat filenames; SKILL.md is managed automatically)',
      },
    },
    required: ['name', 'description'],
  },
  execute: (args) => {
    const clean = { ...(args || {}), name: cleanSkillName(args && args.name) };
    const r = skillManager.writeSkill(clean);
    return r.ok
      ? { ok: true, message: `Skill "${r.skill.name}" saved`, skill: r.skill }
      : r;
  },
};

const deleteSkillTool = {
  name: 'delete_skill',
  description:
    'Permanently delete an installed user skill by name (removes its folder from the workspace skills/ directory). ' +
    'User skills are not built-in tools and may be deleted on request; fails cleanly for invalid or missing skills.',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string', description: 'Skill name to delete' } },
    required: ['name'],
  },
  execute: (args) => skillManager.deleteSkill(cleanSkillName(args && args.name)),
};

module.exports = { tools: [listSkillsTool, runSkillTool, writeSkillTool, deleteSkillTool] };
