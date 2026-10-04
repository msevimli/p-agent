/**
 * services/telegramBot.js — Telegram channel for the plife agent.
 *
 * Native Telegram Bot API long-polling (no extra dependencies): getUpdates
 * with a long-poll timeout, sequential update handling, exponential backoff
 * on network errors, and every reply routed through the same agentic loop the
 * browser uses (services/chatLoopback.js → /api/chat → tool loop + queue).
 *
 * Security model:
 *   - Token lives ONLY in .env as TELEGRAM_BOT_TOKEN (written via the
 *     writeDotEnvVar pattern, gitignored). channels-state.json holds metadata
 *     (enabled flag, allowed chat ids, last error) — never the token.
 *   - Incoming messages are checked against the allowedChatIds whitelist in
 *     channels-state.json PLUS TELEGRAM_ADMIN_CHAT_ID from .env (admin is
 *     always allowed and cannot be removed from the dashboard).
 *   - Unauthorized chats get a single short refusal; they never reach the
 *     agent and are never queued.
 *
 * Commands handled locally (no agent cost): /id, /status, /help, /start.
 * Everything else is sent to the agent with the sender's chat id as context.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const config = require('../config');
const { runAgentSession } = require('./chatLoopback');
const modelManager = require('./modelManager');

const STATE_FILE = path.join(config.dataDir, 'channels-state.json');
const TOKEN_VAR = 'TELEGRAM_BOT_TOKEN';
const ADMIN_VAR = 'TELEGRAM_ADMIN_CHAT_ID';

const MAX_REPLY_CHARS = config.telegramMaxReplyChars;
const MAX_POLL_TIMEOUT = 50;
const MAX_BACKOFF_MS = 30000;

// ------------------------------------------------------------------ state
function defaultState() {
  return { channels: [{ type: 'telegram', enabled: false, allowedChatIds: [], lastError: null, lastActivityAt: null, lastRunAt: null }] };
}

function loadState() {
  try {
    const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (j && Array.isArray(j.channels)) {
      const c = j.channels.find((x) => x && x.type === 'telegram');
      if (c) {
        c.enabled = !!c.enabled;
        c.allowedChatIds = Array.isArray(c.allowedChatIds) ? c.allowedChatIds.map(String) : [];
        return j;
      }
      j.channels.push(defaultState().channels[0]);
      return j;
    }
  } catch { /* first run */ }
  return defaultState();
}

function saveState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, STATE_FILE);
    return true;
  } catch (e) {
    console.error('[telegram] could not persist state:', e.message);
    return false;
  }
}

function channelConfig() {
  const s = loadState();
  return s.channels.find((x) => x.type === 'telegram');
}

function updateChannel(patch) {
  const s = loadState();
  const c = s.channels.find((x) => x.type === 'telegram');
  Object.assign(c, patch);
  saveState(s);
  return c;
}

// ------------------------------------------------------------------ token / ids
function token() {
  return String(process.env[TOKEN_VAR] || '').trim();
}

function adminIds() {
  return String(process.env[ADMIN_VAR] || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^-?\d+$/.test(s));
}

function isAuthorizedChat(chatId) {
  const s = String(chatId);
  const cfg = channelConfig();
  return cfg.allowedChatIds.includes(s) || adminIds().includes(s);
}

// ------------------------------------------------------------------ Telegram API
const reqModule = () => /^https:/i.test(config.telegramApiBase) ? https : http;

function apiCall(method, body) {
  const tok = token();
  if (!tok) return Promise.reject(new Error('TELEGRAM_BOT_TOKEN is not set'));
  const payload = JSON.stringify(body || {});
  return new Promise((resolve, reject) => {
    const u = new URL(`${config.telegramApiBase}/bot${encodeURIComponent(tok)}/${method}`);
    const r = reqModule().request(
      u,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        timeout: config.telegramRequestTimeoutMs,
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          let j = null;
          try { j = JSON.parse(raw); } catch { /* non-JSON */ }
          if (res.statusCode !== 200 || !j || j.ok !== true) {
            const desc = (j && (j.description || j.error)) || `HTTP ${res.statusCode}`;
            const err = new Error(desc);
            err.statusCode = res.statusCode;
            err.telegram = j;
            return reject(err);
          }
          resolve({ statusCode: res.statusCode, body: j.result });
        });
      }
    );
    r.on('timeout', () => { r.destroy(new Error('Telegram API request timed out')); });
    r.on('error', reject);
    r.end(payload);
  });
}

function sendMessage(chatId, text) {
  return apiCall('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true });
}

function editMessage(chatId, messageId, text) {
  return apiCall('editMessageText', { chat_id: chatId, message_id: messageId, text, disable_web_page_preview: true });
}

/**
 * getMe — validates the configured token against the Telegram API.
 * Returns { ok:true, bot:{id,username,first_name} } or { ok:false, error }.
 */
async function testConnection() {
  try {
    const r = await apiCall('getMe', {});
    const b = r.body || {};
    return { ok: true, bot: { id: b.id, username: b.username || '', first_name: b.first_name || '' } };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

// ------------------------------------------------------------------ status
function status() {
  const cfg = channelConfig();
  let activeModel = null;
  try {
    const m = modelManager.getActiveModel();
    if (m) activeModel = { id: m.id, name: m.name, provider: m.provider };
  } catch { /* model registry unavailable */ }
  return {
    type: 'telegram',
    name: 'Telegram',
    enabled: cfg.enabled,
    running: pollActive,
    tokenSet: !!token(),
    adminChatId: adminIds(),
    allowedChatIds: cfg.allowedChatIds,
    lastError: cfg.lastError,
    lastActivityAt: cfg.lastActivityAt,
    lastRunAt: cfg.lastRunAt,
    activeModel,
  };
}

function setLastError(err) {
  const msg = err && err.message ? err.message : String(err);
  updateChannel({ lastError: msg.slice(0, 300), lastActivityAt: new Date().toISOString() });
  console.error('[telegram]', msg);
}

// ------------------------------------------------------------------ poll loop
let pollActive = false;
let pollTimer = null;
let polling = false;
let nextOffset = 0;
let backoffMs = 1000;

function shouldRun() {
  const cfg = channelConfig();
  return cfg.enabled && !!token();
}

function schedulePoll(delay) {
  if (!shouldRun() || pollTimer) return;
  pollTimer = setTimeout(async () => {
    pollTimer = null;
    await pollOnce();
  }, delay || 0);
}

async function pollOnce() {
  if (polling) return;
  polling = true;
  try {
    const r = await apiCall('getUpdates', {
      offset: nextOffset,
      timeout: Math.max(5, Math.min(config.telegramPollTimeoutSec, MAX_POLL_TIMEOUT)),
      allowed_updates: ['message'],
    });
    backoffMs = 1000;
    const updates = Array.isArray(r.body) ? r.body : [];
    for (const upd of updates) {
      nextOffset = Math.max(nextOffset, (upd && upd.update_id ? upd.update_id : 0) + 1);
      try {
        await handleUpdate(upd);
      } catch (e) {
        console.error('[telegram] update handling failed:', e && e.message ? e.message : e);
      }
    }
  } catch (e) {
    const isAuth = e && (e.statusCode === 401 || /unauthorized|token/i.test(String(e.message)));
    setLastError(e);
    // Don't spin hot on persistent failures (bad token, network down).
    backoffMs = Math.min(Math.max(backoffMs * 2, 1000), MAX_BACKOFF_MS);
    if (isAuth) backoffMs = MAX_BACKOFF_MS;
  } finally {
    polling = false;
    if (shouldRun()) schedulePoll(backoffMs);
  }
}

function start() {
  if (pollActive) return false;
  if (!shouldRun()) return false;
  pollActive = true;
  nextOffset = 0; // fresh poll session
  backoffMs = 1000;
  schedulePoll(0);
  return true;
}

function stop() {
  pollActive = false;
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
}

/** Called on boot and after any config toggle: run only when enabled + token. */
function syncStart() {
  if (shouldRun()) return start();
  stop();
  return false;
}

// ------------------------------------------------------------------ replies
/** Split an answer into Telegram-safe chunks on paragraph/line boundaries. */
function splitReply(text, maxChars) {
  const max = maxChars || MAX_REPLY_CHARS;
  const chunks = [];
  let rest = String(text || '');
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.5) cut = max;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.trim()) chunks.push(rest.trim());
  return chunks;
}

/** Send with Markdown formatting first; fall back to plain text on 400. */
async function sendFormatted(chatId, text) {
  try {
    return await apiCall('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown', disable_web_page_preview: true });
  } catch (e) {
    if (e && e.statusCode === 400) {
      return sendMessage(chatId, text); // unbalanced markdown — plain fallback
    }
    throw e;
  }
}

/** Markdown-enabled send for curated bot text (help/status). */
async function sendMarkdown(chatId, text) {
  return sendFormatted(chatId, text);
}

// ------------------------------------------------------------------ commands
const HELP_TEXT =
  '🤖 *plife agent on Telegram*\n\n' +
  '*Commands*\n' +
  '`/id` — show this chat\u2019s id (needed for the whitelist)\n' +
  '`/status` — bot + model status\n' +
  '`/help` — this message\n\n' +
  'Anything else is sent to the active AI agent with its full toolset (files, skills, library, automations).';

function buildStatusText() {
  const cfg = channelConfig();
  const s = status();
  const model = s.activeModel ? `${s.activeModel.name} (${s.activeModel.id})` : 'none configured';
  const lines = [
    '📡 *plife Telegram channel*',
    `Enabled: ${cfg.enabled ? 'yes' : 'no'}`,
    `Bot running: ${s.running ? 'yes' : 'no'}`,
    `Token set: ${s.tokenSet ? 'yes' : 'no'}`,
    `Active model: ${model}`,
    `Allowed chats: ${cfg.allowedChatIds.length ? cfg.allowedChatIds.join(', ') : '(whitelist empty — only admin ids)'}`,
    `Admin chats: ${s.adminChatId.length ? s.adminChatId.join(', ') : '(none set)'}`,
  ];
  if (cfg.lastError) lines.push(`Last error: ${cfg.lastError}`);
  return lines.join('\n');
}

/** Handle one incoming message. Exported so tests can inject updates directly. */
async function handleMessage(msg) {
  if (!msg || !msg.chat) return;
  const chatId = msg.chat.id;
  const text = String(msg.text || msg.caption || '').trim();
  if (!text) return; // ignore non-text payloads for now
  updateChannel({ lastActivityAt: new Date().toISOString() });
  if (msg.chat.type === 'channel') return;

  // Local commands — /id works for ANY chat (users need it to self-whitelist).
  if (text === '/id' || text.startsWith('/id ')) {
    await sendMessage(chatId, `This chat\u2019s id: ${chatId}\nAdd it to the whitelist in the plife dashboard (Tools → Channels) to use this bot.`);
    return;
  }

  if (!isAuthorizedChat(chatId)) {
    await sendMessage(chatId, '❌ This chat is not authorized to use this bot. Set the whitelist in the plife dashboard (Tools → Channels).');
    return;
  }

  if (text === '/start' || text === '/help') { await sendMarkdown(chatId, HELP_TEXT); return; }
  if (text === '/status') { await sendMarkdown(chatId, buildStatusText()); return; }

  // ---- agent roundtrip --------------------------------------------------
  let workingMsg = null;
  try {
    workingMsg = await sendMessage(chatId, '⏳ Working on it…');
  } catch { /* no working bubble — final reply still lands */ }

  let result;
  try {
    result = await runAgentSession({
      messages: [{ role: 'user', content: text }],
      generation: { temperature: 0.4, top_p: 0.95, max_tokens: 2048 },
    });
  } catch (e) {
    const errText = `⚠️ Agent request failed: ${e && e.message ? e.message : e}`;
    updateChannel({ lastRunAt: new Date().toISOString(), lastError: errText.slice(0, 300) });
    if (workingMsg) { try { await editMessage(chatId, workingMsg.message_id, errText); } catch { await sendMessage(chatId, errText); } }
    else { try { await sendMessage(chatId, errText); } catch { /* chat unreachable */ } }
    return;
  }

  updateChannel({ lastRunAt: new Date().toISOString(), lastError: null });

  const answer = (result.text || '').trim();
  if (!answer) {
    const note = '⚠️ The agent returned an empty response. Try rephrasing, or check the model endpoint in Models.';
    if (workingMsg) { try { await editMessage(chatId, workingMsg.message_id, note); } catch { try { await sendMessage(chatId, note); } catch {} } }
    return;
  }

  const chunks = splitReply(answer);
  const footer = result.statuses && result.statuses.length
    ? `\n(⚙️ ${result.statuses.length} tool step${result.statuses.length === 1 ? '' : 's'})`
    : '';

  if (workingMsg) {
    try { await editMessage(chatId, workingMsg.message_id, chunks[0] + (chunks.length === 1 ? footer : '')); }
    catch { try { await sendMessage(chatId, chunks[0]); } catch {} }
    for (const c of chunks.slice(1)) {
      try { await sendMessage(chatId, c); } catch { /* keep going */ }
    }
  } else {
    for (const c of chunks) {
      try { await sendMessage(chatId, c); } catch { /* keep going */ }
    }
  }
  // Tool-activity footnote: already embedded in the single edit when it fit;
  // otherwise send it as its own trailing message.
  if (footer && !(workingMsg && chunks.length === 1)) {
    try { await sendMessage(chatId, footer); } catch { /* ignore */ }
  }
}

/** Dispatch an update object (message only). Exported for tests + poll loop. */
async function handleUpdate(update) {
  if (update && update.message) {
    await handleMessage(update.message);
  }
}

// ------------------------------------------------------------------ exports
module.exports = {
  start,
  stop,
  syncStart,
  status,
  testConnection,
  handleUpdate,
  handleMessage,
  isAuthorizedChat,
  splitReply,
  setAllowedChatIds(ids) {
    const clean = (Array.isArray(ids) ? ids : [])
      .map((x) => String(x).trim())
      .filter((s) => /^-?\d+$/.test(s));
    updateChannel({ allowedChatIds: clean.slice(0, 100) });
    return { ok: true, allowedChatIds: channelConfig().allowedChatIds };
  },
  setEnabled(enabled) {
    const on = !!enabled;
    if (on && !token()) return { ok: false, error: 'Telegram bot token is not set — add it in Tools → Channels first' };
    updateChannel({ enabled: on, lastError: null });
    syncStart();
    return { ok: true, running: pollActive, enabled: on };
  },
  writeToken(value) {
    // Token routing via the established writeDotEnvVar pattern (modelManager):
    // written to gitignored .env, mirrored into process.env immediately.
    const v = String(value || '').trim();
    const r = modelManager.writeDotEnvVar(TOKEN_VAR, v ? v : null);
    if (!r.ok) return r;
    syncStart();
    return { ok: true, tokenSet: !!token() };
  },
  TOKEN_VAR,
  ADMIN_VAR,
};