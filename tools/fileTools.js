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
    'Read a text file (workspace path; 1-based line offset/limit for large files, output capped)',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative path (default zone: the agent workspace "workspaces/"; prefix "../" targets the project root explicitly), e.g. "scripts/get_solana_price.py"' },
      offset: { type: 'number', description: 'First line to read (1-based, default 1)' },
      limit: { type: 'number', description: 'Max lines to read (default: to EOF, capped by size)' },
    },
    required: ['path'],
  },
  execute(args) {
    const abs = resolveWithin(args && args.path);
    if (!abs) return { ok: false, error: 'path escapes the allowed workspace' };
    try {
      const raw = fs.readFileSync(abs, 'utf8');
      const lines = raw.split('\n');
      const offset = Math.max(1, Number(args && args.offset) || 1);
      const limit = args && args.limit !== undefined && args.limit !== null ? Math.max(1, Number(args.limit) || 1) : null;
      const from = Math.min(lines.length, offset - 1);
      const to = limit ? Math.min(lines.length, from + limit) : lines.length;
      let content = lines.slice(from, to).join('\n');
      const cap = Number.isFinite(config.readFileMaxChars) ? config.readFileMaxChars : 6000;
      let truncated = content.length > cap;
      if (truncated) {
        // Deterministic cut at the cap with a clear tail marker; the model
        // can page with offset/limit to read the rest.
        content = content.slice(0, cap) + '\n…[truncated: file continues — use read_file with offset/limit to read the next range]…';
      }
      return {
        ok: true,
        path: relOf(abs),
        bytes: Buffer.byteLength(raw),
        chars: content.length,
        lines: to - from,
        offset: from + 1,
        limit: to - from,
        truncated,
        content,
      };
    } catch (e) {
      // Log files under logs/ (or log-named paths) don't exist until the
      // automation's first scheduled run — sharpen the error so the model
      // stops pre-reading output it can't have yet (the old generic ENOENT
      // triggered retry loops).
      const rel = relOf(abs);
      const base = String(rel).split(/[\\/]/).pop() || '';
      const looksLikeLog = /^logs\//.test(String(rel)) || /\/logs\//.test(String(rel)) || /\.log$/i.test(base) || /^log/i.test(base);
      if (e && e.code === 'ENOENT' && looksLikeLog) {
        return {
          ok: false,
          error:
            `${rel} does not exist yet — log files are only written when the automation runs on its ` +
            `schedule (or after a run_automation trigger). It is NORMAL for it to be absent right ` +
            `after creation. Do not re-read it in this task; to get it now, trigger the automation ` +
            `with run_automation once, then read it.`,
        };
      }
      return fail(e);
    }
  },
};

const writeFileTool = {
  name: 'write_file',
  description:
    'Create or fully overwrite a text file (parent directories are created automatically). For multi-line or quote-heavy shell logic, write a script here (scripts/…) and run it with run_shell — prefer this over inline `node -e`/`python3 -c` one-liners, whose nested quotes break when JSON-encoded.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative path (default zone: the agent workspace "workspaces/"; prefix "../" targets the project root explicitly), e.g. "scripts/get_solana_price.py"' },
      content: {
        type: ['string', 'array'],
        description:
          'File content, or an array of lines. JSON RULE: code inside this string must escape every internal double quote as \\" — e.g. data["solana"] is written data[\\"solana\\"]. One file per call; never nest raw or fenced code into deep JSON (prefer write_file sequentially for each script file).',
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
    'Replace old_text with new_text in an existing file (fails if old_text is not found).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative path (default zone: the agent workspace "workspaces/"; prefix "../" targets the project root explicitly), e.g. "scripts/get_solana_price.py"' },
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
    'List a workspace directory (or the workspace root). Use this instead of read_file for directories.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Workspace-relative directory (default zone: the agent workspace "workspaces/"; prefix "../" for the project root), e.g. "scripts"',
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
    const MAX_ENTRIES = 2000; // hard walk bound (count only beyond this)
    const LIST_LIMIT = Number.isFinite(config.listFilesMaxEntries) ? config.listFilesMaxEntries : 200;

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
          // Keep listing at most LIST_LIMIT entries (the prompt is precious);
          // the total count is still reported so the model can tell it is
          // missing entries and narrow the path instead.
          if (entries.length < LIST_LIMIT) {
            entries.push({ name: d.name, path: relOf(abs), type: isDir ? 'directory' : 'file' });
          }
          count++;
          if (isDir && recursive) walk(abs);
        }
      };

      walk(target);
      const omitted = count - entries.length;
      return {
        ok: true,
        path: relOf(target),
        count,
        shown: entries.length,
        omitted: omitted > 0 ? omitted : 0,
        truncated: truncated || omitted > 0,
        entries,
      };
    } catch (e) {
      return fail(e);
    }
  },
};

const deleteFileTool = {
  name: 'delete_file',
  description:
    'Permanently delete a file in the workspace (like rm <file>). Fails cleanly for directories, ' +
    'missing files and paths outside the workspace.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative path of the file to delete, e.g. "scripts/old.py"' },
    },
    required: ['path'],
  },
  execute(args) {
    const abs = resolveWithin(args && args.path);
    if (!abs) return { ok: false, error: 'path escapes the allowed workspace' };
    let st;
    try {
      st = fs.statSync(abs);
    } catch (e) {
      return { ok: false, error: `no such file: ${relOf(abs)}` };
    }
    if (st.isDirectory()) {
      return { ok: false, error: `${relOf(abs)} is a directory — delete_file removes single files only` };
    }
    try {
      fs.unlinkSync(abs);
    } catch (e) {
      return fail(e);
    }
    return { ok: true, deleted: true, path: relOf(abs) };
  },
};

module.exports = { tools: [readFileTool, writeFileTool, editFileTool, listFilesTool, deleteFileTool], resolveWithin, ROOT };