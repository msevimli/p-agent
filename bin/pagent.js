#!/usr/bin/env node
/**
 * bin/pagent.js — terminal CLI for the p-agent agent framework.
 *
 *   pagent                 interactive REPL chat (same agent pipeline as the
 *                          dashboard & Telegram, via the local server)
 *   pagent chat [text]     one-shot message (omitted text opens the REPL)
 *   pagent sessions        list sessions (browser, Telegram, CLI)
 *   pagent models [id]     list models / activate one
 *   pagent channels [on|off]  Telegram channel status / toggle
 *   pagent config [set KEY=value]  view effective config / set .env values
 *
 * Server-first: chat (and any state WRITE) talks to the running server at
 * http://127.0.0.1:8888 (override with PAGENT_BASE_URL). Read-only commands
 * degrade gracefully to the local state files (data/*) when the server is
 * down, so the CLI stays useful headless/offline. Secrets are never printed —
 * only presence indicators.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const readline = require('readline');

const ROOT = path.join(__dirname, '..');
const config = require('../config');
const sessionStore = require('../services/sessionStore');

const BASE_URL = process.env.PAGENT_BASE_URL || `http://127.0.0.1:${config.port}`;
const STATE_FILE = path.join(config.dataDir, 'channels-state.json');
const MODELS_FILE = path.join(config.dataDir, 'models-state.json');
const LIBRARY_INDEX = path.join(config.dataDir, 'library-index.json');
const ENV_FILE = config.dotEnvFile;
const SESSION_META = '⌨ via CLI';
const MAX_HISTORY = 40; // messages replayed from the CLI session

// ------------------------------------------------------------------- colors
const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};
// Colors are noise when stdout is piped; keep the plain text for scripts.
const USE_COLOR = process.stdout.isTTY === true;
const paint = (fn, s) => (USE_COLOR ? fn(s) : s);

// Piping into `head`/closure of a downstream pipe must not crash the CLI.
process.stdout.on('error', (e) => {
  if (e && e.code === 'EPIPE') process.exit(0);
  throw e;
});

// ------------------------------------------------------------------ parsing
function parseArgs(argv) {
  const args = [...(argv || [])];
  let command = 'chat';
  const positional = [];
  const opts = { json: false, message: null, help: false };
  let i = 0;
  const first = args[0] && !args[0].startsWith('-') ? args[0] : null;
  if (first) {
    if (['chat', 'sessions', 'models', 'channels', 'config', 'help'].includes(first)) {
      command = first;
      i = 1;
    } else {
      positional.push(first); // bare text on `pagent "message"` → one-shot chat
      i = 1;
    }
  }
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') opts.json = true;
    else if (a === '-m' || a === '--message') opts.message = args[++i] || '';
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (!a.startsWith('-')) positional.push(a);
  }
  if (command === 'chat' && opts.message) positional.unshift(opts.message);
  return { command, positional, opts };
}

// ------------------------------------------------------------------- network
function request(method, urlPath, body, { timeoutMs = 15000, onData } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const u = new URL(urlPath, BASE_URL.endsWith('/') ? BASE_URL : BASE_URL + '/');
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        if (res.statusCode >= 400) {
          let errBody = '';
          res.on('data', (c) => (errBody += c));
          res.on('end', () => reject(new Error(`HTTP ${res.statusCode} ${urlPath}${errBody ? ` — ${errBody.slice(0, 160)}` : ''}`)));
          return;
        }
        if (onData) return resolve({ res, req }); // streaming mode — caller owns it
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          try { resolve(JSON.parse(buf)); } catch { resolve(buf); }
        });
        res.on('error', reject);
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    if (payload) req.end(payload);
    else req.end();
  });
}

const getJson = (p) => request('GET', p);
const postJson = (p, b) => request('POST', p, b);

/** Cheap liveness probe of the local server. */
async function serverUp() {
  try { await getJson('/api/health'); return true; } catch { return false; }
}

// ------------------------------------------------------------- state files
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function modelsFromFile() {
  const st = readJson(MODELS_FILE, {});
  return { models: st.models || [], activeId: st.activeId || null };
}

function sessionsFromFile() {
  const s = readJson(config.sessionsFile, []);
  return Array.isArray(s) ? s : [];
}

function channelsFromFile() {
  const st = readJson(STATE_FILE, {});
  const env = (() => {
    try {
      const raw = fs.readFileSync(ENV_FILE, 'utf8');
      return /^TELEGRAM_BOT_TOKEN=(\S+)/m.test(raw);
    } catch { return false; }
  })();
  return {
    type: 'telegram',
    enabled: !!st.enabled,
    running: !!st.running,
    tokenSet: env,
    allowedChatIds: st.allowedChatIds || [],
    lastError: st.lastError || null,
    lastActivityAt: st.lastActivityAt || null,
  };
}

function maskKeyName(k) {
  return /TOKEN|KEY|SECRET|PASSWORD/i.test(k) ? `${k}=<set>` : null;
}

function dotEnvKeys() {
  try {
    const raw = fs.readFileSync(ENV_FILE, 'utf8');
    return raw.split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => l.split('=')[0].trim())
      .filter((k) => /^[A-Z0-9_]+$/.test(k));
  } catch { return []; }
}

/** Upsert KEY=VALUE into the .env file (writeDotEnvVar semantics, safe). */
function dotEnvSet(key, value) {
  if (!/^[A-Z0-9_]{2,64}$/.test(key)) throw new Error(`invalid key name '${key}' (use UPPER_SNAKE)`);
  let raw = '';
  try { raw = fs.readFileSync(ENV_FILE, 'utf8'); } catch { raw = ''; }
  const re = new RegExp(`^${key}=.*$`, 'm');
  const line = `${key}=${value}`;
  fs.writeFileSync(ENV_FILE, re.test(raw) ? raw.replace(re, line) : `${raw.replace(/\n*$/, '')}\n${line}\n`);
}

// ------------------------------------------------------------------ display
function relTime(iso) {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return String(iso).slice(0, 19).replace('T', ' ');
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function fmtBytes(n) {
  n = Number(n) || 0;
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

// --------------------------------------------------------------- subcommands
const HELP = `
${paint(C.bold, 'pagent')} — p-agent terminal client (server: ${BASE_URL})

  pagent                    interactive chat (REPL)
  pagent chat [text]        one-shot message; no text opens the REPL
  pagent sessions [--json]  list sessions (browser, Telegram, CLI)
  pagent models [--json]    list models, * = active
  pagent models <id>        activate a model
  pagent channels [--json]  Telegram channel status
  pagent channels on|off    enable/disable the Telegram channel (server)
  pagent config             effective configuration + .env keys (masked)
  pagent config set KEY=value   set an .env value (e.g. LLAMA_MAX_TOKENS=4096)
  pagent help               this help

REPL commands: /help  /exit  /quit  /new [name]  /attach [name|id]  /model <id>
Ctrl+C once aborts the running generation, twice exits.
`;

async function cmdHelp() { process.stdout.write(HELP); }

async function cmdSessions(_positional, opts) {
  let sessions = null;
  try { sessions = await getJson('/api/sessions'); } catch { sessions = null; }
  if (!Array.isArray(sessions)) sessions = sessionsFromFile();
  const norm = sessions
    .map((s) => ({
      id: s.id || '?',
      title: s.title || '(untitled)',
      count: Array.isArray(s.messages) ? s.messages.length : 0,
      updatedAt: s.updatedAt || s.createdAt || null,
    }))
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  if (opts.json) return process.stdout.write(JSON.stringify(norm, null, 2) + '\n');
  if (!norm.length) return process.stdout.write(paint(C.dim, 'no sessions yet\n'));
  for (const s of norm) {
    process.stdout.write(
      `${relTime(s.updatedAt).padEnd(9)} ${String(s.count).padStart(3)} msg  ${paint(C.cyan, s.id)}  ${s.title.slice(0, 60)}\n`
    );
  }
}

async function cmdModels(positional, opts) {
  if (positional.length) {
    const id = positional[0];
    try {
      const res = await postJson(`/api/models/${encodeURIComponent(id)}/activate`, {});
      const m = res && res.model;
      process.stdout.write(
        `✓ active model: ${paint(C.green, (m && (m.id || m.name)) || id)}${res.ok ? '' : ' (unexpected response)'}\n`
      );
    } catch (e) {
      // Server down: switch the persisted activeId directly.
      const st = readJson(MODELS_FILE, null);
      if (!st || !Array.isArray(st.models)) throw new Error('cannot load models-state.json — no fallback possible');
      if (!st.models.some((m) => m.id === id)) throw new Error(`unknown model '${id}' (server is down; available: ${st.models.map((m) => m.id).join(', ')})`);
      st.activeId = id;
      fs.writeFileSync(MODELS_FILE, JSON.stringify(st, null, 2) + '\n');
      process.stdout.write(paint(C.yellow, `⚠ server is down — persisted activeId='${id}' in data/models-state.json (takes effect on server start)\n`));
    }
    return;
  }
  let data = null;
  try { data = await getJson('/api/models'); } catch { data = null; }
  let models = [], activeId = null;
  if (data && Array.isArray(data.models)) {
    models = data.models;
    // the server may mark the active model per-entry (m.active) or expose a
    // top-level activeId — honor both shapes
    activeId = data.activeId || (models.find((m) => m && m.active === true) || {}).id || null;
  } else {
    const f = modelsFromFile();
    models = f.models;
    activeId = f.activeId;
  }
  if (opts.json) {
    return process.stdout.write(JSON.stringify({ activeId, models }, null, 2) + '\n');
  }
  if (!models.length) return process.stdout.write(paint(C.dim, 'no models configured\n'));
  for (const m of models) {
    const tag = m.id === activeId ? paint(C.green, '*') : ' ';
    const key = m.hasKey ? '' : paint(C.dim, ' (no key)');
    process.stdout.write(` ${tag} ${paint(C.cyan, String(m.id).padEnd(18))} ${(m.name || '?').padEnd(28)} ${(m.provider || '?').padEnd(11)} ${m.model || ''}${key}\n`);
  }
}

async function cmdChannels(positional, opts) {
  if (positional.length) {
    const on = /^on$/i.test(positional[0]) ? true : /^off$/i.test(positional[0]) ? false : null;
    if (on === null) throw new Error(`expected 'on' or 'off', got '${positional[0]}'`);
    try {
      const res = await postJson('/api/channels/telegram/toggle', { enabled: on });
      process.stdout.write(`✓ telegram channel ${res.enabled ? paint(C.green, 'enabled') : paint(C.dim, 'disabled')} (running: ${!!res.running})\n`);
    } catch (e) {
      throw new Error(`cannot toggle while the server is down (${e.message}) — start it with 'node server.js'`);
    }
    return;
  }
  let ch = null;
  try {
    const res = await getJson('/api/channels');
    ch = res && Array.isArray(res.channels) ? res.channels[0] : null;
  } catch { ch = null; }
  if (!ch) ch = channelsFromFile();
  const status = ch.enabled ? paint(C.green, 'on') : paint(C.dim, 'off');
  const running = ch.running ? paint(C.green, 'polling') : paint(C.dim, 'stopped');
  const token = ch.tokenSet ? paint(C.green, 'set') : paint(C.yellow, 'NOT SET');
  const ids = Array.isArray(ch.allowedChatIds) ? ch.allowedChatIds.join(', ') || paint(C.dim, '(none)') : paint(C.dim, '(none)');
  const err = ch.lastError ? `  lastError: ${paint(C.red, String(ch.lastError).slice(0, 120))}\n` : '';
  const out = {
    type: ch.type || 'telegram', enabled: !!ch.enabled, running: !!ch.running,
    tokenSet: !!ch.tokenSet, allowedChatIds: ch.allowedChatIds || [],
    lastError: ch.lastError || null, lastActivityAt: ch.lastActivityAt || null,
  };
  if (opts.json) return process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  process.stdout.write(
    `${(ch.name || 'Telegram')}: ${status} · ${running} · token ${token} · chats ${ids}\n` +
    (ch.lastActivityAt ? `  last activity: ${relTime(ch.lastActivityAt)}\n` : '') + err
  );
}

async function cmdConfig(positional) {
  const c = config;
  const lines = [
    `server port ........... ${c.port}`,
    `work root ............. ${c.workRoot}`,
    `data dir .............. ${c.dataDir}`,
    `active model .......... ${modelsFromFile().activeId || '(none)'}`,
    `tool calling .......... ${c.toolCallingEnabled ? 'on' : 'off'} (max ${c.toolMaxIterations} iters)`,
    `queue ................. limit ${c.queueLimit}, retries ${c.queueRetries}`,
    `max tokens/call ....... ${c.llamaMaxTokens} (continuation ${c.continuationMaxRounds} rounds)`,
    `sse heartbeat ......... ${c.sseHeartbeatMs} ms`,
    `library uploads ....... up to ${c.libraryMaxUploadBytes / 1048576} MB`,
    `telegram .............. poll ${c.telegramPollTimeoutSec}s, req timeout ${c.telegramRequestTimeoutMs}ms, max reply ${c.telegramMaxReplyChars} chars`,
    `env file .............. ${ENV_FILE}`,
  ];
  if (positional[0] === 'set') {
    const kv = positional[1] || '';
    const eq = kv.indexOf('=');
    if (eq <= 0) throw new Error('usage: pagent config set KEY=value');
    const key = kv.slice(0, eq).trim();
    const value = kv.slice(eq + 1).trim();
    if (!value) throw new Error('empty value — refusing to set a blank secret');
    dotEnvSet(key, value);
    const masked = /TOKEN|KEY|SECRET/i.test(key) ? '<set (value hidden)>' : `'${value.slice(0, 80)}'`;
    process.stdout.write(`✓ ${key}=${masked} (${ENV_FILE})\n`);
    return;
  }
  const keys = dotEnvKeys();
  process.stdout.write(lines.join('\n') + '\n');
  const visible = keys.map(maskKeyName).filter(Boolean);
  if (keys.length) {
    process.stdout.write(`.env keys: ${keys.length} total (${visible.map((v) => v.split('=')[0]).join(', ')}${visible.length ? ' = <set>' : ''})\n`);
  } else {
    process.stdout.write('.env keys: none\n');
  }
}

// --------------------------------------------------------------------- chat
// The in-flight /api/chat request (for Ctrl+C aborts in the REPL).
let activeReq = null;

function streamChat(messages, opts) {
  const { onStatus, onDelta, onUsage, onDone, onError, attachments } = opts || {};
  const payload = {
    messages,
    stream: true,
    generation: { temperature: 0.4, top_p: 0.95, max_tokens: 2048 },
  };
  if (Array.isArray(attachments) && attachments.length) payload.attachments = attachments;
  const body = JSON.stringify(payload);
  const u = new URL('/api/chat', BASE_URL.endsWith('/') ? BASE_URL : BASE_URL + '/');
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: u.hostname, port: u.port, path: u.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let buf = '';
        let full = '';
        let lastUsage = null;
        res.setEncoding('utf8');
        const releaseReq = () => { if (activeReq === req) activeReq = null; };
        res.on('data', (chunk) => {
          buf += chunk;
          let idx;
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            try {
              const j = JSON.parse(data);
              if (j.type === 'status') { if (onStatus) onStatus(j.message); continue; }
              const d = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
              if (d) { full += d; if (onDelta) onDelta(d); }
              if (j.usage) { lastUsage = j.usage; if (onUsage) onUsage(j.usage); }
            } catch { /* partial frame */ }
          }
        });
        res.on('end', () => { releaseReq(); if (onDone) onDone(lastUsage); resolve(full); });
        res.on('error', (e) => { releaseReq(); if (onError) onError(e); reject(e); });
      }
    );
    req.setTimeout(11 * 60 * 1000, () => req.destroy(new Error('agent request timed out')));
    req.on('error', (e) => { releaseReq(); if (onError) onError(e); reject(e); });
    activeReq = req;
    req.end(body);
  });
}

/** Load the CLI session (create on demand), returning the live array. */
function loadCliSession(id, firstText) {
  const sessions = sessionStore.load();
  let session = sessions.find((s) => s && s.id === id);
  const now = new Date().toISOString();
  if (!session) {
    session = {
      id,
      title: String(firstText || '').slice(0, 60) || 'Terminal chat',
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    sessions.unshift(session);
  }
  return { sessions, session };
}

function persistCliSession(sessions, session) {
  session.updatedAt = new Date().toISOString();
  try { sessionStore.save(sessions); } catch (e) { /* non-fatal */ }
}

/** Append a user/assistant exchange to the session. */
function recordExchange(id, userContent, answer, attachments) {
  const { sessions, session } = loadCliSession(id, userContent);
  const userMsg = {
    role: 'user',
    content: attachments && attachments.length
      ? userContent + `\n\n[attached] ${attachments.map((a) => a.name).join(', ')}`
      : userContent,
  };
  session.messages.push(userMsg, { role: 'assistant', content: answer || '⚠ (no answer)', meta: SESSION_META });
  persistCliSession(sessions, session);
}

function resolveAttachments(term) {
  const idx = readJson(LIBRARY_INDEX, { files: [] });
  const files = Array.isArray(idx) ? idx : idx.files || [];
  if (files.length === 0) return { list: [], hint: paint(C.dim, 'library is empty') };
  if (!term) {
    return { list: files.map((f) => ({ id: f.id, name: f.name, size: f.size })), hint: `${paint(C.cyan, files.length)} files — use /attach <name or id>` };
  }
  const t = term.toLowerCase();
  const hit = files.find((f) => String(f.id).startsWith(term) || (f.name || '').toLowerCase().includes(t));
  if (!hit) return { list: [], hint: paint(C.yellow, `no library file matches '${term}' (see /attach for the list)`) };
  return { list: [{ id: hit.id, name: hit.name, size: hit.size }], hint: null };
}

// Set when the user aborts with Ctrl+C; suppresses error noise + recording.
let abortRequested = false;

/** Run one exchange; returns the assistant text. */
async function runExchange({ sessionId, text, attachments, print = true }) {
  if (!text || !text.trim()) return '';
  abortRequested = false;
  const { session } = loadCliSession(sessionId, text);
  const history = session.messages.slice(-MAX_HISTORY);
  const started = Date.now();
  let answer = '';
  try {
    answer = await streamChat([...history, { role: 'user', content: text }], {
      attachments: (attachments || []).map((a) => ({ id: a.id })),
      onStatus: (st) => process.stdout.write(paint(C.yellow, st) + '\n'),
      onDelta: (d) => { if (print) process.stdout.write(d); },
    });
  } catch (e) {
    if (abortRequested) { abortRequested = false; return ''; }
    const m = String((e && e.message) || e);
    process.stdout.write(paint(C.red, `⚠ ${m.slice(0, 300)}\n`));
    recordExchange(sessionId, text, `⚠ request failed: ${m.slice(0, 300)}`, attachments);
    return '';
  }
  if (print) process.stdout.write('\n');
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (print && answer) process.stdout.write(paint(C.dim, `⚡ ${secs}s · ${answer.split(/\s+/).filter(Boolean).length} words\n`));
  recordExchange(sessionId, text, answer, attachments);
  return answer;
}

const REPL_HELP = `
commands:
  /help               this help
  /exit, /quit        leave the CLI
  /new [name]         start a fresh session
  /attach [name|id]   attach a library file to the next message (list if blank)
  /model <id>         switch the active model
`;

async function repl() {
  const state = { sessionId: 'cli', attachments: [], busy: false };
  const up = await serverUp();
  process.stdout.write(
    paint(C.bold, `pagent — p-agent terminal client\n`) +
    `server: ${up ? paint(C.green, BASE_URL) : paint(C.red, `${BASE_URL} (DOWN — start it with 'node server.js')`)}\n` +
    `session: ${paint(C.cyan, state.sessionId)} · model: ${modelsFromFile().activeId || '?'}\n` +
    `type /help for commands, /exit to quit\n\n`
  );
  if (!up) process.stdout.write(paint(C.yellow, '⚠ chat requires the server; read-only commands still work\n'));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
  rl.setPrompt(paint(C.green, 'You> '));
  rl.prompt();

  rl.on('SIGINT', () => {
    if (state.busy) { // first Ctrl+C aborts the running generation
      process.stdout.write('\n' + paint(C.yellow, '⏹ aborting… (Ctrl+C again to exit)\n'));
      abortRequested = true;
      if (activeReq) activeReq.destroy();
      return;
    }
    process.stdout.write('\n');
    process.exit(0);
  });
  rl.on('close', () => {
    // Piped input closes stdin immediately after the last line — never exit
    // mid-stream; let the in-flight exchange (chain) finish first.
    const p = state.chain || Promise.resolve();
    Promise.resolve(p).then(() => process.exit(0), () => process.exit(0));
  });

  async function handle(line) {
    const t = (line || '').trim();
    if (!t) { rl.prompt(); return; }
    if (t.startsWith('/')) {
      const [cmd, ...rest] = t.split(/\s+/);
      const arg = rest.join(' ');
      if (cmd === '/exit' || cmd === '/quit') {
        // let any in-flight exchange finish before closing (piped input sends
        // /exit while the previous line is still streaming)
        (state.chain || Promise.resolve()).then(() => rl.close());
        return;
      }
      if (cmd === '/help') process.stdout.write(REPL_HELP + '\n');
      else if (cmd === '/new') {
        state.sessionId = arg || `cli-${Date.now().toString(36)}`;
        state.attachments = [];
        process.stdout.write(`✓ new session ${paint(C.cyan, state.sessionId)}\n`);
      } else if (cmd === '/attach') {
        const r = resolveAttachments(arg || '');
        if (arg) {
          if (r.list.length) {
            state.attachments = r.list;
            process.stdout.write(`✓ attached: ${r.list.map((f) => f.name).join(', ')} (${paint(C.dim, 'sent with the next message')})\n`);
          } else process.stdout.write((r.hint || '') + '\n');
        } else {
          process.stdout.write((r.hint || '') + '\n');
          for (const f of r.list) process.stdout.write(`  ${paint(C.cyan, f.id.slice(0, 8))}  ${f.name}  ${paint(C.dim, fmtBytes(f.size))}\n`);
        }
      } else if (cmd === '/model') {
        if (!arg) process.stdout.write(paint(C.yellow, 'usage: /model <id> (see `pagent models`)\n'));
        else {
          try {
            const res = await postJson(`/api/models/${encodeURIComponent(arg)}/activate`, {});
            process.stdout.write(`✓ active model: ${(res && res.model && res.model.id) || arg}\n`);
          } catch (e) { process.stdout.write(paint(C.red, `✗ ${String((e && e.message) || e).slice(0, 200)}\n`)); }
        }
      } else process.stdout.write(paint(C.yellow, `unknown command '${cmd}' — try /help\n`));
      rl.prompt();
      return;
    }
    // Serialize exchanges: lines typed while one is running are queued and
    // processed in order, so nothing is dropped on piped input.
    state.chain = (state.chain || Promise.resolve()).then(async () => {
      state.busy = true;
      try {
        const att = state.attachments;
        state.attachments = [];
        await runExchange({ sessionId: state.sessionId, text: t, attachments: att });
      } finally {
        state.busy = false;
        rl.prompt();
      }
    }).catch(() => { state.busy = false; rl.prompt(); });
  }

  rl.on('line', (line) => handle(line));
}

async function oneShot(text) {
  const up = await serverUp();
  if (!up) throw new Error(`server not reachable at ${BASE_URL} — start it with 'node server.js' in ${ROOT}`);
  await runExchange({ sessionId: 'cli', text, print: true });
}

// ----------------------------------------------------------------------- main
async function main(argv) {
  const { command, positional, opts } = parseArgs(argv);
  try {
    if (command === 'help') return cmdHelp();
    if (command === 'chat') {
      const text = positional.join(' ');
      return text.trim() ? oneShot(text.trim()) : repl();
    }
    if (command === 'sessions') return cmdSessions(positional, opts);
    if (command === 'models') return cmdModels(positional, opts);
    if (command === 'channels') return cmdChannels(positional, opts);
    if (command === 'config') return cmdConfig(positional);
    throw new Error(`unknown command '${command}'`);
  } catch (e) {
    process.stderr.write(paint(C.red, `pagent: ${String((e && e.message) || e)}\n`));
    process.exitCode = 1;
  }
}

module.exports = { parseArgs, main, cmdSessions, cmdModels, cmdChannels, cmdConfig, runExchange, dotEnvSet, dotEnvKeys, repl };

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`pagent fatal: ${(e && e.message) || e}\n`);
    process.exit(2);
  });
}