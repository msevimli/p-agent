/**
 * /api/browser — headless Chrome session management for the dashboard.
 *
 * Drives the SYSTEM Chrome via services/browserService (playwright-core,
 * /usr/bin/google-chrome). The dashboard's split-screen browser pane and
 * the agent's browser_* tools share this REST surface.
 *
 * Endpoints:
 *   POST   /api/browser/session {url?}          -> create session (default http://127.0.0.1:3777)
 *   GET    /api/browser/sessions                -> list open sessions
 *   GET    /api/browser/session/:id             -> session state (url, title, console/page/network records)
 *   POST   /api/browser/session/:id/navigate {url}
 *   POST   /api/browser/session/:id/reload
 *   GET    /api/browser/session/:id/screenshot.png   -> fresh PNG (also saved to data/browser-shots/)
 *   POST   /api/browser/session/:id/click {selector} | {x, y}
 *   POST   /api/browser/session/:id/drag {x1, y1, x2, y2}
 *   POST   /api/browser/session/:id/evaluate {expression}
 *   GET    /api/browser/session/:id/drawings   -> target's /api/drawings, normalized
 *   DELETE /api/browser/session/:id
 *   DELETE /api/browser/sessions               -> close all + shut the browser
 */
'use strict';

const express = require('express');
const router = express.Router();
const bs = require('../services/browserService');

const ok = (res, data) => res.json({ ok: true, ...data });
const fail = (res, status, error) => res.status(status).json({ ok: false, error });

router.get('/sessions', (_req, res) => ok(res, { count: bs.list().length, sessions: bs.list() }));

router.post('/session', async (req, res) => {
  const url = req.body && typeof req.body.url === 'string' && req.body.url.trim() ? req.body.url.trim() : undefined;
  const r = await bs.openSession(url);
  if (!r.ok) return fail(res, 500, r.error);
  return ok(res, { session: r.session });
});

router.get('/session/:id', (req, res) => {
  const s = bs.get(req.params.id);
  if (!s) return fail(res, 404, 'no such browser session');
  return ok(res, { session: bs.sessionJSON(s) });
});

router.post('/session/:id/navigate', async (req, res) => {
  const s = bs.get(req.params.id);
  if (!s) return fail(res, 404, 'no such browser session');
  const url = req.body && typeof req.body.url === 'string' && req.body.url.trim() ? req.body.url.trim() : null;
  if (!url) return fail(res, 400, 'url is required');
  try {
    const state = await bs.navigate(s, url);
    return ok(res, { session: state });
  } catch (e) {
    return fail(res, 500, e && e.message ? e.message : String(e));
  }
});

router.post('/session/:id/reload', async (req, res) => {
  const s = bs.get(req.params.id);
  if (!s) return fail(res, 404, 'no such browser session');
  try {
    return ok(res, { session: await bs.reload(s) });
  } catch (e) {
    return fail(res, 500, e && e.message ? e.message : String(e));
  }
});

router.get('/session/:id/screenshot.png', async (req, res) => {
  const s = bs.get(req.params.id);
  if (!s) return fail(res, 404, 'no such browser session');
  try {
    const { png, file } = await bs.screenshot(s);
    res.set('content-type', 'image/png');
    res.set('x-screenshot-path', file || '');
    res.send(png);
  } catch (e) {
    return fail(res, 500, e && e.message ? e.message : String(e));
  }
});

router.post('/session/:id/click', async (req, res) => {
  const s = bs.get(req.params.id);
  if (!s) return fail(res, 404, 'no such browser session');
  const r = await bs.click(s, req.body || {});
  if (!r.ok) return fail(res, 400, r.error);
  return ok(res, { clicked: true });
});

router.post('/session/:id/drag', async (req, res) => {
  const s = bs.get(req.params.id);
  if (!s) return fail(res, 404, 'no such browser session');
  const r = await bs.drag(s, req.body || {});
  if (!r.ok) return fail(res, 400, r.error);
  return ok(res, { dragged: true });
});

router.post('/session/:id/evaluate', async (req, res) => {
  const s = bs.get(req.params.id);
  if (!s) return fail(res, 404, 'no such browser session');
  try {
    const r = await bs.evaluate(s, req.body && req.body.expression);
    if (!r.ok) return fail(res, 400, r.error);
    return ok(res, { value: r.value });
  } catch (e) {
    return fail(res, 500, e && e.message ? e.message : String(e));
  }
});

router.get('/session/:id/drawings', async (req, res) => {
  const s = bs.get(req.params.id);
  if (!s) return fail(res, 404, 'no such browser session');
  const r = await bs.fetchDrawings(s.url);
  return r.ok ? ok(res, { source: r.source, symbol: r.symbol, timeframe: r.timeframe, count: r.count, drawings: r.drawings }) : fail(res, 502, r.error);
});

router.delete('/session/:id', async (req, res) => {
  const r = await bs.closeSession(req.params.id);
  return r.ok ? ok(res, { closed: req.params.id }) : fail(res, 404, r.error);
});

router.delete('/sessions', async (_req, res) => {
  const r = await bs.closeAll();
  return ok(res, { closed: r.closed });
});

module.exports = router;