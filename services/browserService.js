/**
 * Headless browser automation for p-agent — drives the SYSTEM Chrome
 * (/usr/bin/google-chrome) via playwright-core. No bundled browser is ever
 * downloaded; the binary is resolved at launch time and may be overridden
 * with BROWSER_EXECUTABLE.
 *
 * Use cases:
 *   - agent-driven UI verification / e2e checks (Quant Terminal on
 *     http://127.0.0.1:3777 by default),
 *   - browser screenshot + console/page/network diagnostics,
 *   - reading the target's structured chart-drawing state via its
 *     /api/drawings endpoint (contract documented in the README).
 *
 * Sessions are long-lived pages on one shared browser instance; each
 * session keeps a bounded ring of console/page/network error records that
 * the API and tools can return.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_CHROME = process.env.BROWSER_EXECUTABLE || '/usr/bin/google-chrome';
const DEFAULT_URL = process.env.BROWSER_DEFAULT_URL || 'http://127.0.0.1:3777';
const MAX_RECORDS = 200;

let playwright = null;
let browser = null;
let launchAttempted = false;
const sessions = new Map(); // id -> session
let seq = 0;

function chromeExists() {
  try {
    return fs.existsSync(DEFAULT_CHROME);
  } catch {
    return false;
  }
}

async function getPlaywright() {
  if (playwright) return playwright;
  playwright = require('playwright-core');
  return playwright;
}

/** Launch the shared browser (lazily, once). Returns null on failure. */
async function ensureBrowser() {
  if (browser) return browser;
  if (launchAttempted) return null;
  launchAttempted = true;
  try {
    const pw = await getPlaywright();
    browser = await pw.chromium.launch({
      executablePath: DEFAULT_CHROME,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    return browser;
  } catch (e) {
    console.error(`[browser] launch failed: ${e && e.message ? e.message : e}`);
    return null;
  }
}

/** Shots land in <dataDir>/browser-shots; returned to callers as paths. */
function shotDir() {
  const dir = path.join(__dirname, '..', 'data', 'browser-shots');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* read-only etc. */ }
  return dir;
}

function record(arr, entry) {
  arr.push(entry);
  if (arr.length > MAX_RECORDS) arr.splice(0, arr.length - MAX_RECORDS);
}

function sessionJSON(s) {
  return {
    id: s.id,
    url: s.url,
    title: s.title || '',
    state: s.closed ? 'closed' : 'open',
    createdAt: s.createdAt,
    lastActive: s.sourceLastActive,
    console: s.console.slice(-50),
    pageErrors: [...s.pageErrors],
    requestFailures: s.requestFailures.slice(-50),
  };
}

/** Open a new session (default URL when none given). */
async function openSession(url) {
  const target = typeof url === 'string' && url.trim() ? url.trim() : DEFAULT_URL;
  const b = await ensureBrowser();
  if (!b) return { ok: false, error: `chrome binary not usable at ${DEFAULT_CHROME} (set BROWSER_EXECUTABLE to override)` };
  try {
    const page = await b.newPage();
    const id = `b${++seq}`;
    const s = {
      id, page, url: target, title: '', closed: false,
      createdAt: Date.now(), sourceLastActive: Date.now(),
      console: [], pageErrors: [], requestFailures: [], drawings: null, drawingsError: null,
    };
    page.on('console', (msg) => {
      s.sourceLastActive = Date.now();
      record(s.console, `[${msg.type()}] ${msg.text()}`);
    });
    page.on('pageerror', (err) => {
      s.sourceLastActive = Date.now();
      s.pageErrors.push(String((err && err.message) || err).slice(0, 500));
    });
    page.on('requestfailed', (req) => {
      s.sourceLastActive = Date.now();
      const f = req.failure && req.failure();
      record(s.requestFailures, `${req.method()} ${req.url()} -> ${f ? f.errorText : 'failed'}`);
    });
    page.on('response', (res) => {
      if (res.status() >= 400) {
        s.sourceLastActive = Date.now();
        record(s.requestFailures, `HTTP ${res.status()} ${res.url()}`);
      }
    });
    sessions.set(id, s);
    await navigate(s, target);
    return { ok: true, session: sessionJSON(s) };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

async function navigate(s, url) {
  s.url = url;
  try {
    await s.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    s.title = await s.page.title().catch(() => '');
  } catch (e) {
    s.title = await s.page.title().catch(() => '');
    s.pageErrors.push(`navigate: ${(e && e.message || String(e)).slice(0, 400)}`);
  }
  s.sourceLastActive = Date.now();
  return sessionJSON(s);
}

async function reload(s) {
  await s.page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch((e) => {
    s.pageErrors.push(`reload: ${(e && e.message || String(e)).slice(0, 400)}`);
  });
  s.title = await s.page.title().catch(() => '');
  s.sourceLastActive = Date.now();
  return sessionJSON(s);
}

/** PNG buffer + saved file path. */
async function screenshot(s) {
  const png = await s.page.screenshot({ type: 'png' });
  const file = path.join(shotDir(), `${s.id}-${Date.now()}.png`);
  try { fs.writeFileSync(file, png); } catch { /* still return the buffer */ }
  return { png, file };
}

async function click(s, args) {
  const { selector, x, y } = args || {};
  if (typeof selector === 'string' && selector) {
    await s.page.click(selector, { timeout: 8000 });
  } else if (Number.isFinite(x) && Number.isFinite(y)) {
    await s.page.mouse.click(x, y);
  } else {
    return { ok: false, error: 'click needs a selector or {x, y} coordinates' };
  }
  s.sourceLastActive = Date.now();
  return { ok: true };
}

async function drag(s, args) {
  const { x1, y1, x2, y2 } = args || {};
  if (![x1, y1, x2, y2].every(Number.isFinite)) {
    return { ok: false, error: 'drag needs x1,y1,x2,y2 coordinates' };
  }
  await s.page.mouse.move(x1, y1);
  await s.page.mouse.down();
  await s.page.mouse.move(x2, y2, { steps: 12 });
  await s.page.mouse.up();
  s.sourceLastActive = Date.now();
  return { ok: true };
}

async function evaluate(s, expression) {
  if (typeof expression !== 'string' || !expression.trim()) {
    return { ok: false, error: 'evaluate needs a JS expression string' };
  }
  const value = await s.page.evaluate((expr) => {
    // eslint-disable-next-line no-new-func
    return Function('"use strict"; return (' + expr + ');')();
  }, expression);
  return { ok: true, value: value === undefined ? null : value };
}

/**
 * Read the target's structured chart-drawing state (contract described in
 * the README's "Chart drawings & annotations" section): GET <origin>/api/drawings
 * -> { symbol?, timeframe?, drawings: [{id, tool, points:[{t,p}|{time,price}],
 * params:{...}}] }. Tolerant normalization — unknown fields are kept under
 * `params`, missing coordinates are preserved as-is so the structure is
 * always usable by the agent.
 */
const DRAWING_TOOLS = new Set(['trendline', 'hline', 'vline', 'ray', 'rect', 'fib', 'text', 'marker', 'zone', 'regression']);

function normalizeDrawings(payload) {
  const raw = payload && payload.drawings !== undefined ? payload.drawings : payload;
  if (!Array.isArray(raw)) return null;
  const drawings = raw.map((d, i) => {
    const points = Array.isArray(d.points) ? d.points.map((pt) => {
      const p = {};
      if (Number.isFinite(pt.t)) p.t = pt.t;
      if (Number.isFinite(pt.time)) p.t = pt.time;
      if (Number.isFinite(pt.p)) p.p = pt.p;
      if (Number.isFinite(pt.price)) p.p = pt.price;
      if (Number.isFinite(pt.x)) p.x = pt.x;
      if (Number.isFinite(pt.y)) p.y = pt.y;
      return p;
    }) : [];
    return {
      id: String(d.id || `d-${i + 1}`),
      tool: DRAWING_TOOLS.has(String(d.tool || '').toLowerCase()) ? String(d.tool).toLowerCase() : String(d.tool || 'unknown'),
      symbol: d.symbol !== undefined ? String(d.symbol) : undefined,
      timeframe: d.timeframe !== undefined ? String(d.timeframe) : undefined,
      points,
      params: (d.params && typeof d.params === 'object') ? d.params : {},
      createdAt: Number.isFinite(d.createdAt) ? d.createdAt : undefined,
    };
  }).filter((d) => d.points.length > 0 || d.tool !== 'unknown');
  return {
    symbol: payload && payload.symbol !== undefined ? String(payload.symbol) : undefined,
    timeframe: payload && payload.timeframe !== undefined ? String(payload.timeframe) : undefined,
    count: drawings.length,
    drawings,
  };
}

async function fetchDrawings(targetUrl) {
  let origin = targetUrl;
  try { origin = new URL(targetUrl).origin; } catch { /* keep raw */ }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(`${origin}/api/drawings`, { signal: controller.signal });
    if (res.status === 404) return { ok: false, error: `no /api/drawings endpoint at ${origin} (404)` };
    if (!res.ok) return { ok: false, error: `GET ${origin}/api/drawings -> HTTP ${res.status}` };
    const ct = String(res.headers.get('content-type') || '');
    if (!ct.includes('application/json')) {
      return { ok: false, error: `GET ${origin}/api/drawings returned ${ct || 'non-JSON'} content — is the target exposing the drawings API?` };
    }
    const data = await res.json();
    const normalized = normalizeDrawings(data);
    if (!normalized) return { ok: false, error: 'drawings payload did not match the expected shape ({drawings: [...]})' };
    return { ok: true, source: origin, ...normalized };
  } catch (e) {
    return { ok: false, error: `could not reach ${origin}/api/drawings: ${e && e.message ? e.message : e}` };
  } finally {
    clearTimeout(timer);
  }
}

async function closeSession(id) {
  const s = sessions.get(id);
  if (!s) return { ok: false, error: 'no such session' };
  try { await s.page.close(); } catch { /* already gone */ }
  s.closed = true;
  sessions.delete(id);
  return { ok: true };
}

async function closeAll() {
  const ids = [...sessions.keys()];
  for (const id of ids) await closeSession(id);
  if (browser) {
    try { await browser.close(); } catch { /* ignore */ }
    browser = null;
    launchAttempted = false;
  }
  return { ok: true, closed: ids.length };
}

function list() {
  return [...sessions.values()].map(sessionJSON);
}

function get(id) {
  const s = sessions.get(id);
  return s && !s.closed ? s : null;
}

module.exports = {
  DEFAULT_CHROME, DEFAULT_URL, chromeExists,
  openSession, navigate, reload, screenshot, click, drag, evaluate,
  fetchDrawings, normalizeDrawings, closeSession, closeAll, list, get, sessionJSON,
};