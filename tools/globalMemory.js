'use strict';
/**
 * Global semantic memory tool — manage_global_memory.
 *
 * Long-term cross-project memory: user preferences, coding styles,
 * personal instructions. Facts are embedded locally and retrieved
 * semantically (top-k) into every request derived from the user's query.
 *
 *   manage_global_memory({ action: "add",  fact, category? })
 *   manage_global_memory({ action: "delete", id | fact })
 *   manage_global_memory({ action: "search", fact })   -> top hits
 *   manage_global_memory({ action: "list" })           -> stored facts
 *
 * `delete` accepts the fact id (from add/search/list output) OR the exact
 * fact text. Never fabricate ids — use the id returned by add/search/list.
 */

const vectorMemory = require('../services/vectorMemory');

const DESCRIPTION =
  'Manage the GLOBAL semantic memory — long-term facts about the USER that persist ' +
  'across all sessions and projects: preferences, coding style, personal instructions, ' +
  'cross-project facts. Facts are embedded locally and the most relevant ones are ' +
  'auto-injected into future requests. ' +
  'Actions: add (store a new fact, optional category), delete (by id or exact fact text), ' +
  'search (find the semantically closest stored facts), list (all stored facts). ' +
  'Use this for USER-level facts; project-specific details belong in update_workspace_memory. ' +
  'Deleting is permanent — only delete exactly what the user asked to forget.';

const PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['add', 'delete', 'search', 'list'],
      description: 'add: store a fact (fact required, category optional); delete: remove by id or exact fact text; search: semantic lookup with fact as the query; list: all stored facts.',
    },
    fact: {
      type: 'string',
      description: 'The fact text to add, delete (exact text) or search with. Required for add/delete/search.',
    },
    category: {
      type: 'string',
      description: 'Optional category tag for the fact (e.g. "preference", "style", "project").',
    },
    id: {
      type: 'string',
      description: 'Optional id of the fact to delete (preferred over exact-text matching).',
    },
  },
  required: ['action'],
};

async function run(args) {
  const action = String(args.action || '').trim();
  if (!['add', 'delete', 'search', 'list'].includes(action)) {
    return { ok: false, error: `action must be one of add, delete, search, list (got "${action}")` };
  }
  if (action === 'add') {
    const r = await vectorMemory.addFact(args.fact, args.category);
    if (!r.ok) return r;
    return {
      ok: true,
      added: true,
      id: r.fact.id,
      fact: r.fact.fact,
      category: r.fact.category,
      note: 'This fact is now embedded and will be auto-injected into relevant future requests.',
    };
  }
  if (action === 'delete') {
    const key = args.id != null && String(args.id).trim() !== '' ? String(args.id).trim() : args.fact;
    const r = vectorMemory.deleteFact(key);
    if (!r.ok) return r;
    return { ok: true, deleted: true, id: r.id, note: 'Permanently removed from global memory.' };
  }
  if (action === 'search') {
    const q = String(args.fact == null ? '' : args.fact).trim();
    if (!q) return { ok: false, error: 'fact (the search query) is required for search' };
    const hits = await vectorMemory.searchFacts(q, 5);
    if (!hits.length) return { ok: true, hits: [], note: 'No stored memory matches this query.' };
    return {
      ok: true,
      hits: hits.map((h) => ({ id: h.id, category: h.category, fact: h.fact, score: h.score })),
    };
  }
  const facts = vectorMemory.listFacts(200);
  return {
    ok: true,
    count: facts.length,
    facts: facts.map((f) => ({ id: f.id, category: f.category, fact: f.fact })),
  };
}

module.exports = { tools: [{ name: 'manage_global_memory', description: DESCRIPTION, parameters: PARAMETERS, run }] };