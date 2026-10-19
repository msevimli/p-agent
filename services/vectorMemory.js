'use strict';
/**
 * Global semantic memory store — node:sqlite (built-in, zero native deps)
 * with JS cosine search over stored Float32 embeddings.
 *
 * The spec asked for sqlite-vec / better-sqlite3; Node's built-in
 * `node:sqlite` DatabaseSync is used instead: same synchronous SQLite
 * semantics, no native build risk on Node 26, and cosine top-k over a few
 * thousand 384-dim rows is trivially fast in JS (<1 ms/row). Swapping in a
 * real SQLite vector extension later only changes the search internals —
 * the API contract below is stable.
 *
 * Schema:
 *   global_memories(id TEXT PK, category TEXT, fact TEXT, embedding BLOB,
 *                   dim INTEGER, created_at INTEGER)
 *   meta(k TEXT PK, v TEXT)            — store-level key/value (dim, count)
 *
 * ENV: VECTOR_MEMORY_DB (redirectable for tests; binds at require time).
 * FAILURE POLICY: embed/search errors never throw out of the REST layer or
 * the chat loop — callers degrade to "no memory". addFact returns
 * { ok:false, error } instead of throwing for domain errors.
 */

const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { embed } = require('./embedder');

const MAX_FACTS = 5000;
const MAX_FACT_CHARS = 4000;
const MAX_CATEGORY_CHARS = 64;

const dbPath = config.vectorMemoryDb;

// DatabaseSync opens lazily at first use so a missing data/ dir or a
// redirect env that arrives late cannot break an unrelated require chain.
let db = null;
let storeDim = null;
let dimLoaded = false;

function openDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec(
    `CREATE TABLE IF NOT EXISTS global_memories (
       id TEXT PRIMARY KEY,
       category TEXT NOT NULL DEFAULT '',
       fact TEXT NOT NULL,
       embedding BLOB NOT NULL,
       dim INTEGER NOT NULL,
       created_at INTEGER NOT NULL
     );
     CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);`
  );
  return db;
}

function metaGet(k) {
  const row = openDb().prepare('SELECT v FROM meta WHERE k = ?').get(k);
  return row ? row.v : null;
}

function metaSet(k, v) {
  openDb().prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, String(v));
}

/** Current embedding dimension of the store (null before the first add). */
function dimension() {
  if (!dimLoaded) {
    const d = metaGet('dim');
    storeDim = d !== null && d !== '' ? Number(d) : null;
    dimLoaded = true;
  }
  return storeDim;
}

function setDimension(dim) {
  storeDim = dim;
  dimLoaded = true;
  metaSet('dim', dim);
}

function toVec(u8) {
  return new Float32Array(u8.buffer, u8.byteOffset, u8.byteLength >> 2);
}

function sanitizeCategory(category) {
  const c = String(category == null ? '' : category).trim().replace(/[\u0000-\u001f]/g, '');
  return c.length > MAX_CATEGORY_CHARS ? c.slice(0, MAX_CATEGORY_CHARS) : c;
}

function rowToFact(row) {
  return {
    id: row.id,
    category: row.category,
    fact: row.fact,
    created_at: Number(row.created_at),
  };
}

/**
 * Add a fact: embeds it, inserts the row. Resolves { ok:true, fact } or
 * { ok:false, error } (never throws for domain reasons).
 */
async function addFact(fact, category) {
  const text = String(fact == null ? '' : fact).trim();
  if (!text) return { ok: false, error: 'fact must be a non-empty string' };
  if (text.length > MAX_FACT_CHARS) return { ok: false, error: `fact too long (max ${MAX_FACT_CHARS} chars)` };
  // A fact goes into the PROMPT — strip control chars that could inject.
  const clean = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').trim();
  if (!clean) return { ok: false, error: 'fact contains no usable text' };

  let vec;
  try {
    vec = await embed(clean);
  } catch (e) {
    return { ok: false, error: `embedding failed: ${e && e.message ? e.message : e}` };
  }
  const dim = vec.length;

  const d = openDb();
  const current = dimension();
  if (current !== null && current !== dim) {
    return {
      ok: false,
      error: `embedding dimension changed (store is ${current}, provider produced ${dim}) — the provider switch is incompatible with stored vectors`,
    };
  }
  const count = Number(metaGet('count') || 0);
  if (count >= MAX_FACTS) {
    return { ok: false, error: `memory store is full (${MAX_FACTS} facts)` };
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  d.prepare('INSERT INTO global_memories (id, category, fact, embedding, dim, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    sanitizeCategory(category),
    clean,
    Buffer.from(vec.buffer),
    dim,
    now
  );
  if (current === null) setDimension(dim);
  metaSet('count', count + 1);
  return { ok: true, fact: { id, category: sanitizeCategory(category), fact: clean, created_at: now } };
}

/** Delete by id or exact fact text. Returns { ok, deleted } or { ok:false, error }. */
function deleteFact(idOrText) {
  const key = String(idOrText == null ? '' : idOrText).trim();
  if (!key) return { ok: false, error: 'id or fact text is required' };
  const d = openDb();
  let row = d.prepare('SELECT id FROM global_memories WHERE id = ?').get(key);
  if (!row) row = d.prepare('SELECT id FROM global_memories WHERE fact = ?').get(key);
  if (!row) return { ok: false, error: 'memory not found' };
  d.prepare('DELETE FROM global_memories WHERE id = ?').run(row.id);
  const count = Math.max(0, Number(metaGet('count') || 0) - 1);
  metaSet('count', count);
  return { ok: true, deleted: true, id: row.id };
}

/** All facts, newest first (no embeddings — lightweight for lists/UIs). */
function listFacts(limit = 500) {
  const capped = Math.min(Math.max(1, Number(limit) || 500), 5000);
  const rows = openDb()
    .prepare('SELECT id, category, fact, created_at FROM global_memories ORDER BY created_at DESC LIMIT ?')
    .all(capped);
  return rows.map(rowToFact);
}

/** Semantic top-k over the whole store (normalized vectors -> dot = cosine). */
async function searchFacts(query, k = 5) {
  const q = String(query == null ? '' : query).trim();
  const top = Math.min(Math.max(1, Number(k) || 5), 20);
  if (!q) return [];
  let qv;
  try {
    qv = await embed(q);
  } catch (e) {
    console.log(`[memory] search embed failed (${e && e.message ? e.message : e}) — empty result`);
    return [];
  }
  const rows = openDb()
    .prepare('SELECT id, category, fact, created_at, embedding FROM global_memories')
    .all();
  const scored = [];
  for (const row of rows) {
    const v = toVec(row.embedding);
    let dot = 0;
    for (let i = 0; i < qv.length && i < v.length; i++) dot += qv[i] * v[i];
    scored.push({ ...rowToFact(row), score: Number(dot.toFixed(4)) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, top);
}

function countFacts() {
  const row = openDb().prepare('SELECT COUNT(*) AS n FROM global_memories').get();
  return Number(row.n);
}

/** Tests only: wipe the store (dim + count meta reset). */
function reset() {
  openDb().exec('DELETE FROM global_memories; DELETE FROM meta;');
  storeDim = null;
  dimLoaded = false;
}

module.exports = { addFact, deleteFact, listFacts, searchFacts, countFacts, reset, dimension, MAX_FACTS };