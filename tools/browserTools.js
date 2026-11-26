/**
 * Browser automation tools — the agent's window into headless Chrome
 * (system /usr/bin/google-chrome via playwright-core). Built for UI
 * verification/e2e checks of local dashboards (Quant Terminal defaults to
 * http://127.0.0.1:3777): navigate, interact (clicks/drags on canvases),
 * screenshots, console/page/network diagnostics and the target's structured
 * chart-drawing state (/api/drawings contract).
 *
 * Every tool is a no-op-safe wrapper around services/browserService.
 */
'use strict';

const bs = require('../services/browserService');

function args(spec) {
  return Object.assign({
    type: 'object',
    properties: {},
    additionalProperties: false,
  }, spec);
}

const sessionRef = 'The id of an existing browser session (from browser_open or the dashboard Browser pane). Omit to reuse the most recent open session.';
const URL_PROP = (desc, def) => ({ type: 'string', description: desc + (def ? ` Defaults to ${def}.` : '') });

const tools = [
  {
    name: 'browser_open',
    description: 'Open a headless-Chrome browser session (system Google Chrome, no download). Default target http://127.0.0.1:3777 (Quant Terminal). Returns the session id, page title and URL — keep the id for later browser_* calls.',
    parameters: args({ properties: { url: URL_PROP('URL to open.', 'http://127.0.0.1:3777') } }),
    async execute({ url }) {
      const r = await bs.openSession(url);
      return r.ok ? { ok: true, sessionId: r.session.id, url: r.session.url, title: r.session.title } : { ok: false, error: r.error };
    },
  },
  {
    name: 'browser_navigate',
    description: 'Navigate an open browser session to a new URL (replaces the current page). Use to switch targets or after a code change.',
    parameters: args({ properties: { sessionId: { type: 'string', description: sessionRef }, url: { type: 'string', description: 'URL to load.' } } }),
    async execute({ sessionId, url }) {
      const s = bs.get(sessionId) || bs.list().slice(-1)[0] || null;
      if (!s) return { ok: false, error: 'no open browser session (call browser_open first or open the dashboard Browser pane)' };
      if (!url) return { ok: false, error: 'url is required' };
      try { const st = await bs.navigate(s, url); return { ok: true, title: st.title, url: st.url }; }
      catch (e) { return { ok: false, error: e.message }; }
    },
  },
  {
    name: 'browser_click',
    description: 'Click in the browser session: by CSS selector, or by viewport pixel {x, y} — pixel coordinates hit canvas charts/drawing tools without DOM hooks.',
    parameters: args({ properties: { sessionId: { type: 'string', description: sessionRef }, selector: { type: 'string', description: 'CSS selector, e.g. #toolbar .trendline-btn.' }, x: { type: 'number', description: 'Viewport x when clicking a canvas.' }, y: { type: 'number', description: 'Viewport y when clicking a canvas.' } } }),
    async execute(p) {
      const s = bs.get(p && p.sessionId) || bs.list().slice(-1)[0] || null;
      if (!s) return { ok: false, error: 'no open browser session' };
      const r = await bs.click(s, p || {});
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    },
  },
  {
    name: 'browser_drag',
    description: 'Drag on the page (mouse down at x1,y1, move to x2,y2, release) — for drawing tools, annotations and chart panning on canvas surfaces.',
    parameters: args({ properties: { sessionId: { type: 'string', description: sessionRef }, x1: { type: 'number', description: 'Start x.' }, y1: { type: 'number', description: 'Start y.' }, x2: { type: 'number', description: 'End x.' }, y2: { type: 'number', description: 'End y.' } } }),
    async execute(p) {
      const s = bs.get(p && p.sessionId) || bs.list().slice(-1)[0] || null;
      if (!s) return { ok: false, error: 'no open browser session' };
      const r = await bs.drag(s, p || {});
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    },
  },
  {
    name: 'browser_screenshot',
    description: 'Capture the current browser viewport as a PNG. Returns the saved file path (share it with the user) plus any console/page/network errors captured so far.',
    parameters: args({ properties: { sessionId: { type: 'string', description: sessionRef } } }),
    async execute(p) {
      const s = bs.get(p && p.sessionId) || bs.list().slice(-1)[0] || null;
      if (!s) return { ok: false, error: 'no open browser session' };
      try {
        const { file } = await bs.screenshot(s);
        const st = bs.sessionJSON(s);
        return { ok: true, path: file, url: st.url, title: st.title, consoleErrors: st.console.filter((c) => /error/i.test(c)), pageErrors: st.pageErrors, failedRequests: st.requestFailures.filter((r) => /HTTP [45]/.test(r) || true).slice(-10) };
      } catch (e) { return { ok: false, error: e.message }; }
    },
  },
  {
    name: 'browser_logs',
    description: 'Read console messages, page errors and failed/HTTP>=400 network requests collected from the browser session (diagnostics for e2e checks).',
    parameters: args({ properties: { sessionId: { type: 'string', description: sessionRef } } }),
    async execute(p) {
      const s = bs.get(p && p.sessionId) || bs.list().slice(-1)[0] || null;
      if (!s) return { ok: false, error: 'no open browser session' };
      const st = bs.sessionJSON(s);
      return { ok: true, console: st.console, pageErrors: st.pageErrors, requestFailures: st.requestFailures, url: st.url, title: st.title };
    },
  },
  {
    name: 'browser_drawings',
    description: 'Read the target chart\'s structured drawing/annotation state from its /api/drawings endpoint (Quant Terminal contract): shapes, markers, price/time coordinates, symbol and timeframe. Returns the normalized list the agent can reason over.',
    parameters: args({ properties: { sessionId: { type: 'string', description: sessionRef } } }),
    async execute(p) {
      const s = bs.get(p && p.sessionId) || bs.list().slice(-1)[0] || null;
      if (!s) return { ok: false, error: 'no open browser session' };
      const r = await bs.fetchDrawings(s.url);
      return r.ok ? { ok: true, source: r.source, symbol: r.symbol, timeframe: r.timeframe, count: r.count, drawings: r.drawings } : { ok: false, error: r.error };
    },
  },
];

module.exports = { tools };