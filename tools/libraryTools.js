/**
 * Library tools — give the agent access to the persistent file Library.
 *
 *   list_library_files  — see what the user has stored (ids, names, sizes)
 *   read_library_file   — read a stored file's text content (by id or name)
 *   upload_library_file — save a text document/code snippet into the Library
 *
 * Registered in tools/index.js alongside the file/shell/skills/automations
 * tools so the same schema-driven tool loop serves them automatically.
 */
const library = require('../services/libraryManager');

const MAX_TEXT = 100000; // chars returned per read_library_file call

const listTool = {
  name: 'list_library_files',
  description:
    'List every file in the persistent user Library (id, name, size, type). Call this whenever the user refers to their documents, uploads, or library files, or asks what is stored — never guess file ids or names before listing.',
  parameters: { type: 'object', properties: {} },
  execute() {
    const files = library.list().map((f) => ({
      id: f.id,
      name: f.name,
      mime: f.mime,
      size: f.size,
      description: f.description || undefined,
      updatedAt: f.updatedAt,
    }));
    return { ok: true, count: files.length, files };
  },
};

const readTool = {
  name: 'read_library_file',
  description:
    'Read the TEXT content of a file from the persistent user Library, by its exact id (preferred) or by its exact stored name. Use this for attached files and library documents. Binary files return metadata instead of content.',
  parameters: {
    type: 'object',
    properties: {
      file_id: { type: 'string', description: 'Library file id (from list_library_files or an attachment)' },
      name: { type: 'string', description: 'Exact file name as stored in the Library (used when no id is known)' },
    },
  },
  execute(args) {
    const id = String((args && (args.file_id || args.id)) || '').trim();
    const name = String((args && args.name) || '').trim();
    const entry = (id && library.get(id)) || (name && library.getByName(name));
    if (!entry) {
      return {
        ok: false,
        error: `no library file matches id '${id}' or name '${name}' — call list_library_files to see what is stored`,
      };
    }
    const meta = {
      id: entry.id,
      name: entry.name,
      mime: entry.mime,
      size: entry.size,
      description: entry.description || '',
      updatedAt: entry.updatedAt,
    };
    const r = library.readText(entry.id, MAX_TEXT);
    if (!r.ok) return { ok: false, file: meta, error: r.error };
    return {
      ok: true,
      file: meta,
      chars: r.text.length,
      truncated: r.truncated,
      content: r.text,
    };
  },
};

const uploadTool = {
  name: 'upload_library_file',
  description:
    'Save a new text file (document, code snippet, notes) into the persistent user Library. Provide the filename with extension and the full content; a short description is optional. Existing files are never overwritten — each call creates a new Library entry.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'File name with extension, e.g. notes.md' },
      content: { type: 'string', description: 'Full text content of the file' },
      description: { type: 'string', description: 'Short optional description of what this file is' },
    },
    required: ['name', 'content'],
  },
  execute(args) {
    const name = String((args && args.name) || '').trim();
    const content = String((args && args.content) ?? '');
    if (!name) return { ok: false, error: 'name is required' };
    if (!content.trim()) return { ok: false, error: 'content must be a non-empty value' };
    const r = library.save({
      name,
      description: String((args && args.description) || ''),
      buffer: Buffer.from(content, 'utf8'),
    });
    if (!r.ok) return r;
    return {
      ok: true,
      file: {
        id: r.file.id,
        name: r.file.name,
        mime: r.file.mime,
        size: r.file.size,
        description: r.file.description || '',
      },
    };
  },
};

module.exports = { tools: [listTool, readTool, uploadTool] };