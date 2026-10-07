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
const modelLifecycle = require('./services/modelLifecycle');
const modelManager = require('./services/modelManager');

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
app.use('/api/system', require('./routes/system'));

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

  // Warm-up the active model in the background (AUTO_WARMUP=false to skip):
  // one max_tokens=1 completion containing ONLY the static prompt prefix so
  // the first real user message starts from the llama.cpp KV cache instead of
  // a minutes-long cold prefill. Runs through the same FIFO request queue as
  // chat and never blocks startup; an unreachable server produces a clear
  // logged error instead of hanging.
  if (config.autoWarmup) {
    const active = modelManager.getActiveModel();
    if (active && active.id) {
      modelLifecycle
        .warmup(active.id)
        .then((r) => {
          if (r && r.ok && r.promptTokens) {
            console.log(`startup warm-up: prefix pre-filled (${r.promptTokens} prompt tokens)`);
          } else if (r && !r.ok) {
            console.log(`startup warm-up skipped: ${r.error}`);
          }
        })
        .catch((e) => console.log(`startup warm-up skipped: ${String((e && e.message) || e)}`));
    }
  }
});

// Stop the scheduler cleanly on shutdown signals.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => {
    automationManager.stop();
    telegramBot.stop();
    process.exit(0);
  });
}