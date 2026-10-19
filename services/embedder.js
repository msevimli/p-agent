'use strict';
/**
 * Embedding provider chain for the semantic-memory layer.
 *
 * Providers (config.memoryEmbedder):
 *   xenova  — @xenova/transformers + all-MiniLM-L6-v2 (local, 384-dim,
 *             ~90 MB weights, first use downloads to the HF cache).
 *   ollama  — POST {model, input} to OLLAMA_URL/api/embeddings.
 *   hash    — built-in deterministic 384-dim signed n-gram hashing.
 *             Dependency-free offline fallback: keyword-overlap similarity
 *             (exact-word n-grams), not true semantics — good enough for
 *             the pipeline to work and test hermetically everywhere.
 *   auto    — xenova when importable, else ollama if reachable, else hash.
 *
 * Every provider returns an L2-NORMALIZED Float32Array, so cosine
 * similarity == plain dot product. Dimension is 384 for every provider
 * here (ollama models may differ — the DB rejects a dimension change with
 * a clear error rather than corrupting stored vectors).
 *
 * INVARIANT for the chat loop: embedding failures NEVER break a turn.
 * embed() throws on hard errors; callers (vectorMemory.search, memoryContext)
 * catch and degrade to "no memory context" — and the hash provider makes
 * total unavailability practically unreachable.
 */

const config = require('../config');

const DIM = 384;

// ---------------------------------------------------------------------------
// hash provider — deterministic signed n-gram hashing into 384 buckets
// ---------------------------------------------------------------------------

// FNV-1a 32-bit (deterministic across processes/platforms).
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function stemLite(w) {
  // Deterministic morphological-lite normalization (no deps): turns
  // prefers/prefer, projects/project, enjoys/enjoy into the same token.
  // Applied symmetrically to facts AND queries, so retrieval sees
  // inflectional variants as the same term. Guarded lengths keep real
  // words intact (e.g. "has" is not "h").
  if (w.length > 4) {
    if (w.endsWith('ing')) w = w.slice(0, -3);
    else if (w.endsWith('ies')) w = w.slice(0, -3) + 'y';
    else if (w.endsWith('es')) w = w.slice(0, -2);
    else if (w.endsWith('ed')) w = w.slice(0, -2);
    else if (w.endsWith('s')) w = w.slice(0, -1);
  }
  return w;
}

function hashTokens(text) {
  const words = (String(text).toLowerCase().match(/[a-z0-9_]+/g) || []).map(stemLite);
  const grams = [];
  for (const w of words) {
    grams.push('w:' + w); // word grams (weighted 3x in embedHash — the real signal)
    const compact = w.length > 24 ? w.slice(0, 12) + w.slice(-8) : w;
    for (let i = 0; i + 1 < compact.length; i++) grams.push(compact.slice(i, i + 2));
  }
  return grams;
}

const WORD_WEIGHT = 3; // exact (stemmed) word overlap dominates the signal

function embedHash(text) {
  const vec = new Float32Array(DIM);
  for (const gram of hashTokens(text)) {
    const weight = gram.startsWith('w:') ? WORD_WEIGHT : 1;
    const h1 = fnv1a('g:' + gram) % DIM;
    const h2 = fnv1a('s:' + gram) % DIM;
    vec[h1] += weight;
    vec[h2] -= weight;
  }
  let norm = 0;
  for (let i = 0; i < DIM; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < DIM; i++) vec[i] /= norm;
  return vec;
}

// ---------------------------------------------------------------------------
// xenova provider — lazy singleton so a missing/undownloaded model never
// blocks boot; first embed pays the load (bounded by a timeout).
// ---------------------------------------------------------------------------

let xenovaLoader = null;
function xenovaEmbedder() {
  if (!xenovaLoader) {
    xenovaLoader = (async () => {
      // eslint-disable-next-line global-require
      const { pipeline } = require('@xenova/transformers');
      const ext = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
      return async (text) => {
        const out = await ext([String(text)], { pooling: 'mean', normalize: true });
        return new Float32Array(out.data);
      };
    })().catch((e) => {
      console.log(`[memory] xenova unavailable (${e.message}) — falling back`);
      xenovaLoader = null; // allow one retry per process later
      throw e;
    });
  }
  return xenovaLoader;
}

// ---------------------------------------------------------------------------
// ollama provider
// ---------------------------------------------------------------------------

async function embedOllama(text) {
  const url = config.memoryEmbedderOllamaUrl.replace(/\/+$/, '') + '/api/embeddings';
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), 5000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'nomic-embed-text', input: String(text) }),
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`ollama embeddings HTTP ${res.status}`);
    const data = await res.json();
    const arr = data && Array.isArray(data.embedding) ? data.embedding : null;
    if (!arr || !arr.length) throw new Error('ollama returned no embedding');
    const vec = new Float32Array(arr.length);
    let norm = 0;
    for (let i = 0; i < arr.length; i++) {
      vec[i] = Number(arr[i]) || 0;
      norm += vec[i] * vec[i];
    }
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < vec.length; i++) vec[i] /= norm;
    return vec;
  } finally {
    clearTimeout(to);
  }
}

// ---------------------------------------------------------------------------
// chain
// ---------------------------------------------------------------------------

let ollamaReachable = null; // null = unknown, true/false cached (2 s TTL-ish)
async function probeOllama() {
  if (ollamaReachable !== null) return ollamaReachable;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 1500);
    try {
      const res = await fetch(config.memoryEmbedderOllamaUrl.replace(/\/+$/, '') + '/api/tags', {
        signal: ctl.signal,
      });
      ollamaReachable = res.ok;
    } finally {
      clearTimeout(t);
    }
  } catch {
    ollamaReachable = false;
  }
  return ollamaReachable;
}

/**
 * embed(text) -> Promise<Float32Array> (L2-normalized).
 * Resolves via the configured provider; falls through auto/xenova/ollama
 * failures onto the hash provider. Never rejects for provider reasons
 * (a rejected promise means the whole memory layer is misconfigured).
 */
async function embed(text) {
  const mode = String(config.memoryEmbedder || 'hash').toLowerCase();
  const tried = [];
  const tryProvider = async (name, fn) => {
    tried.push(name);
    try {
      return await fn(text);
    } catch (e) {
      console.log(`[memory] embedder ${name} failed (${e && e.message ? e.message : e})`);
      return null;
    }
  };

  let vec = null;
  if (mode === 'xenova') {
    try {
      vec = await tryProvider('xenova', async (t) => (await xenovaEmbedder())(t));
    } catch { vec = null; }
  } else if (mode === 'ollama') {
    if (await probeOllama()) vec = await tryProvider('ollama', embedOllama);
  } else if (mode === 'auto') {
    try {
      vec = await tryProvider('xenova', async (t) => (await xenovaEmbedder())(t));
    } catch { vec = null; }
    if (!vec && (await probeOllama())) vec = await tryProvider('ollama', embedOllama);
  }
  if (!vec) vec = embedHash(text); // deterministic, always works
  return vec;
}

/**
 * embedMany(texts) -> Promise<Float32Array[]> — same provider, one call.
 * (xenova batches natively; hash is sync; used for REST bulk ops.)
 */
async function embedMany(texts) {
  const arr = Array.isArray(texts) ? texts : [texts];
  const out = [];
  for (const t of arr) out.push(await embed(t));
  return out;
}

/**
 * Boot warm: preloads the embedding provider (xenova model download +
 * instantiation) in the background so the FIRST real turn's memory context
 * never pays the load. Fire-and-forget: never rejects.
 */
async function warm() {
  try {
    const t0 = Date.now();
    await embed('warm-up');
    console.log(`[memory] embedder warm in ${Date.now() - t0} ms`);
  } catch (e) {
    console.log(`[memory] embedder warm failed (${e && e.message ? e.message : e})`);
  }
}

module.exports = { embed, embedMany, embedHash, hashTokens, DIM, fnv1a, warm };