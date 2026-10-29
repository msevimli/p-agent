/**
 * /api/system/prompt — persisted System Prompt override.
 *
 * The active system prompt is the stored override when present, otherwise
 * the generated template (toolLoop.buildSystemPrompt). The override lives
 * in a single text file under config.dataDir so it survives restarts and is
 * readable/editable by humans; SYSTEM_PROMPT_FILE env overrides the path
 * (harnesses/tests must set it BEFORE requiring any project module, because
 * the path binds at require time).
 *
 * The override REPLACES the whole generated prompt — including the tool
 * payloads section — so an edited prompt is applied byte-for-byte. This
 * means saving changes (or resetting) changes the KV cache prefix: the
 * next chat turn is a one-time cold prefill until the new prefix warms.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');

const FILE = process.env.SYSTEM_PROMPT_FILE || path.join(config.dataDir, 'system-prompt.txt');
const DEFAULT_FILE = process.env.SYSTEM_PROMPT_DEFAULT_FILE || path.join(__dirname, 'system-prompt.default.txt');
const MAX_LEN = 64 * 1024; // 64 KiB — express.json limit is 2 MB, this is the app cap

/** Built-in default prompt (the committed system-prompt.default.txt — the
 *  prompt that ships with the app; an override replaces it wholesale). */
function getDefault() {
  try {
    const s = fs.readFileSync(DEFAULT_FILE, 'utf8').trim();
    return s ? s : null;
  } catch {
    return null; // missing/unreadable file === no built-in default
  }
}

/** Persisted override, or null when not set. Whitespace-only counts as unset. */
function getOverride() {
  try {
    const s = fs.readFileSync(FILE, 'utf8').trim();
    return s ? s : null;
  } catch {
    return null; // missing/unreadable file === no override
  }
}

/** Persist a new override. `ok:false` + error on empty/oversized input. */
function setOverride(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return { ok: false, error: 'system prompt must not be empty' };
  if (s.length > MAX_LEN) return { ok: false, error: `system prompt too long (${s.length} chars, max ${MAX_LEN})` };
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, s + '\n');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `could not persist system prompt: ${e.message}` };
  }
}

/** Remove the override; the template becomes active again. */
function resetOverride() {
  try {
    fs.unlinkSync(FILE);
  } catch {
    /* already absent — fine */
  }
  return { ok: true };
}

module.exports = { getOverride, setOverride, resetOverride, getDefault, FILE, DEFAULT_FILE, MAX_LEN };