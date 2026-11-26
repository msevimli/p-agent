#!/usr/bin/env node
/**
 * browser-service-tests.js — real end-to-end nets for the headless-Chrome
 * automation service (services/browserService.js + routes/browser.js shape).
 *
 * Drives the SYSTEM Chrome (/usr/bin/google-chrome) through playwright-core
 * against a local stub site that mimics a Quant-Terminal-like target:
 *   - page with title, clickable button, console.log, a 404 resource
 *   - second page for navigate/reload/coordinate-drag
 *   - GET /api/drawings serving the chart-drawing contract
 *
 * Skips (exit 0) when no system Chrome is present.
 *
 * Run: node workspaces/scripts/browser-service-tests.js
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const bs = require(path.join(ROOT, 'services', 'browserService.js'));

const results = [];
const t = (name, cond, detail) => results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`);

const DRAWINGS_PAYLOAD = {
  symbol: 'SOL/USDT',
  timeframe: '30m',
  drawings: [
    { id: 'd1', tool: 'trendline', points: [{ time: 1700000000, price: 100.5 }, { t: 1700000600, p: 101.2 }], params: { color: '#ff0' } },
    { id: 'd2', tool: 'marker', points: [{ t: 1700000000, p: 100.0 }], params: { text: 'breakout' }, createdAt: 1700000000000 },
  ],
};

const INDEX = `<!doctype html><html><head><title>QT Stub</title></head><body>
  <button id="b" onclick="window.__clicked=(window.__clicked||0)+1">hit</button>
  <input id="inp" autocomplete="off" />
  <img src="/missing.png" />
  <script>
    console.log('hello-console');
    window.__moves = 0; window.__wheel = 0; window.__dbl = 0;
    window.__enter = 0; window.__esc = 0; window.__shortcut = 0; window.__keyLog = [];
    document.addEventListener('mousemove', function () { window.__moves++; });
    document.addEventListener('wheel', function () { window.__wheel++; });
    document.addEventListener('dblclick', function () { window.__dbl++; });
    document.getElementById('inp').addEventListener('keydown', function (e) {
      window.__keyLog.push(e.key + ':' + (e.ctrlKey ? 'C' : '') + (e.shiftKey ? 'S' : '') + (e.altKey ? 'A' : '') + (e.metaKey ? 'M' : ''));
      if (e.key === 'Enter') window.__enter++;
      if (e.key === 'Escape') { window.__esc++; this.value = ''; }
      if (e.key === 'a' && e.ctrlKey) window.__shortcut++;
    });
  </script>
</body></html>`;

const PAGE2 = `<!doctype html><html><head><title>Page Two</title></head><body>
  <div style="height:4000px"></div>
  <script>
    window.__dragPoints = 0;
    ['pointerdown','pointerup'].forEach(function (ev) {
      document.addEventListener(ev, function () { window.__dragPoints++; });
    });
  </script>
</body></html>`;

(async () => {
  if (!bs.chromeExists()) {
    console.log(`SKIP: system Chrome not found at ${bs.DEFAULT_CHROME}`);
    return;
  }
  const server = http.createServer((req, res) => {
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(INDEX); }
    else if (req.url === '/page2') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE2); }
    else if (req.url === '/api/drawings') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(DRAWINGS_PAYLOAD)); }
    else { res.writeHead(404); res.end('nope'); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    // 1. open session against the stub
    const op = await bs.openSession(base + '/');
    t('open: session created against stub', op.ok === true && !!op.session.id, op.error || JSON.stringify(op.session));
    const sid = op.ok ? op.session.id : null;
    const s = sid && bs.get(sid);
    t('open: page title captured', s && s.title === 'QT Stub', s && s.title);

    // 2. console + network capture
    await new Promise((r) => setTimeout(r, 400)); // let async events settle
    const st1 = sid && bs.sessionJSON(bs.get(sid));
    t('console: page console.log captured', st1 && st1.console.some((c) => c.includes('hello-console')), (st1.console || []).join(' | '));
    t('network: HTTP 404 captured as request failure', st1 && st1.requestFailures.some((r) => /HTTP 404/.test(r)), (st1.requestFailures || []).slice(-3).join(' | '));

    // 3. selector click + evaluate
    const ck = await bs.click(s, { selector: '#b' });
    const ev = await bs.evaluate(s, 'window.__clicked');
    t('click: selector click worked (window.__clicked)', ck.ok === true && ev.ok === true && ev.value === 1, JSON.stringify(ev));

    // 4. screenshot
    const shot = await bs.screenshot(s);
    t('screenshot: PNG magic bytes', shot.png && shot.png[0] === 0x89 && shot.png[1] === 0x50 && shot.png[2] === 0x4e && shot.png[3] === 0x47, `bytes=${shot.png && shot.png.length}`);
    t('screenshot: file persisted on disk', shot.file && fs.existsSync(shot.file) && fs.statSync(shot.file).size > 100, shot.file);

    // 5. drawings contract (from the target's /api/drawings)
    const dr = await bs.fetchDrawings(base + '/');
    t('drawings: endpoint reachable + normalized', dr.ok === true && dr.symbol === 'SOL/USDT' && dr.timeframe === '30m' && dr.count === 2, JSON.stringify({ ok: dr.ok, symbol: dr.symbol, tf: dr.timeframe, count: dr.count }));
    t('drawings: shape of first drawing', dr.ok && dr.drawings[0].tool === 'trendline' && Number.isFinite(dr.drawings[0].points[0].t) && Number.isFinite(dr.drawings[0].points[0].p), JSON.stringify(dr.ok && dr.drawings[0]));
    t('drawings: 404 target reports cleanly', (await bs.fetchDrawings('http://127.0.0.1:9')).ok === false);

    // 6. navigate + reload
    const nav = await bs.navigate(s, base + '/page2');
    t('navigate: new page title', nav.title === 'Page Two', nav.title);
    const rel = await bs.reload(s);
    t('reload: page reloaded (title retained)', rel.title === 'Page Two', rel.title);

    // 7. coordinate drag (chart-style drawing interaction)
    const dg = await bs.drag(s, { x1: 20, y1: 20, x2: 120, y2: 90 });
    const dgEv = await bs.evaluate(s, 'window.__dragPoints');
    t('drag: pointer down+up observed on canvas', dg.ok === true && dgEv.ok === true && dgEv.value === 2, JSON.stringify(dgEv));

    // 8. viewport sync (the pane's size drives the headless viewport)
    const vp = await bs.viewport(s, { width: 900, height: 600 });
    t('viewport: applied + returned', vp.ok === true && vp.width === 900 && vp.height === 600, JSON.stringify(vp));
    const dim = await bs.evaluate(s, '[window.innerWidth, window.innerHeight]');
    t('viewport: page inner size tracks the resize', JSON.stringify(dim.value) === '[900,600]', JSON.stringify(dim.value));
    t('viewport: sessionJSON carries viewport', bs.sessionJSON(bs.get(sid)).viewport.width === 900);

    // 9. wheel scroll via live input dispatch
    const wh = await bs.input(s, { type: 'wheel', deltaY: 600 });
    await new Promise((r) => setTimeout(r, 200));
    const sc = await bs.evaluate(s, 'window.scrollY');
    t('input: wheel scrolls the page', wh.ok === true && sc.ok === true && sc.value > 0, JSON.stringify(sc));

    // 10. input-based drag (down/move/up) — same events a user's pointer makes
    await bs.input(s, { type: 'down', x: 30, y: 30 });
    await bs.input(s, { type: 'move', x: 130, y: 100 });
    await bs.input(s, { type: 'up', x: 130, y: 100 });
    const dg2 = await bs.evaluate(s, 'window.__dragPoints');
    t('input: down/move/up counts as a drag', dg2.ok && dg2.value === 4, JSON.stringify(dg2));

    // 11. keyboard + pointer input against a fresh INDEX page
    await bs.navigate(s, base + '/');
    const r0 = await bs.evaluate(s, 'document.getElementById("inp").getBoundingClientRect()');
    const cx = r0.value.x + r0.value.width / 2;
    const cy = r0.value.y + r0.value.height / 2;
    await bs.input(s, { type: 'click', x: cx, y: cy });
    const af = await bs.evaluate(s, '(document.activeElement||{}).id');
    t('input: coordinate click focuses the input', af.ok === true && af.value === 'inp', JSON.stringify(af));

    await bs.input(s, { type: 'type', text: 'hi' });
    const val = await bs.evaluate(s, 'document.getElementById("inp").value');
    t('input: typed text reaches the field', val.ok === true && val.value === 'hi', JSON.stringify(val));

    await bs.input(s, { type: 'keydown', key: 'Enter', modifiers: [] });
    await bs.input(s, { type: 'keyup', key: 'Enter', modifiers: [] });
    const ent = await bs.evaluate(s, 'window.__enter');
    t('input: Enter keydown observed', ent.ok === true && ent.value === 1, JSON.stringify(ent));

    await bs.evaluate(s, '(document.getElementById("inp").value = "abc")');
    await bs.input(s, { type: 'keydown', key: 'Escape', modifiers: [] });
    await bs.input(s, { type: 'keyup', key: 'Escape', modifiers: [] });
    const esc = await bs.evaluate(s, '[window.__esc, document.getElementById("inp").value]');
    t('input: Escape observed + clears the field', esc.ok && esc.value[0] === 1 && esc.value[1] === '', JSON.stringify(esc.value));

    await bs.input(s, { type: 'keydown', key: 'a', modifiers: ['Control'] });
    await bs.input(s, { type: 'keyup', key: 'a', modifiers: ['Control'] });
    const sc2 = await bs.evaluate(s, 'window.__shortcut');
    t('input: Ctrl+A shortcut observed (modifiers held)', sc2.ok === true && sc2.value === 1, JSON.stringify(sc2));
    await bs.input(s, { type: 'keyup', key: 'Control', modifiers: [] });
    await bs.input(s, { type: 'keydown', key: 'a', modifiers: [] });
    await bs.input(s, { type: 'keyup', key: 'a', modifiers: [] });
    const kl = await bs.evaluate(s, 'window.__keyLog.slice(-1)');
    t('input: modifier released after keyup', kl.ok && kl.value[0] === 'a:', JSON.stringify(kl.value));

    await bs.input(s, { type: 'move', x: 50, y: 50 });
    const mv = await bs.evaluate(s, 'window.__moves');
    t('input: mouse move reaches the page', mv.ok === true && mv.value > 0, JSON.stringify(mv));

    await bs.input(s, { type: 'click', x: 10, y: 10, clickCount: 2 });
    const dbl = await bs.evaluate(s, 'window.__dbl');
    t('input: dblclick (clickCount 2) reaches the page', dbl.ok === true && dbl.value === 1, JSON.stringify(dbl));

    // 12. close + cleanup
    const cl = await bs.closeSession(sid);
    t('close: session removed', cl.ok === true && bs.list().length === 0);

    t('drawings: bad payload shape rejected', bs.normalizeDrawings({ drawings: 'nope' }) === null);
  } catch (e) {
    t('unexpected error', false, (e && e.stack) || String(e));
  } finally {
    await bs.closeAll();
    server.close();
  }

  const fails = results.filter((r) => r.startsWith('FAIL')).length;
  console.log(results.join('\n'));
  console.log(fails === 0 ? `\nALL ${results.length} PASSED` : `\n${fails} FAIL of ${results.length}`);
  process.exit(fails === 0 ? 0 : 1);
})();