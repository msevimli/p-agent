/** GET /api/health — server + llama.cpp status, model info, context window. */
const express = require('express');
const router = express.Router();
const config = require('../config');
const { checkLlamaHealth, getContextWindow } = require('../services/llamaClient');
const modelManager = require('../services/modelManager');

router.get('/', async (_req, res) => {
  const llama = await checkLlamaHealth();
  const active = modelManager.getActiveModel();
  // The active model's CONFIGURED contextLength is authoritative for the UI
  // token counter and the max-tokens clamp. The llama.cpp /props n_ctx was
  // the old source and is wrong for remote models (no /props endpoint → UI
  // stuck on the 8192 fallback even when the model supports 250k). It stays
  // only as a fallback for entries without a usable contextLength.
  const contextWindow =
    active && Number.isFinite(active.contextLength) && active.contextLength > 0
      ? active.contextLength
      : await getContextWindow();
  res.json({
    server: { up: true, port: config.port },
    llama,
    model: active ? active.model : config.llamaModel,
    activeModel: active
      ? { id: active.id, name: active.name, provider: active.provider || 'local', contextLength: contextWindow }
      : null,
    llamaBaseUrl: active && active.endpoint ? active.endpoint : config.llamaBaseUrl,
    contextWindow,
  });
});

module.exports = router;