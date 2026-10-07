/**
 * Tool registry — the single source of truth for every tool the agent can
 * call. The tool-loop service and any future tool-calling logic consume this.
 *
 * The registry is sorted by name at load time so the OpenAI `tools` array is
 * byte-for-byte deterministic across requests (stable prefix for llama.cpp's
 * prompt cache) — no per-request ordering, no random order.
 */
const fileTools = require('./fileTools');
const shellTools = require('./shellTools');
const skillsTools = require('./skillsTools');
const automationsTools = require('./automationsTools');
const libraryTools = require('./libraryTools');

const registry = [
  ...fileTools.tools,
  ...shellTools.tools,
  ...skillsTools.tools,
  ...automationsTools.tools,
  ...libraryTools.tools,
].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

module.exports = registry;