/**
 * /api/models — multi-model registry + active-model selection.
 *
 * Backed by services/modelManager.js. Provides:
 *   GET    /api/models           list all models + active id (live status)
 *   POST   /api/models           create a model (name, endpoint, model, contextLength, apiKey?)
 *   GET    /api/models/:id       single model
 *   PUT    /api/models/:id       update a model
 *   DELETE /api/models/:id       delete a model
 *   POST   /api/models/:id/activate   set a model as the active/default model
 *
 * Security: an apiKey sent here is routed by the manager to <root>/.env
 * (LLAMA_API_KEY_<MODEL_ID>) — it is never persisted in models-state.json,
 * which stays free of plaintext secrets. Responses carry only hasKey flags.
 */
const express = require('express');
const modelManager = require('../services/modelManager');
const modelLifecycle = require('../services/modelLifecycle');
const cascade = require('../services/cascade');
const router = express.Router();

// GET /api/models -> { ok, active, models: [...], cascade: {...} }
// `models` carries per-entry `category` ('cloud' | 'local' | 'cascade') so the
// panel can group endpoints without re-deriving it client-side; `cascade` is
// the live two-stage setup summary (enabled flag, escalation mode, and the
// resolved router/primary pair — id/name only, no secrets).
router.get('/', async (_req, res) => {
  try {
    const { active, models } = await modelManager.listModels();
    const c = cascade.resolveFrom(modelManager.getState());
    const share = (m) => (m ? { id: m.id, name: m.name, role: m.role || '', endpoint: m.endpoint || '' } : null);
    // Only report a primary that is actually role-configured — resolveFrom()
    // falls back to the active model when no explicit primary exists, and
    // that runtime fallback is not a config the panel should present as one.
    res.json({
      ok: true,
      active,
      models,
      cascade: {
        enabled: c.enabled,
        escalate: c.escalate,
        router: share(c.router),
        primary: c.primary && c.primary.role === 'primary' ? share(c.primary) : null,
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'could not list models' });
  }
});

// GET /api/models/status -> live lifecycle status (unloaded | loading |
// ready | error) per model + memory footprint. MUST stay registered before
// GET /:id so "status" is never captured as a model id.
router.get('/status', async (_req, res) => {
  try {
    const r = await modelLifecycle.getStatuses();
    res.json({ ok: true, ...r });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'could not probe model status' });
  }
});

// POST /api/models/launch  body: { id? } (default: the cascade router+primary
// pair, or the active model) — start the model's llama-server (systemd user
// unit) and wait until /health answers.
router.post('/launch', async (req, res) => {
  try {
    const requested = req.body && req.body.id;
    if (requested) {
      const r = await modelLifecycle.launch(String(requested));
      res.status(r.ok ? 200 : r.code || 400).json(r);
    } else {
      const r = await modelLifecycle.ensureCascadeModels();
      const ok = r.every((x) => x && x.ok);
      res.status(ok ? 200 : 502).json({ ok, results: r });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'launch failed' });
  }
});

// POST /api/models/warmup  body: { id? } (default: active model) — background
// pre-load so the first user prompt responds instantly.
router.post('/warmup', async (req, res) => {
  try {
    const active = modelManager.getActiveModel();
    const target = (req.body && req.body.id) || (active && active.id) || '';
    const r = await modelLifecycle.warmup(target);
    res.status(r.ok ? 200 : r.code || 400).json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'warm-up failed' });
  }
});

// POST /api/models/eject  body: { id? } (default: active model) — free model
// weights from memory (capability-tiered, see modelLifecycle).
router.post('/eject', async (req, res) => {
  try {
    const active = modelManager.getActiveModel();
    const target = (req.body && req.body.id) || (active && active.id) || '';
    const r = await modelLifecycle.eject(target);
    res.status(r.ok ? 200 : r.code || 400).json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'eject failed' });
  }
});

// POST /api/models/cascade/roles  body: { routerId?, primaryId? } — atomically
// re-assign which registered models act as the two-stage cascade pair. An id
// of ''/null unsets that stage (both omitted clears the whole cascade). The
// registry is re-read on every request, so the live chat cascade switches to
// the new pair instantly — no restart. Response carries the new pair.
router.post('/cascade/roles', (req, res) => {
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const r = modelManager.setCascadeRoles(b.routerId, b.primaryId);
  res.status(r.ok ? 200 : 400).json(r);
});

// POST /api/models/cascade/stop — stop the current cascade pair's llama-server
// (systemd user units, e.g. llama-router.service / llama-primary.service) and
// free their memory. Idempotent; missing units are skipped, not errors.
router.post('/cascade/stop', async (_req, res) => {
  try {
    const r = await modelLifecycle.stopCascadeModels();
    res.status(r.ok ? 200 : 502).json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'cascade stop failed' });
  }
});

// POST /api/models/:id/load — start the model's llama-server (systemd user
// unit, configured flags incl. -c/-m/--host from its template or the default)
// and WAIT until its /health answers. Idempotent: ok with already:true when
// the endpoint is already online. Thin alias of POST /api/models/launch.
router.post('/:id/load', async (req, res) => {
  try {
    const r = await modelLifecycle.launch(req.params.id);
    res.status(r.ok ? 200 : r.code || 400).json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'load failed' });
  }
});

// POST /api/models/:id/eject — stop the model's llama-server unit and free
// its memory (capability-tiered unload, see modelLifecycle). Idempotent.
// Thin alias of POST /api/models/eject.
router.post('/:id/eject', async (req, res) => {
  try {
    const r = await modelLifecycle.eject(req.params.id);
    res.status(r.ok ? 200 : r.code || 400).json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'eject failed' });
  }
});

// GET /api/models/:id -> single model
router.get('/:id', (req, res) => {
  const m = modelManager.getModel(req.params.id);
  if (!m) return res.status(404).json({ ok: false, error: 'model not found' });
  res.json({ ok: true, model: m });
});

// POST /api/models  body: { id, name, endpoint, model, contextLength?, apiKey?, provider? }
router.post('/', (req, res) => {
  const r = modelManager.createModel(req.body || {});
  res.status(r.ok ? 201 : 400).json(r);
});

// PUT /api/models/:id  body: { name?, endpoint?, model?, contextLength?, apiKey?, id? (rename) }
router.put('/:id', (req, res) => {
  const r = modelManager.updateModel(req.params.id, req.body || {});
  res.status(r.ok ? 200 : 400).json(r);
});

// DELETE /api/models/:id
router.delete('/:id', (req, res) => {
  const r = modelManager.deleteModel(req.params.id);
  res.status(200).json(r);
});

// POST /api/models/:id/activate  — make this model the active/default one.
router.post('/:id/activate', (req, res) => {
  const r = modelManager.setActive(req.params.id);
  if (r.ok) {
    // Warm the newly active model's prefix OFF the critical path: the first
    // user turn after a switch would otherwise pay the full cold prefill
    // (minutes on CPU — the KV cache holds only one prompt's prefix and the
    // previous model's cache is evicted by the switch). The warm runs
    // through the same FIFO queue (deduped, max_tokens=1), so the next
    // turn's ttft drops to the history-delta prefill.
    const id = req.params.id;
    modelLifecycle
      .warmup(id)
      .then((w) => {
        console.log(
          `[models] activate warm: ${id} -> ${w && w.ok ? (w.already ? 'already warming' : 'queued') : 'skipped (' + ((w && w.error) || '?') + ')'}`
        );
      })
      .catch((err) => console.log(`[models] activate warm error: ${id} ${err.message || err}`));
  }
  res.status(r.ok ? 200 : 400).json(r);
});

module.exports = router;
