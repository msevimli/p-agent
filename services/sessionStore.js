/**
 * Session persistence — lives in services/ because the store (load/save) is a
 * data-layer concern independent of the HTTP routes that use it.
 *
 * Sessions are persisted to a JSON file (data/sessions.json) so they survive
 * server restarts.
 */
const fs = require('fs');
const { dataDir, sessionsFile } = require('../config');

function ensureFile() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(sessionsFile)) fs.writeFileSync(sessionsFile, '[]');
}

function load() {
  ensureFile();
  try {
    return JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
  } catch {
    return [];
  }
}

function save(sessions) {
  ensureFile();
  fs.writeFileSync(sessionsFile, JSON.stringify(sessions, null, 2));
}

module.exports = { load, save, file: sessionsFile };