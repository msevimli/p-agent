/** GET /api/health — server + llama.cpp status, model info, context window. */
const express = require('express');
const router = express.Router();
const config = require('../config');
const { checkLlamaHealth, getContextWindow } = require('../services/llamaClient');
const modelManager = require('../services/modelManager');

router.get('/', async (_req, res) => {
  const llama = await checkLlamaHealth();
  const contextWindow = await getContextWindow();
  const active = modelManager.getActiveModel();
  res.json({
    server: { up: true, port: config.port },
    llama,
    model: active ? active.model : config.llamaModel,
    activeModel: active ? { id: active.id, name: active.name } : null,
    llamaBaseUrl: active && active.endpoint ? active.endpoint : config.llamaBaseUrl,
    contextWindow,
  });
});

module.exports = router;