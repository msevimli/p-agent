/**
 * Semantic memory battery — services/vectorMemory, services/embedder,
 * services/workspaceMemory, services/memoryContext, tools/*
 * (manage_global_memory, update_workspace_memory), routes/memory.
 *
 * HERMETIC: VECTOR_MEMORY_DB and PLIFE_WORK_ROOT point at throwaway temp
 * paths and VECTOR_MEMORY_EMBEDDER=hash (deterministic, no model
 * download) — the real data/vector-memory.db is never touched; the
 * MEMORY_FILE_MAX_CHARS cap is shrunk so boundary cases are cheap.
 *
 * Covers: embedding determinism/geometry, add/list/delete/count,
 * semantic retrieval precision (top-k ordering), tool wrappers
 * (validation + cap), the per-turn context builder, and the REST
 * endpoints (GET/POST/DELETE + workspace GET/PUT/DELETE + caps + 404s).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-work-'));
const DB = path.join(os.tmpdir(), `mem-db-${process.pid}.db`);
process.env.PLIFE_WORK_ROOT = WORK;
process.env.VECTOR_MEMORY_DB = DB;
process.env.VECTOR_MEMORY_EMBEDDER = 'hash';
process.env.MEMORY_FILE_MAX_CHARS = '2000'; // cheap cap boundaries

const ROOT = path.resolve(__dirname, '..');
const express = require(path.join(ROOT, 'node_modules', 'express'));

const results = [];
const t = (name, cond, info) =>
  results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? ' | ' + String(info) : ''}`);

(async () => {
  const embedder = require(path.join(ROOT, 'services', 'embedder'));
  const vectorMemory = require(path.join(ROOT, 'services', 'vectorMemory'));
  const workspaceMemory = require(path.join(ROOT, 'services', 'workspaceMemory'));
  const memoryContext = require(path.join(ROOT, 'services', 'memoryContext'));
  const globalTool = require(path.join(ROOT, 'tools', 'globalMemory')).tools[0];
  const wsTool = require(path.join(ROOT, 'tools', 'workspaceMemory')).tools[0];

  // ---- 1) embedding geometry + determinism (hash provider) ------------------
  {
    const a = await embedder.embed('the user prefers TypeScript');
    const b = await embedder.embed('the user prefers TypeScript');
    const c = await embedder.embed('dark chocolate with coffee');
    const dot = (x, y) => { let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * y[i]; return s; };
    t('embed: dimension is 384', a.length === 384, a.length);
    t('embed: vectors are L2-normalized', Math.abs(Math.sqrt(dot(a, a)) - 1) < 1e-4, Math.sqrt(dot(a, a)));
    t('embed: deterministic (same text -> same vector)', dot(a, b) > 0.9999, dot(a, b));
    t('embed: overlap scores above unrelated', dot(a, b) > dot(a, c), `${dot(a, b).toFixed(3)} vs ${dot(a, c).toFixed(3)}`);
  }

  // ---- 2) CRUD on the store ---------------------------------------------------
  {
    const r0 = await vectorMemory.addFact('', 'x');
    t('store: empty fact rejected', r0.ok === false && /non-empty/.test(r0.error), r0.error);
    const r1 = await vectorMemory.addFact('the user prefers TypeScript for backend projects', 'preference');
    t('store: add with category ok', r1.ok && r1.fact.category === 'preference' && !!r1.fact.id, JSON.stringify(r1.fact));
    const r2 = await vectorMemory.addFact('the user enjoys dark chocolate with coffee', 'personal');
    t('store: second fact ok', r2.ok);
    const rBad = await vectorMemory.addFact('x'.repeat(5000));
    t('store: over-long fact rejected (4k cap)', rBad.ok === false && /too long/.test(rBad.error), rBad.error);
    t('store: count is 2', vectorMemory.countFacts() === 2, vectorMemory.countFacts());
    const all = vectorMemory.listFacts();
    t('store: list returns newest first with categories', all.length === 2 && all[0].category === 'personal' && typeof all[0].created_at === 'number', JSON.stringify(all.map((f) => f.category)));
    const d1 = vectorMemory.deleteFact(r1.fact.id);
    t('store: delete by id ok', d1.ok && d1.deleted && vectorMemory.countFacts() === 1, JSON.stringify(d1));
    const d2 = vectorMemory.deleteFact('the user enjoys dark chocolate with coffee');
    t('store: delete by exact fact text ok', d2.ok && vectorMemory.countFacts() === 0, JSON.stringify(d2));
    const d3 = vectorMemory.deleteFact('never existed');
    t('store: delete unknown -> not found', d3.ok === false && /not found/.test(d3.error), d3.error);
  }

  // ---- 3) retrieval precision (top-k ordering) --------------------------------
  {
    const fTs = await vectorMemory.addFact('the user prefers TypeScript for backend projects', 'preference');
    await vectorMemory.addFact('the user enjoys dark chocolate with coffee', 'personal');
    await vectorMemory.addFact('the server must never bind to a public interface without an API key', 'security');
    const hits = await vectorMemory.searchFacts('coding language preference: TypeScript or JavaScript?', 3);
    t('search: top-3 returned', hits.length === 3, hits.length);
    t('search: TypeScript fact ranks #1 for the language query',
      hits[0] && hits[0].fact.includes('TypeScript'), JSON.stringify(hits.map((h) => h.fact.slice(0, 30))));
    t('search: scores are descending and bounded', hits[0].score >= hits[1].score && hits[1].score >= hits[2].score && hits[0].score <= 1.0001, hits.map((h) => h.score).join(','));
    const exact = await vectorMemory.searchFacts('the user prefers TypeScript for backend projects', 1);
    t('search: exact duplicate scores ~1.0', exact.length === 1 && exact[0].score > 0.999, exact[0] && exact[0].score);
    const sec = await vectorMemory.searchFacts('is it safe to expose the API?', 1);
    t('search: security fact retrieved for a security query', sec[0] && /API key|interface/.test(sec[0].fact), sec[0] && sec[0].fact);
    vectorMemory.deleteFact(fTs.fact.id); // keep precision facts isolated for later nets
  }

  // ---- 4) tool wrappers ---------------------------------------------------------
  {
    const a = await globalTool.execute({ action: 'nope' });
    t('tool-global: invalid action rejected', a.ok === false && /action must be/.test(a.error), a.error);
    const b = await globalTool.execute({ action: 'add' });
    t('tool-global: add without fact rejected', b.ok === false, b.error);
    const c = await globalTool.execute({ action: 'add', fact: 'user prefers terse commit messages', category: 'style' });
    t('tool-global: add ok with id', c.ok && c.added && !!c.id, JSON.stringify(c));
    const lst = await globalTool.execute({ action: 'list' });
    t('tool-global: list returns stored facts', lst.ok && lst.count >= 1 && lst.facts.some((f) => f.fact.includes('commit')), JSON.stringify(lst.facts && lst.facts[0]));
    const s = await globalTool.execute({ action: 'search', fact: 'how should commit messages look' });
    t('tool-global: search hits the commit-style fact', s.ok && s.hits[0] && s.hits[0].fact.includes('commit'), JSON.stringify(s.hits && s.hits[0]));
    const del = await globalTool.execute({ action: 'delete', id: c.id });
    t('tool-global: delete by id ok', del.ok && del.deleted);

    const w1 = wsTool.execute({ action: 'read' });
    t('tool-ws: read absent returns exists:false', w1.ok && w1.exists === false, JSON.stringify(w1));
    const w2 = wsTool.execute({ action: 'slam' });
    t('tool-ws: invalid action rejected', w2.ok === false, w2.error);
    const w3 = wsTool.execute({ action: 'append', content: '' });
    t('tool-ws: append without content rejected', w3.ok === false, w3.error);
    const w4 = wsTool.execute({ action: 'append', content: '# Project notes\n- The deployment is docker-based' });
    t('tool-ws: append ok', w4.ok && w4.appended, JSON.stringify(w4));
    const w5 = wsTool.execute({ action: 'read' });
    t('tool-ws: read returns appended content', w5.ok && w5.exists && w5.content.includes('docker-based'), JSON.stringify(w5.content && w5.content.slice(0, 40)));
    const w6 = wsTool.execute({ action: 'overwrite', content: 'DRAFT' });
    t('tool-ws: overwrite ok', w6.ok && w6.overwritten);
    const w7 = wsTool.execute({ action: 'read' });
    t('tool-ws: overwrite replaced content', w7.ok && w7.content === 'DRAFT', JSON.stringify(w7.content));
    const w8 = wsTool.execute({ action: 'overwrite', content: 'y'.repeat(4000) });
    t('tool-ws: cap rejection at 2000 chars', w8.ok === false && /too large/.test(w8.error), w8.error);
  }

  // ---- 5) per-turn memory context builder ---------------------------------------
  {
    // store: language fact + style fact; workspace: the DRAFT content above
    const f = await vectorMemory.addFact('the user prefers TypeScript for backend projects', 'preference');
    const ctx = await memoryContext.buildMemoryContext('which language should this project use');
    t('ctx-inject: workspace block present', ctx.text.includes('<workspace_memory>') && ctx.text.includes('DRAFT'), ctx.text.slice(0, 60));
    t('ctx-inject: global block present with the retrieved fact',
      ctx.text.includes('<global_user_memory>') && ctx.text.includes('TypeScript'), ctx.text.slice(-160));
    t('ctx-inject: fact carries its category tag', /\[preference\]/.test(ctx.text), '');
    const ctx2 = await memoryContext.buildMemoryContext('irrelevant unrelated question about the weather today');
    t('ctx-inject: unrelated query still injects workspace (always-on)', ctx2.text.includes('<workspace_memory>'), '');
    // Optionality per block: with the file gone but facts present, ONLY the
    // global block remains; with the store empty too, the context is null.
    workspaceMemory.clearMemory();
    const ctxWsEmpty = await memoryContext.buildMemoryContext('anything at all');
    t('ctx-inject: no workspace file -> no workspace block', ctxWsEmpty.text.includes('<global_user_memory>') && !ctxWsEmpty.text.includes('<workspace_memory>'), ctxWsEmpty.text.slice(0, 40));
    vectorMemory.reset();
    const ctxEmpty = await memoryContext.buildMemoryContext('anything at all');
    t('ctx-inject: both layers empty -> text null (chat proceeds unchanged)', ctxEmpty.text === null, JSON.stringify(ctxEmpty.text));
  }

  // ---- 6) REST endpoints -----------------------------------------------------------
  {
    const routes = require(path.join(ROOT, 'routes', 'memory.js'));
    const app = express();
    app.use(express.json({ limit: '4mb' }));
    app.use('/api/memory', routes);
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const base = `http://127.0.0.1:${server.address().port}/api/memory`;
    const j = (p, o) => fetch(base + p, Object.assign({ headers: { 'content-type': 'application/json' } }, o));

    let r = await j('/');
    const empty = await r.json();
    t('rest: GET empty store returns ok + 0 facts', r.status === 200 && empty.ok && empty.count === 0, JSON.stringify(empty).slice(0, 60));

    r = await j('/', { method: 'POST', body: JSON.stringify({ fact: 'the user prefers TypeScript for backend projects', category: ' preference ' }) });
    const added = await r.json();
    t('rest: POST add returns 201 + trimmed category', r.status === 201 && added.ok && added.fact.category === 'preference', JSON.stringify(added));
    await j('/', { method: 'POST', body: JSON.stringify({ fact: 'the user enjoys dark chocolate with coffee' }) });

    r = await j('/?q=' + encodeURIComponent('which coding language does the user prefer'));
    const searched = await r.json();
    t('rest: GET ?q= semantic search top hit is the TypeScript fact', r.status === 200 && searched.ok && searched.facts[0] && searched.facts[0].fact.includes('TypeScript'), JSON.stringify(searched.facts && searched.facts[0] && searched.facts[0].fact));

    r = await j('/', { method: 'POST', body: JSON.stringify({ fact: '   ' }) });
    t('rest: POST blank fact -> 400', r.status === 400, r.status);

    r = await j('/' + encodeURIComponent('missing-id'), { method: 'DELETE' });
    t('rest: DELETE unknown id -> 404', r.status === 404, r.status);

    r = await j(`/${added.fact.id}`, { method: 'DELETE' });
    const del = await r.json();
    t('rest: DELETE by id -> 200 deleted', r.status === 200 && del.ok && del.deleted, JSON.stringify(del));
    r = await j('/');
    const after = await r.json();
    t('rest: store reflects the deletion', after.count === 1, after.count);

    r = await j('/workspace');
    const ws0 = await r.json();
    t('rest-ws: GET workspace absent -> exists:false', ws0.ok && ws0.exists === false, JSON.stringify(ws0));

    r = await j('/workspace', { method: 'PUT', body: JSON.stringify({ content: '# REST notes\n- api docs' }) });
    const ws1 = await r.json();
    t('rest-ws: PUT saves MEMORY.md', r.status === 200 && ws1.ok && ws1.saved && ws1.bytes > 0, JSON.stringify(ws1));

    r = await j('/workspace');
    const ws2 = await r.json();
    t('rest-ws: GET returns saved content (round-trip)', r.status === 200 && ws2.ok && ws2.exists && ws2.content.includes('api docs') && ws2.bytes === ws1.bytes, JSON.stringify(ws2.content));

    r = await j('/workspace', { method: 'PUT', body: JSON.stringify({ content: 'z'.repeat(3000) }) });
    t('rest-ws: PUT over the 2000-char cap -> 413', r.status === 413, r.status);

    r = await j('/workspace', { method: 'DELETE' });
    const ws3 = await r.json();
    t('rest-ws: DELETE workspace cleared (NOT swallowed by /:id)', r.status === 200 && ws3.ok && ws3.cleared, JSON.stringify(ws3));
    t('rest-ws: file actually gone', fs.existsSync(path.join(WORK, 'workspaces', 'MEMORY.md')) === false);
    server.close();
  }

  const fails = results.filter((x) => x.startsWith('FAIL')).length;
  console.log(results.join('\n'));
  console.log(`\n${fails === 0 ? 'ALL' : fails + ' FAILED of'} ${results.length} memory checks passed`);
  try { fs.unlinkSync(DB); } catch { /* already removed */ }
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});