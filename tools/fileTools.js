/**
 * File-system tools (readFile, writeFile, editFile).
 *
 * Every tool is restricted strictly to config.workRoot (the plife project
 * directory by default). `resolveWithin()` resolves the user-supplied path and
 * refuses anything that escapes the sandbox — no absolute-path escapes, no
 * `..` traversal past the root.
 *
 * Tools are registered as uniform objects { name, description, parameters,
 * execute } so the tool-loop can dispatch them generically.
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');

const ROOT = path.resolve(config.workRoot);

// Resolve a user-supplied path; returns the absolute path or null if it
// escapes the sandbox.
function resolveWithin(rel) {
  if (typeof rel !== 'string') return null;
  const abs = path.resolve(ROOT, rel);
  const rooted = abs === ROOT || abs.startsWith(ROOT + path.sep);
  return rooted ? abs : null;
}

function relOf(abs) {
  const r = path.relative(ROOT, abs);
  return r || '.';
}

function fail(err) {
  return { ok: false, error: err && err.message ? err.message : String(err) };
}

const readFileTool = {
  name: 'read_file',
  description:
    'Read the content of a text file. Path is relative to the project workspace (default /home/openclaw/plife) and must stay inside it.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Workspace-relative file path' } },
    required: ['path'],
  },
  execute(args) {
    const abs = resolveWithin(args && args.path);
    if (!abs) return { ok: false, error: 'path escapes the allowed workspace' };
    try {
      const content = fs.readFileSync(abs, 'utf8');
      return { ok: true, path: relOf(abs), bytes: Buffer.byteLength(content), content };
    } catch (e) {
      return fail(e);
    }
  },
};

const writeFileTool = {
  name: 'write_file',
  description:
    'Create or fully overwrite a text file. Path is workspace-relative and must stay inside it; parent directories are created automatically.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative file path' },
      content: {
        type: ['string', 'array'],
        description: 'File content, or an array of lines to join with newlines',
      },
    },
    required: ['path', 'content'],
  },
  execute(args) {
    const abs = resolveWithin(args && args.path);
    if (!abs) return { ok: false, error: 'path escapes the allowed workspace' };
    const content = Array.isArray(args.content) ? args.content.join('\n') : String(args.content ?? '');
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf8');
      return { ok: true, path: relOf(abs), bytes: Buffer.byteLength(content) };
    } catch (e) {
      return fail(e);
    }
  },
};

const editFileTool = {
  name: 'edit_file',
  description:
    'Make a targeted replacement inside an existing file (find old_text, replace with new_text). Refuses if old_text is not found.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative file path' },
      old_text: { type: 'string', description: 'Exact text to replace' },
      new_text: { type: 'string', description: 'Replacement text' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence instead of just the first (default false)' },
    },
    required: ['path', 'old_text', 'new_text'],
  },
  execute(args) {
    const abs = resolveWithin(args && args.path);
    if (!abs) return { ok: false, error: 'path escapes the allowed workspace' };
    try {
      const current = fs.readFileSync(abs, 'utf8');
      const { old_text, new_text } = args;
      if (typeof old_text !== 'string' || old_text === '') {
        return { ok: false, error: 'old_text must be a non-empty string' };
      }
      const has = args.replace_all ? current.split(old_text).length - 1 > 0 : current.includes(old_text);
      if (!has) {
        return { ok: false, error: 'old_text not found in file' };
      }
      const updated = args.replace_all
        ? current.split(old_text).join(String(new_text ?? ''))
        : current.replace(old_text, String(new_text ?? ''));
      fs.writeFileSync(abs, updated, 'utf8');
      return { ok: true, path: relOf(abs), bytes: Buffer.byteLength(updated) };
    } catch (e) {
      return fail(e);
    }
  },
};

const listFilesTool = {
  name: 'list_files',
  description:
    'List files and folders inside a workspace directory (relative to the project workspace). ' +
    'Use this — not read_file — whenever asked to list directory contents, see what files exist, ' +
    'or explore the project structure.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Workspace-relative directory path (defaults to the workspace root)',
      },
      recursive: {
        type: 'boolean',
        description: 'Recurse into subdirectories (default false)',
      },
    },
  },
  execute(args) {
    // No path → workspace root; otherwise resolve with the sandbox guard.
    const hasPath = args && typeof args.path === 'string' && args.path.trim() !== '';
    const target = hasPath ? resolveWithin(args.path) : ROOT;
    if (!target) return { ok: false, error: 'path escapes the allowed workspace' };
    const recursive = !!(args && args.recursive);
    const MAX_ENTRIES = 2000;

    try {
      const entries = [];
      let count = 0;
      let truncated = false;

      const walk = (dir) => {
        let names;
        try {
          names = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          entries.push({ name: '[unreadable]', path: relOf(dir), type: 'error' });
          return;
        }
        for (const d of names) {
          if (count >= MAX_ENTRIES) { truncated = true; return; }
          const abs = path.join(dir, d.name);
          const isDir = d.isDirectory();
          entries.push({ name: d.name, path: relOf(abs), type: isDir ? 'directory' : 'file' });
          count++;
          if (isDir && recursive) walk(abs);
        }
      };

      walk(target);
      return { ok: true, path: relOf(target), count: entries.length, truncated, entries };
    } catch (e) {
      return fail(e);
    }
  },
};

module.exports = { tools: [readFileTool, writeFileTool, editFileTool, listFilesTool], resolveWithin, ROOT };