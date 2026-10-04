/**
 * plife — Local AI agent dashboard (entry point / router only).
 *
 * Initializes Express + middleware, mounts the route modules, and starts the
 * listener on config.port (default 8888). All application logic lives in
 * routes/ and services/; this file has no business logic by design.
 */
const express = require('express');
const path = require('path');
const config = require('./config');
const automationManager = require('./services/automationManager');
const telegramBot = require('./services/telegramBot');

const app = express();

// --- middleware -----------------------------------------------------------------
app.use(express.json({ limit: '2mb' }));
app.use(express.static(config.publicDir));

// --- API routes -------------------------------------------------------------------
app.use('/api/health', require('./routes/health'));
app.use('/api/chat', require('./routes/chat'));
app.use('/api/sessions', require('./routes/sessions'));
app.use('/api/fs', require('./routes/fs'));
app.use('/api/library', require('./routes/library'));
app.use('/api/skills', require('./routes/skills'));
app.use('/api/models', require('./routes/models'));
app.use('/api/automations', require('./routes/automations'));
app.use('/api/queue', require('./routes/queue'));
app.use('/api/channels', require('./routes/channels'));

// Optional introspection endpoint so the tool registry is inspectable at runtime.
app.get('/api/tools', (_req, res) => {
  res.json(require('./services/toolLoop').listTools());
});

// --- SPA fallback -------------------------------------------------------------------
app.get('*', (_req, res) => {
  res.sendFile(path.join(config.publicDir, 'index.html'));
});

// --- listener ------------------------------------------------------------------------
app.listen(config.port, () => {
  console.log(`plife dashboard running on http://localhost:${config.port}`);
  console.log(`llama.cpp endpoint: ${config.llamaBaseUrl} (model ${config.llamaModel})`);
  automationManager.start();
  console.log('automation scheduler started');
  // Resume the Telegram channel if it was enabled before restart.
  telegramBot.syncStart();
  if (telegramBot.status().enabled) console.log('telegram channel: enabled (polling when token is set)');
});

// Stop the scheduler cleanly on shutdown signals.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => {
    automationManager.stop();
    telegramBot.stop();
    process.exit(0);
  });
}