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
  <button id="b" onclick="window.__clicked=1">hit</button>
  <img src="/missing.png" />
  <script>console.log('hello-console');</script>
</body></html>`;

const PAGE2 = `<!doctype html><html><head><title>Page Two</title></head><body>
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

    // 8. close + cleanup
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