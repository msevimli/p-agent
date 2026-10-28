'use strict';
/**
 * Workspace consolidation migration (2026-10-28).
 *
 * Physically relocates the stray agent directories from the project root
 * into the agent workspace (workspaces/):
 *   - <root>/scripts/*  -> workspaces/scripts/   (repo test scripts are
 *     moved via `git mv` — do that from git BEFORE running this script;
 *     this script moves whatever is left: user/agent runtime scripts)
 *   - <root>/skills/*   -> workspaces/skills/    (agent-managed skills +
 *     the user's trading-dashboard app — restart it from the new cwd)
 *
 * IDEMPOTENT: a file already present at the destination is skipped.
 * Never deletes anything — only moves.
 *
 * Run from the project root:  node workspaces/scripts/migrate-workspace.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..'); // p-agent root
const WS = path.join(ROOT, 'workspaces');
const REPORT = [];

function move(file) {
  const from = path.join(ROOT, file);
  const to = path.join(WS, file);
  if (!fs.existsSync(from)) { REPORT.push(`skip ${file} (not present)`); return; }
  if (fs.existsSync(to)) { REPORT.push(`skip ${file} (already at destination)`); return; }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
  REPORT.push(`moved ${file} -> workspaces/${file}`);
}

function moveDir(dir) {
  const from = path.join(ROOT, dir);
  const to = path.join(WS, dir);
  if (!fs.existsSync(from)) { REPORT.push(`skip ${dir}/ (not present)`); return; }
  if (fs.existsSync(to)) { REPORT.push(`skip ${dir}/ (already at destination)`); return; }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
  REPORT.push(`moved ${dir}/ -> workspaces/${dir}/`);
}

fs.mkdirSync(path.join(WS, 'scripts'), { recursive: true });

// 1) whatever TRACKED test scripts remain (if this script runs before the
//    git mv, they stay — the script never moves tracked files by itself)
moveDir('skills');
for (const f of fs.readdirSync(path.join(ROOT, 'scripts'))) {
  if (f === 'migrate-workspace.js') continue; // this very script (git-moved separately)
  move(path.join('scripts', f));
}

console.log(REPORT.join('\n'));
console.log(`\n${REPORT.length} items processed — root scripts/ + skills/ should now be empty/missing.`);