#!/usr/bin/env node
/**
 * scripts/measure-prompts.js — build the current prompt exactly as the code
 * does and dump it for tokenization (scripts/tokenize-prompt.py).
 * Dumps the static system prompt plus the `tools` payload array (FULL set —
 * every request sends all tools in name-sorted order by default) using the
 * compact JSON the /v1/chat/completions payload actually contains, plus the
 * prefix hash that llamaClient logs as `prefix=<hash>`.
 *
 * Usage: node scripts/measure-prompts.js /tmp/new-prompt.json
 */
const fs = require('fs');
const crypto = require('crypto');
const toolLoop = require('../services/toolLoop');
const config = require('../config');

const outPath = process.argv[2] || '/tmp/new-prompt.json';

const systemText = toolLoop.buildSystemPrompt(config.llamaSystemPrompt);
const tools = toolLoop.toOpenAITools(); // the FULL set, always (default mode)
const toolsJson = JSON.stringify(tools); // compact — exactly what the payload sends
const prefixHash = crypto
  .createHash('sha256')
  .update(systemText + '\u0000' + toolsJson)
  .digest('hex')
  .slice(0, 12);

const out = {
  systemText,
  systemChars: systemText.length,
  toolsJson,
  toolsCount: tools.length,
  toolsNames: tools.map((t) => t.function.name),
  prefixHash,
  sampleUserMessage: 'Hi',
  createdAt: new Date().toISOString(),
};
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`wrote ${outPath}`);
console.log(`system chars: ${out.systemChars}`);
console.log(`tools (${out.toolsCount}): ${out.toolsNames.join(', ')}`);
console.log(`prefix tools json chars: ${toolsJson.length}`);
console.log(`prefix hash: ${prefixHash}`);