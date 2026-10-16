/**
 * Shell command execution tool with safety checks.
 *
 * - Runs in the sandbox (config.workRoot) by default, never as a root shell.
 * - Enforces a hard timeout and bounded output so runaway commands can't hang.
 * - Blocks a denylist of destructive/system-fatal commands (shutdown, mkfs,
 *   raw-disk writes, fork bombs, etc.).
 *
 * Like file tools, this exposes a uniform { name, description, parameters,
 * execute } registration object.
 */
const { exec } = require('child_process');
const path = require('path');
const config = require('../config');

const ROOT = path.resolve(config.workRoot);

// Destructive / system-fatal command fragments (case-insensitive substring
// scan). Add policy as needed; this is a safety net, not a permission system.
const DENIED_FRAGMENTS = [
  'shutdown', 'reboot', 'poweroff', 'halt',
  'init 0', 'init 6',
  'mkfs', 'fdisk', 'parted', 'dd if=',
  ':(){', 'fork(); fork', '> /dev/sda', '> /dev/sdb', '> /dev/sdc',
  'rm -rf /', 'sudo rm -rf',
];

const DEFAULT_TIMEOUT_MS = 60 * 1000;
const MAX_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_BUFFER = 10 * 1024 * 1024;

function execute(command, timeout) {
  const cmd = typeof command === 'string' ? command.trim() : '';
  if (!cmd) return Promise.resolve({ ok: false, error: 'empty command' });

  const lower = cmd.toLowerCase();
  for (const bad of DENIED_FRAGMENTS) {
    if (lower.includes(bad)) {
      return Promise.resolve({
        ok: false,
        error: `command blocked by safety policy (matches "${bad}")`,
      });
    }
  }

  // Anti-spam: `chmod +x` on a .py file is never needed — the python3 script
  // runner does not require the executable bit. The models kept spamming it
  // mid-task; skip it with a directive instead of executing a no-op.
  if (/^chmod\b/.test(cmd) && /\.py(['"\s]|$)/.test(cmd)) {
    return Promise.resolve({
      ok: false,
      skippedAntiSpam: true,
      error:
        'chmod on a .py file was NOT executed — python scripts are run by the python3 runner and ' +
        'do not need the executable bit. Continue without it; do not call chmod again.',
    });
  }

  const t = Number.isFinite(timeout) && timeout > 0
    ? Math.min(timeout, MAX_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;
  const opts = { cwd: ROOT, timeout: t, maxBuffer: MAX_BUFFER };

  return new Promise((resolve) => {
    exec(cmd, opts, (error, stdout, stderr) => {
      if (error) {
        // exec sets code, and killed+signal SIGTERM indicates a timeout abort.
        resolve({
          ok: false,
          stdout,
          stderr,
          code: typeof error.code === 'number' ? error.code : 1,
          timedOut: error.killed === true && error.signal === 'SIGTERM',
        });
      } else {
        resolve({ ok: true, stdout, stderr, code: 0 });
      }
    });
  });
}

const shellTool = {
  name: 'run_shell',
  description:
    'Run a shell command in the workspace (sandboxed, 60 s default timeout, safety denylist). Returns stdout, stderr and exit code. KEEP COMMANDS SHORT AND SINGLE-LINE; for multi-line logic or anything with quotes, write a script file first (write_file to scripts/, e.g. scripts/tmp_check.js) and run `node scripts/tmp_check.js` / `bash scripts/tmp_check.sh` — nested quotes inside inline `node -e`/`python3 -c` one-liners get corrupted when the call is encoded as JSON.',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description:
          'The shell command to run. Payload shape: {"command": "free -h"} — the command key is required; single command, one line. Multi-line or quote-heavy logic: use a script file (see description).',
      },
      timeout_ms: { type: 'number', description: 'Optional timeout in ms (default 60000, max 300000)' },
    },
    required: ['command'],
  },
  execute(args) {
    return execute(args && args.command, args && args.timeout_ms);
  },
};

module.exports = { tools: [shellTool], execute, ROOT, DENIED_FRAGMENTS };