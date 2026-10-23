'use strict';
/**
 * Workspace memory tool — update_workspace_memory.
 *
 * Reads/appends/overwrites the active workspace MEMORY.md (project facts,
 * architectural decisions, conventions). The file is injected into every
 * request while present, so the tool's whole job is keeping it correct.
 *
 * The path is FIXED (config.workspaceMemoryFile) and the size cap is
 * config.memoryFileMaxChars — no user-supplied path, no traversal surface.
 *
 * Tool-call convention: describe+payload shapes live here; validateArgs
 * (toolLoop) enforces the schema before execution.
 */

const workspaceMemory = require('../services/workspaceMemory');

const DESCRIPTION =
  'Read, append to or overwrite the workspace MEMORY.md — the persistent project memory ' +
  'file (inside the agent workspace "workspaces/") that is injected into EVERY future request of this workspace. Use it to store ' +
  'project-specific facts, architectural decisions, technical debt and conventions ' +
  '(NOT user preferences — those belong to manage_global_memory). ' +
  'Actions: read (return the current contents), append (add a section to the end), ' +
  'overwrite (replace the whole file). Keep entries short and factual — the file is ' +
  're-read into the prompt on every turn.';

const PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['read', 'append', 'overwrite'],
      description: 'What to do: read returns the current contents; append adds content to the end; overwrite replaces the whole file.',
    },
    content: {
      type: 'string',
      description: 'Text to append or the new full file for overwrite (required for append/overwrite; ignored for read).',
    },
  },
  required: ['action'],
};

function run(args) {
  const action = String(args.action || '').trim();
  if (!['read', 'append', 'overwrite'].includes(action)) {
    return { ok: false, error: `action must be one of read, append, overwrite (got "${action}")` };
  }
  if (action === 'read') {
    const r = workspaceMemory.readMemory();
    if (!r.exists) return { ok: true, exists: false, content: '', note: 'No MEMORY.md yet — create it with action:"append" or action:"overwrite".' };
    return { ok: true, exists: true, bytes: r.bytes, content: r.content, truncated: r.truncated };
  }
  const content = args.content == null ? '' : String(args.content);
  if (content.trim() === '') return { ok: false, error: 'content is required for append/overwrite' };
  if (action === 'append') {
    const r = workspaceMemory.appendMemory(content);
    if (!r.ok) return r;
    return { ok: true, appended: true, bytes: r.bytes };
  }
  const w = workspaceMemory.writeMemory(content);
  if (!w.ok) return w;
  return { ok: true, overwritten: true, bytes: w.bytes };
}

module.exports = { tools: [{ name: 'update_workspace_memory', description: DESCRIPTION, parameters: PARAMETERS, execute: run }] };