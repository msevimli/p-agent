/**
 * Tool registry — the single source of truth for every tool the agent can
 * call. The tool-loop service and any future tool-calling logic consume this.
 */
const fileTools = require('./fileTools');
const shellTools = require('./shellTools');
const skillsTools = require('./skillsTools');
const automationsTools = require('./automationsTools');

const registry = [
  ...fileTools.tools,
  ...shellTools.tools,
  ...skillsTools.tools,
  ...automationsTools.tools,
];

module.exports = registry;