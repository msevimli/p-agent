'use strict';
/**
 * Agent path zones — the two-zone resolution rule for AGENT tool paths.
 *
 *   workspaceDir (config.workspaceDir, default <workRoot>/workspaces/) is
 *   the agent's DEFAULT working directory:
 *     - bare relative paths  ("scripts/foo.py")  -> workspace zone
 *     - "./foo" / "workspaces/foo"               -> workspace zone
 *     - "../foo" (leading ..)                    -> PROJECT ROOT zone
 *                                                 (explicit root access)
 *     - absolute paths ("/x", "C:\\x")            -> REJECTED (undefined)
 *
 * The transform is IDEMPOTENT (safe to run at multiple layers: chat.js
 * label/status time AND toolLoop.executeTool). The hard sandbox is
 * UNCHANGED: fileTools.resolveWithin still resolves against workRoot and
 * rejects anything that escapes it — zoning only picks WHERE inside the
 * project a bare path lands.
 *
 * The File Explorer / fs routes do NOT go through this transform: they
 * browse the project root directly (workspaces/ is a normal folder).
 */

const path = require('path');
const config = require('../config');

/** Directory NAME of the agent workspace inside the project root. */
const WORKSPACE_DIR_NAME = 'workspaces';

/** Absolute path of the agent workspace (created on demand). */
const WORKSPACE_DIR = path.resolve(
  process.env.WORKSPACE_DIR || path.join(config.workRoot, WORKSPACE_DIR_NAME)
);

const ABS_RE = /^(?:[a-zA-Z]:[\\/]|\/)/;

/**
 * Map a user-supplied tool path to its zone form (relative to workRoot).
 * The agent's perspective is the WORKSPACE (its cwd), so:
 *   "x" / "./x" / "workspaces/x" -> "workspaces/x"   (workspace zone)
 *   ".." / "../x"                -> "."  / "x"       (project-root zone,
 *                                      one level UP from the workspace)
 *   "../../x" or absolute        -> undefined        (escapes the project)
 * Returns undefined for paths that must keep their strict escape rejection.
 */
function zonePath(rel) {
  if (typeof rel !== 'string' || rel.trim() === '') return rel;
  const r = rel.trim();
  if (ABS_RE.test(r)) return undefined; // absolute -> rejected upstream
  if (r === '..' || r.startsWith('../') || r.startsWith('..\\')) {
    let depth = 0;
    let rest = r;
    while (rest === '..' || rest.startsWith('../') || rest.startsWith('..\\')) {
      depth += 1;
      rest = rest.length >= 3 && (rest.startsWith('../') || rest.startsWith('..\\')) ? rest.slice(3) : '';
    }
    if (depth > 1) return undefined; // escapes the project root
    return rest === '' ? '.' : rest; // one level up = the project root
  }
  if (r === WORKSPACE_DIR_NAME || r.startsWith(WORKSPACE_DIR_NAME + '/') || r.startsWith(WORKSPACE_DIR_NAME + '\\')) {
    return r; // already names the workspace
  }
  return WORKSPACE_DIR_NAME + '/' + r; // default zone: the agent workspace
}

/**
 * Apply zoning to a tool-call args object in place (returns a new object
 * when it changed). Zoneable keys: path (+ shellTools have no path — the
 * cwd is set by shellTools itself). Idempotent.
 */
function zoneToolArgs(name, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  if (typeof args.path !== 'string' || args.path === '') return args;
  const zoned = zonePath(args.path);
  if (zoned === args.path) return args;
  if (zoned === undefined) return { ...args, __zoneRejected: true };
  return { ...args, path: zoned };
}

module.exports = { zonePath, zoneToolArgs, WORKSPACE_DIR_NAME, WORKSPACE_DIR };