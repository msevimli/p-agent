#!/usr/bin/env node
/**
 * random-pick skill
 * Usage: node run.js optionA optionB optionC ...
 * Prints JSON { picked, from } choosing uniformly at random.
 */
const items = process.argv.slice(2);
if (!items.length) {
  console.log('Usage: random-pick a b c ...');
  process.exit(0);
}
const picked = items[Math.floor(Math.random() * items.length)];
console.log(JSON.stringify({ picked, from: items }));
