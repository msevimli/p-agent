'use strict';
/**
 * Per-turn memory context builder.
 *
 * Produces the cache-friendly memory block appended as the LAST message of
 * a request (never inside the system message — dynamic content there would
 * invalidate the llama.cpp KV prefix every turn; the tail keeps the shared
 * prefix cached and only the short block is re-evaluated).
 *
 *   [Memory context — read carefully before answering]
 *   <workspace_memory>
 *   …MEMORY.md contents…
 *   </workspace_memory>
 *   <global_user_memory>
 *   - [category] fact (retrieved semantically for the current query)
 *   …
 *   </global_user_memory>
 *
 * HARD INVARIANTS:
 *  - build() NEVER throws and NEVER blocks the turn for long: the global
 *    retrieval embed is bounded (embedTimeoutMs); workspace read is sync
 *    and trivial. Any failure degrades to { text: null } — chat must never
 *    depend on memory being available.
 *  - Deterministic per turn: the block is built ONCE per request and
 *    reused for every loop round (top-k is stable within a turn; only the
 *    conversation grows, which is the normal cache pattern).
 *  - Never persisted: the block is appended at call time in routes/chat.js
 *    and never enters session history/compaction/UI.
 */

const config = require('../config');
const workspaceMemory = require('./workspaceMemory');
const vectorMemory = require('./vectorMemory');

const EMBED_TIMEOUT_MS = 10000; // first-use model load bounded, then fast

// Small per-process cache with mtime/size checks: the file is re-read
// every turn is fine (tiny), but a stat is cheaper than a read when absent.
let lastWs = { mtimeMs: -1, size: -1, present: false };

function workspaceSection() {
  const st = (() => {
    try {
      return require('fs').statSync(workspaceMemory.FILE);
    } catch {
      return null;
    }
  })();
  const present = !!st;
  if (present && st.mtimeMs === lastWs.mtimeMs && st.size === lastWs.size && lastWs.present) {
    lastWs = { mtimeMs: st.mtimeMs, size: st.size, present: true, content: lastWs.content };
    return lastWs.content;
  }
  lastWs.present = true;
  const r = workspaceMemory.readMemory();
  if (!r.exists) {
    lastWs = { mtimeMs: -1, size: -1, present: false };
    return null;
  }
  lastWs = { mtimeMs: st.mtimeMs, size: st.size, present: true, content: r.content };
  return r.content;
}

async function globalSection(userText, withTimeout) {
  try {
    const ctx = { text: userText, k: config.memoryTopK };
    const facts = await withTimeout(vectorMemory.searchFacts(userText, config.memoryTopK));
    if (!facts || !facts.length) return null;
    const lines = facts.map((f) => {
      const cat = f.category ? `[${f.category}] ` : '';
      return `- ${cat}${f.fact}`;
    });
    return `<global_user_memory>\n${lines.join('\n')}\n</global_user_memory>`;
  } catch (e) {
    console.log(`[memory] global retrieval failed (${e && e.message ? e.message : e}) — no memory context`);
    return null;
  }
}

/**
 * Build the memory context message for one turn.
 * Returns { text } or { text: null } (never throws).
 * `userText` = the user's latest message (the embedding query).
 */
async function buildMemoryContext(userText) {
  const start = Date.now();
  const timeout = (p) =>
    Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error('embedding timed out')), EMBED_TIMEOUT_MS)),
    ]);

  const parts = [];
  try {
    const ws = workspaceSection();
    if (ws) parts.push(`<workspace_memory>\n${ws}\n</workspace_memory>`);
  } catch {
    /* workspace memory never breaks a turn */
  }

  let g = null;
  try {
    g = await globalSection(typeof userText === 'string' ? userText : '', timeout);
  } catch {
    g = null;
  }
  if (g) parts.push(g);

  if (!parts.length) {
    return { text: null, ms: Date.now() - start };
  }
  const text = `[Memory context — read carefully before answering]\n${parts.join('\n')}`;
  return { text, ms: Date.now() - start };
}

/**
 * routes/chat.js helper: append the memory context to a request's messages
 * at CALL time (never mutates the working history).
 */
async function withMemoryContext(messages, userText) {
  const ctx = await buildMemoryContext(userText);
  if (!ctx.text) return messages;
  return [...messages, { role: 'user', content: ctx.text }];
}

module.exports = { buildMemoryContext, withMemoryContext, EMBED_TIMEOUT_MS };