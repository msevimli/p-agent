/**
 * plife — Local AI agent dashboard (entry point / router only).
 *
 * Initializes Express + middleware, mounts the route modules, and starts the
 * listener on config.port (default 8888). All application logic lives in
 * routes/ and services/; this file has no business logic by design.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const automationManager = require('./services/automationManager');
const telegramBot = require('./services/telegramBot');
const modelLifecycle = require('./services/modelLifecycle');
const modelManager = require('./services/modelManager');
const embedder = require('./services/embedder');

const app = express();

// --- middleware -----------------------------------------------------------------
app.use(express.json({ limit: '2mb' }));
app.use(express.static(config.publicDir));

// --- API routes -------------------------------------------------------------------
app.use('/api/health', require('./routes/health'));
app.use('/api/chat', require('./routes/chat'));
app.use('/api/sessions', require('./routes/sessions'));
app.use('/api/fs', require('./routes/fs'));
app.use('/api/memory', require('./routes/memory'));
app.use('/api/library', require('./routes/library'));
app.use('/api/skills', require('./routes/skills'));
app.use('/api/models/templates', require('./routes/templates'));
app.use('/api/models', require('./routes/models'));
app.use('/api/automations', require('./routes/automations'));
app.use('/api/queue', require('./routes/queue'));
app.use('/api/channels', require('./routes/channels'));
app.use('/api/system', require('./routes/system'));
app.use('/api/system/prompt', require('./routes/systemPrompt'));

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

  // Model management + warm-up at boot: ensure the cascade pair (or the
  // active model) is running via its systemd user units (AUTO_MANAGE_MODELS
  // to skip), then prefill the static prompt prefixes (AUTO_WARMUP=false to
  // skip) so the first real user message starts from the llama.cpp KV cache
  // instead of a minutes-long cold prefill. Runs in the background through
  // the same FIFO queue as chat and never blocks startup.
  const cascadeBoot = require('./services/cascade').resolve();
  const bootModelIds = () => {
    if (cascadeBoot.enabled) return [cascadeBoot.router.id, cascadeBoot.primary.id];
    const active = modelManager.getActiveModel();
    return active && active.id ? [active.id] : [];
  };
  const warmBoot = (ids) => {
    if (!config.autoWarmup) return;
    for (const id of ids) {
      modelLifecycle
        .warmup(id)
        .then((r) => {
          if (r && r.ok && r.promptTokens) {
            console.log(`startup warm-up (${id}): prefix pre-filled (${r.promptTokens} prompt tokens)`);
          } else if (r && !r.ok) {
            console.log(`startup warm-up skipped (${id}): ${r.error}`);
          }
        })
        .catch((e) => console.log(`startup warm-up skipped (${id}): ${String((e && e.message) || e)}`));
    }
  };
  if (config.autoManageModels) {
    modelLifecycle
      .ensureCascadeModels()
      .then((res) => {
        const line = (Array.isArray(res) ? res : [res])
          .map((x) => (x && x.ok ? `ok ${x.detail || x.id || ''}` : `FAIL ${(x && x.error) || '?'}`))
          .join(' | ');
        console.log(`[models] ensure: ${line}`);
        warmBoot(bootModelIds());
      })
      .catch((e) => {
        console.log(`[models] ensure failed: ${String((e && e.message) || e)}`);
        warmBoot(bootModelIds());
      });
  } else {
    warmBoot(bootModelIds());
  }
});

// Semantic-memory embedder preload (background; never blocks boot).
embedder.warm();

// Agent workspace: ensure workspaces/ exists so the File Explorer can show
// it as a normal folder from the very first boot.
try { fs.mkdirSync(config.workspaceDir, { recursive: true }); } catch { /* best effort */ }

// Stop the scheduler cleanly on shutdown signals.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => {
    automationManager.stop();
    telegramBot.stop();
    process.exit(0);
  });
}