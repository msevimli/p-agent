#!/usr/bin/env node
/**
 * token-estimate skill
 * Usage: node run.js "some text to measure"
 * Prints JSON { length, estimated_tokens }. Estimates ~4 chars per token.
 */
const input = process.argv.slice(2).join(' ');
if (!input) {
  console.log('Usage: token-estimate "text to measure"');
  process.exit(0);
}
const estimated = Math.max(1, Math.ceil(input.length / 4));
console.log(JSON.stringify({ text_length: input.length, estimated_tokens: estimated }));
