/**
 * llama.cpp client — owns all communication with the local model server.
 *
 * Responsibilities:
 *  - Health / context-window probing (/health, /props)
 *  - Building the OpenAI-compatible /v1/chat/completions payload (system
 *    injection, role filtering, sampler overrides, usage stats)
 *  - Opening the upstream streaming request
 *  - Parsing llama.cpp's SSE stream and forwarding it to the browser
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const config = require('../config');
const modelManager = require('./modelManager');
const requestQueue = require('./requestQueue');
const historyManager = require('./historyManager');

// ===== DIAGNOSTIC (opt-in: PLIFE_DEBUG_DUMP=1) — dumps (1) the EXACT payload
// (system prompt + tool definitions) written to the model endpoint, and (2)
// every raw upstream chunk as received, BEFORE any SSE parsing / tool-call
// extraction. Append-only log: /tmp/plife-dump.log.
const DBG_LOG = '/tmp/plife-dump.log';
let dbgSeq = 0;
function dbgDump(label, text) {
  if (!config.debugDump) return;
  dbgSeq += 1;
  const block =
    `\n[${new Date().toISOString()}] ==== DBG#${dbgSeq} ${label} ====\n` +
    `${text}\n==== END DBG#${dbgSeq} ${label} ====\n`;
  try { fs.appendFileSync(DBG_LOG, block); } catch { /* ignore */ }
  console.log(`[DBG] ${label} (#${dbgSeq}, ${String(text).length} chars) -> ${DBG_LOG}`);
}
// ===== END DIAGNOSTIC =====

/** Pick the request module (http|https) for a URL string. */
function clientFor(url) {
  return /^https:/i.test(url) ? https : http;
}

/** Strip trailing slashes from a base URL. */
function stripSlash(url) {
  return String(url || '').replace(/\/+$/, '');
}

/**
 * OpenAI chat-completions URL for a base endpoint. Tolerates a trailing slash
 * and bases that already carry `/v1` or the full `/v1/chat/completions` suffix,
 * so stored endpoints never produce doubled paths (e.g. /v1/v1/chat/completions).
 */
function chatCompletionsUrl(base) {
  const b = stripSlash(base).replace(/\/chat\/completions$/i, '');
  return /\/v1$/i.test(b) ? `${b}/chat/completions` : `${b}/v1/chat/completions`;
}

/** Resolve base URL + model id of the currently active model (fallback: legacy config). */
function activeTarget() {
  const m = modelManager.getActiveModel();
  return {
    baseUrl: stripSlash((m && m.endpoint) ? String(m.endpoint) : config.llamaBaseUrl),
    model: (m && m.model) ? m.model : config.llamaModel,
    apiKey: modelManager.resolveApiKey((m && m.id) || '') || '',
  };
}

function llamaUrl(p) {
  return `${activeTarget().baseUrl}${p}`;
}

/** GET /health — is the llama.cpp server up? */
function checkLlamaHealth() {
  return new Promise((resolve) => {
    const req = clientFor(llamaUrl('/health')).get(llamaUrl('/health'), { timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          resolve({ up: true, status: parsed.status || 'ok', body: parsed });
        } catch {
          resolve({ up: true, status: 'ok', body });
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ up: false, status: 'timeout' });
    });
    req.on('error', () => resolve({ up: false, status: 'unreachable' }));
  });
}

/** GET /props — read the server's configured context window (n_ctx). */
function getContextWindow() {
  return new Promise((resolve) => {
    const req = clientFor(llamaUrl('/props')).get(llamaUrl('/props'), { timeout: 3000 }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        try {
          const p = JSON.parse(b);
          const n =
            p?.default_generation_settings?.params?.n_ctx ??
            p?.default_generation_settings?.n_ctx ??
            p?.params?.n_ctx;
          resolve(Number.isFinite(n) ? n : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
  });
}

/**
 * Normalize the raw messages array into the OpenAI-compatible shape:
 * a system prompt always leads, then alternating user/assistant history.
 * No manual prompt concatenation.
 */
function buildChatMessages(rawMessages, systemPrompt) {
  const out = [];
  const list = Array.isArray(rawMessages) ? rawMessages : [];
  if (!list.some((m) => m && m.role === 'system')) {
    out.push({ role: 'system', content: systemPrompt || config.llamaSystemPrompt });
  }
  for (const m of list) {
    if (m && typeof m.content === 'string') {
      const role = m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user';
      out.push({ role, content: m.content });
    }
  }
  return out;
}

/**
 * Build the full /v1/chat/completions payload. `generation` holds optional
 * per-request overrides from the frontend settings control; unset fields fall
 * back to configured defaults. `opts.system` overrides the injected system
 * prompt; `opts.tools` appends an OpenAI `tools` array for native tool calls.
 */
function buildChatPayload(rawMessages, generation, opts) {
  const gen = generation && typeof generation === 'object' ? generation : {};
  const o = opts && typeof opts === 'object' ? opts : {};
  const num = (v, fb) => (typeof v === 'number' && Number.isFinite(v) ? v : fb);
  const payload = {
    model: activeTarget().model,
    messages: buildChatMessages(rawMessages, o.system),
    temperature: num(gen.temperature, config.llamaTemperature),
    top_p: num(gen.top_p, config.llamaTopP),
    repeat_penalty: num(gen.repeat_penalty, config.llamaRepeatPenalty), // native loop-breaker
    repeat_last_n: num(gen.repeat_last_n, config.llamaRepeatLastN),
    max_tokens: num(gen.max_tokens, config.llamaMaxTokens), // bound so SSE ends at [DONE]
    // Ask llama.cpp to report real prompt/output token counts on the last chunk.
    stream_options: { include_usage: true },
    // Reuse the KV cache for the stable prompt prefix (system + tools +
    // history). MUST be true on every request or llama.cpp skips cache lookup.
    cache_prompt: true,
    stream: true,
  };
  if (Array.isArray(o.tools) && o.tools.length) payload.tools = o.tools;
  // Guard retry: force a tool call for exactly one request (only set when the
  // retry path asks for it; the field is absent otherwise so the server's
  // default tool_choice behavior is untouched).
  if (o.toolChoice === 'required' || o.toolChoice === 'auto' || o.toolChoice === 'none') {
    payload.tool_choice = o.toolChoice;
  }
  return payload;
}

/**
 * Open the upstream POST to /v1/chat/completions. The caller supplies the
 * upstream-response handler (typically parseSseToClient).
 */
function streamCompletions(payload, onResponse) {
  const target = activeTarget();
  const headers = { 'Content-Type': 'application/json' };
  if (target.apiKey) headers.Authorization = `Bearer ${target.apiKey}`;
  return clientFor(target.baseUrl).request(
    chatCompletionsUrl(target.baseUrl),
    { method: 'POST', headers },
    onResponse
  );
}

/**
 * Perform ONE completion through the FIFO request queue: strict serialization
 * so a single-slot llama.cpp never receives concurrent streaming requests
 * (which cause empty streams / socket errors). Transient failures are retried
 * by the queue itself (see requestQueue). The returned promise carries a
 * non-enumerable `position` (FIFO rank at enqueue; 1 = next/executing) so the
 * caller can tell the user they're queued.
 */
function complete(opts) {
  const q = requestQueue.enqueue(() => completeInSlot(opts), { label: 'llm' });
  try {
    Object.defineProperty(q.promise, 'position', { value: q.position, enumerable: true });
  } catch { /* non-configurable promise — position stays internal */ }
  return q.promise;
}

/** Raw completion attempt with one intra-slot retry (used by the queue). */
function completeInSlot(opts) {
  const attempts = Number.isInteger(opts && opts.attempts) ? opts.attempts : 2;
  return new Promise((resolve, reject) => {
    const tryOnce = (left) => {
      doComplete(opts).then(resolve).catch((err) => {
        const msg = String((err && err.message) || err || '');
        const transient = /hang up|ECONNRESET|EPIPE|ETIMEDOUT|unreachable|empty stream/i.test(msg);
        const throttled = /402|429|in_flight_budget|rate[- ]limited|temporarily rate-limited/i.test(msg);
        // Rate-limit-class rejections (402 in-flight budget, 429) need the
        // contending request/rate window to settle — retry on a longer
        // backoff than plain network gremlins, still bounded by `left`.
        if ((transient || throttled) && left > 0) {
          setTimeout(() => tryOnce(left - 1), throttled ? 8000 : 350);
        } else {
          reject(err);
        }
      });
    };
    tryOnce(attempts);
  });
}

/**
 * GET /slots — is this llama-server actively working?
 * Returns { status: 'busy' } when any slot is processing OR has a task
 * assigned (id_task/task_id > 0 — covers jobs ingested but still waiting for
 * compute), { status: 'idle' } when all slots are free, and
 * { status: 'unknown' } when the endpoint is missing/unreachable/unparseable
 * (older builds), so callers can fall back to a fixed grace.
 */
function pollSlotStatus() {
  return new Promise((resolve) => {
    let url;
    try {
      url = `${activeTarget().baseUrl}/slots`;
    } catch { return resolve({ status: 'unknown' }); }
    const req = clientFor(url).get(url, { timeout: 4000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          const slots = JSON.parse(body);
          if (!Array.isArray(slots)) return resolve({ status: 'unknown' });
          const busy = slots.some(
            (s) => s && (s.is_processing === true || Number(s.id_task) > 0 || Number(s.task_id) > 0)
          );
          resolve({ status: busy ? 'busy' : 'idle' });
        } catch { resolve({ status: 'unknown' }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 'unknown' }); });
    req.on('error', () => resolve({ status: 'unknown' }));
  });
}

/**
 * Slot-aware liveness supervisor for a silent upstream stream — replaces a
 * fixed silent-timeout with dynamic waiting based on llama-server's own
 * progress (GET /slots):
 *  - Before the first byte: the server may not have ingested the request yet
 *    and /slots is ambiguous, so a fixed grace applies — but it self-extends
 *    while any slot reports busy (slow time-to-first-token on big prompts),
 *    so a working server is never cut off by the clock.
 *  - After the first byte: silence is tolerated indefinitely while any slot
 *    is busy (the generation is progressing server-side even if the socket
 *    stays quiet). Aborts only when every slot reads idle on two consecutive
 *    polls (the double-check avoids killing a stream during the final-flush
 *    race), or when /slots is unavailable and silence exceeds the grace.
 *
 * Returns { noteActivity, stop }. Call noteActivity() on every upstream byte;
 * stop() on resolve/reject paths. onAbort(reason) fires at most once.
 */
function createSlotSupervisor(onAbort) {
  const graceMs = Number(config.llamaStallTimeoutMs) || 120000;
  const pollMs = Number(config.llamaSlotPollMs) || 4000;
  const checkAfterMs = Number(config.llamaSlotCheckSilenceMs) || 15000;
  let firstByte = false;
  let lastDataAt = Date.now();
  let idleStreak = 0;
  let stopped = false;
  let timer = null;
  let interval = null;

  const stop = () => { stopped = true; clearTimeout(timer); clearInterval(interval); timer = interval = null; };
  const abort = (msg) => { if (stopped) return; stop(); onAbort(msg); };

  // Phase A: fixed grace until the first byte; re-arms (instead of aborting)
  // while a slot is busy, so slow prompt ingestion still waits dynamically.
  const armPhaseA = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (stopped || firstByte) return;
      const st = await pollSlotStatus();
      if (stopped || firstByte) return;
      if (st.status === 'busy') return armPhaseA(); // server working — keep waiting
      abort(`llama.cpp went silent: no data for ${Math.round(graceMs / 1000)}s while waiting for the first chunk`);
    }, graceMs);
  };
  armPhaseA();

  interval = setInterval(async () => {
    if (stopped) return;
    const silentMs = Date.now() - lastDataAt;
    if (!firstByte || silentMs < checkAfterMs) return;
    const st = await pollSlotStatus();
    if (stopped) return;
    if (st.status === 'busy') { idleStreak = 0; return; } // working — wait dynamically
    if (st.status === 'idle') {
      idleStreak += 1;
      if (idleStreak >= 2) {
        abort('llama.cpp slot went idle without a result while the stream was silent');
      }
      return;
    }
    // /slots unavailable (older builds): fixed backstop from the last byte.
    if (silentMs >= graceMs) {
      abort(`llama.cpp went silent: no data for ${Math.round(graceMs / 1000)}s while generating`);
    }
  }, pollMs);

  return {
    noteActivity: () => { lastDataAt = Date.now(); idleStreak = 0; if (!firstByte) firstByte = true; },
    stop,
  };
}

/**
 * Join two tool-call argument fragments, splitting on JSON token boundaries
 * instead of raw concatenation. llama.cpp's streaming tokenizer (and some
 * OpenAI-compatible remotes) splits identifiers mid-token, e.g. stream
 * `"scripts/c`, `urrent`, `-time.js"` — naive concatenation would miss the
 * leading `\"`, corrupt the JSON, and make `safeParseArgs` silently produce
 * `{}` (which then runs tools with empty args, e.g. a write_file with no
 * content). Re-joining the fragments and re-balancing the quote re-creates
 * the exact JSON the model emitted.
 */
function joinToolCallArgs(a, b) {
  if (!a) return b;
  if (!b) return a;
  const joined = a + b;
  const even = (s) => ((s.match(/"/g) || []).length % 2 === 0);
  if (even(joined)) return joined; // balanced — plain concatenation is fine
  // Unbalanced quotes: the join point sits inside a JSON string boundary and
  // one quote char was doubled ('"x"' + '",' -> ...x"",...) or swallowed.
  // Try the plausible re-joins and take the first that re-balances:
  //  - drop both boundary quotes, or
  //  - drop both and re-insert exactly one (keeps the quoted value intact).
  // Whichever candidate balances the JSON is the one the model intended.
  const head = a.replace(/\\?"$/, '');
  const tail = b.replace(/^\\?"/, '');
  for (const cand of [joined, head + tail, head + '"' + tail]) {
    if (even(cand)) return cand;
  }
  return joined; // nothing better — leave as-is, extractor validation catches it
}

/**
 * Per-request LLM timing log (requirement: every request logs prompt tokens,
 * cache hits, prompt/generation speed, total time). llama.cpp reports:
 *   usage.prompt_tokens            — total prompt length
 *   timings.prompt_n               — tokens EVALUATED this request
 *   → cached                      = prompt_tokens - prompt_n
 *   timings.prompt_per_second      — prefill speed
 *   timings.predicted_per_second   — generation speed
 *   timings.prompt_ms+predicted_ms — model-side total
 * Falls back gracefully when the server omits usage/timings.
 */
function logTimings(acc, firstTokenMs, wallMs, prefixHash) {
  const u = acc.usage || {};
  const t = acc.timings || {};
  const promptTotal = Number.isFinite(u.prompt_tokens) ? u.prompt_tokens : null;
  const evalN = Number.isFinite(t.prompt_n) ? t.prompt_n : null;
  const cached =
    promptTotal !== null && evalN !== null ? Math.max(0, promptTotal - evalN) : null;
  const pp = Number.isFinite(t.prompt_per_second) ? t.prompt_per_second : null;
  const gen = Number.isFinite(t.predicted_per_second) ? t.predicted_per_second : null;
  const llmMs =
    Number.isFinite(t.prompt_ms) && Number.isFinite(t.predicted_ms)
      ? t.prompt_ms + t.predicted_ms
      : null;
  const bits = [];
  if (promptTotal !== null) bits.push(`prompt=${promptTotal}`);
  if (evalN !== null) bits.push(`eval=${evalN}`);
  if (cached !== null) bits.push(`cached=${cached}`);
  if (pp !== null) bits.push(`pp=${pp.toFixed(1)}t/s`);
  if (gen !== null) bits.push(`gen=${gen.toFixed(1)}t/s`);
  if (llmMs !== null) bits.push(`llm=${(llmMs / 1000).toFixed(1)}s`);
  if (firstTokenMs !== null) bits.push(`ttft=${(firstTokenMs / 1000).toFixed(1)}s`);
  bits.push(`wall=${(wallMs / 1000).toFixed(1)}s`);
  if (prefixHash) bits.push(`prefix=${prefixHash}`);
  console.log(`[llm] model=${activeTarget().model} ${bits.join(' ')}`);
}

/** Hash of the serialized static prefix (system prompt + tools) of a chat
 *  payload — the part llama.cpp must re-process when it changes. Computed
 *  from the payload actually sent, so warm-up and real requests are
 *  comparable; logs a warning if the hash changes mid-process.
 */
function payloadHash(payload) {
  const sys = payload && payload.messages && payload.messages[0] ? String(payload.messages[0].content || '') : '';
  const toolsJson = payload && Array.isArray(payload.tools) ? JSON.stringify(payload.tools) : '[]';
  return historyManager.prefixHashFor(sys, toolsJson);
}

/**
 * Perform ONE completion: consume the full SSE stream server-side and resolve
 * with { content, toolCalls, usage, timings }.
 *  - content:      accumulated text deltas
 *  - toolCalls:    native tool_calls accumulated across chunks, as
 *                  [{ index, id, name, arguments }] (arguments possibly partial)
 *                  — quoted fragments are de-tokenized via joinToolCallArgs
 *  - usage:        the usage object from the final chunk (may be null)
 *  - timings:      the llama.cpp timings object from the final chunk (may be null)
 *  - firstTokenMs: ms from request write to first content/tool-call delta (may be null)
 * Optional onDelta/onUsage/onTimings/onFirstChunk callbacks stream tokens,
 * usage, timings and first-byte as they arrive.
 * Rejects with an Error on non-200 upstream responses or network failure.
 */
function doComplete(opts) {
  return new Promise((resolve, reject) => {
    const { payload, onDelta, onUsage, onFirstChunk, onTimings } = opts || {};
    const acc = { content: '', toolCalls: new Map(), usage: null, timings: null, finishReason: null };
    // Wall clock for the timing log; measured from inside the queue slot, so
    // it excludes FIFO wait (that is surfaced separately as queue position).
    const t0 = Date.now();
    let firstChunkMs = null; // first upstream byte (prefill finished server-side)
    let firstTokenMs = null; // first content/tool-call delta = time to first token

    // Slot-aware liveness supervisor: replaces a fixed silent-timeout with
    // dynamic waiting driven by llama-server's own /slots state (see
    // createSlotSupervisor). On abort the upstream is destroyed; the error
    // wording deliberately avoids the queue's transient keywords (hang up /
    // timeout / stream): a dead-slot stream is NOT recoverable and must not
    // be auto-retried (a retry would regenerate the whole output).
    const supervisor = createSlotSupervisor((msg) => {
      upstream.destroy();
      reject(new Error(msg));
    });

    const upstream = streamCompletions(payload, (upRes) => {
      if (upRes.statusCode !== 200) {
        let body = '';
        upRes.on('data', (c) => (body += c));
        upRes.on('end', () =>
          reject(new Error(`llama.cpp ${upRes.statusCode}: ${body.slice(0, 300)}`))
        );
        return;
      }
      let buffer = '';
      upRes.on('data', (chunk) => {
        supervisor.noteActivity(); // any byte is life — reset the liveness window
        if (firstChunkMs === null) {
          firstChunkMs = Date.now() - t0;
          if (onFirstChunk) onFirstChunk(firstChunkMs);
        }
        // TEMP DIAGNOSTIC: raw upstream bytes verbatim, before SSE split / JSON
        // parse / tool-call extraction. Concatenating all RAW_CHUNKs in order
        // yields the exact response string the model sent.
        dbgDump('RAW_CHUNK', chunk.toString());
        buffer += chunk.toString();
        let sep;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const event = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          for (const line of event.split('\n')) {
            const t = line.trim();
            if (!t.startsWith('data:')) continue;
            const d = t.slice(5).trim();
            if (d === '[DONE]') continue; // resolve on upstream 'end'
            try {
              const j = JSON.parse(d);
              const delta = j.choices && j.choices[0] ? j.choices[0].delta || {} : {};
              if (firstTokenMs === null && (typeof delta.content === 'string' && delta.content || Array.isArray(delta.tool_calls) && delta.tool_calls.length)) {
                firstTokenMs = Date.now() - t0;
              }
              if (typeof delta.content === 'string' && delta.content) {
                acc.content += delta.content;
                if (onDelta) onDelta(delta.content);
              }
              if (Array.isArray(delta.tool_calls)) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index || 0;
                  const e = acc.toolCalls.get(idx) || { id: '', name: '', arguments: '' };
                  if (tc.id) e.id += tc.id;
                  if (tc.function) {
                    // Names are single tokens even when split across chunks
                    // ("write_fi" + "le"), so plain concatenation is safe.
                    if (tc.function.name) e.name += tc.function.name;
                    // Arguments stream as JSON fragments that may split
                    // mid-token — re-join on JSON token boundaries so the
                    // final string parses (see joinToolCallArgs).
                    if (typeof tc.function.arguments === 'string') {
                      e.arguments = joinToolCallArgs(e.arguments, tc.function.arguments);
                    }
                  }
                  acc.toolCalls.set(idx, e);
                }
              }
              if (j.usage) {
                acc.usage = j.usage;
                if (onUsage) onUsage(j.usage);
              }
              // llama.cpp reports `timings` (prompt_n / prompt_per_second /
              // predicted_per_second / prompt_ms / predicted_ms) on the final
              // chunk, alongside usage. prompt_n = tokens actually evaluated
              // this request → cache hits = usage.prompt_tokens - prompt_n.
              if (j.timings) {
                acc.timings = j.timings;
                if (onTimings) onTimings(j.timings);
              }
              // finish_reason arrives on the choice (not the delta), usually
              // on the last chunk — "length" means max_tokens cut the output
              // and the caller may want to continue generation.
              if (j.choices && j.choices[0] && j.choices[0].finish_reason) {
                acc.finishReason = j.choices[0].finish_reason;
              }
            } catch { /* partial chunk — ignore */ }
          }
        }
      });
      upRes.on('end', () => {
        supervisor.stop();
        if (acc.content.trim() === '' && acc.toolCalls.size === 0) {
          // 200 OK but zero usable chunks (immediate [DONE], empty/whitespace
          // body, or a usage-only final chunk). Reject so complete() retries
          // and the chat route surfaces a real error instead of a silent
          // empty answer.
          reject(new Error('llama.cpp returned an empty stream (no content or tool calls)'));
          return;
        }
        if (acc.usage || acc.timings) {
          // Hash of the exact serialized prefix (system prompt + tools) sent
          // with this payload — logged with every completion so a runtime
          // change (which would silently invalidate the llama.cpp KV cache)
          // is immediately visible. See services/historyManager.js.
          const prefixHash = payloadHash(payload);
          logTimings(acc, firstTokenMs, Date.now() - t0, prefixHash);
        }
        resolve({
          content: acc.content,
          usage: acc.usage,
          timings: acc.timings,
          finishReason: acc.finishReason,
          firstTokenMs,
          toolCalls: [...acc.toolCalls.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([index, e]) => ({ index, id: e.id, name: e.name, arguments: e.arguments })),
        });
      });
      upRes.on('error', (e) => {
        supervisor.stop();
        reject(new Error(`llama.cpp stream error: ${e.message}`));
      });
    });
    upstream.on('error', (e) => {
      supervisor.stop();
      reject(new Error(`llama.cpp unreachable: ${e.message}`));
    });
    // TEMP DIAGNOSTIC: exact payload as sent (messages[0].content = full system
    // prompt incl. embedded tool schema; payload.tools = OpenAI tool defs).
    dbgDump(
      `PAYLOAD  url=${chatCompletionsUrl(activeTarget().baseUrl)} model=${activeTarget().model}`,
      JSON.stringify(payload, null, 2)
    );
    upstream.write(JSON.stringify(payload));
    upstream.end();
  });
}

/**
 * Returns an upstream-response handler that parses llama.cpp's SSE stream and
 * forwards each complete `data:` event (standard OpenAI chunk format) to the
 * browser, terminating at `data: [DONE]`. Respects client disconnect (aborts
 * the upstream read).
 */
function parseSseToClient(res, stream) {
  return (upRes) => {
    if (upRes.statusCode !== 200) {
      let body = '';
      upRes.on('data', (c) => (body += c));
      upRes.on('end', () => {
        try {
          res.status(upRes.statusCode).json(JSON.parse(body));
        } catch {
          res.status(upRes.statusCode).send(body || `llama.cpp error ${upRes.statusCode}`);
        }
      });
      return;
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    let buffer = '';
    let finished = false;
    let errored = false;

    // Slot-aware liveness supervisor (mirrors doComplete): while the upstream
    // is silent, llama-server's /slots state decides liveness; a dead stream
    // ends the SSE gracefully (status event + [DONE]) instead of leaving the
    // browser hanging forever.
    const supervisor = createSlotSupervisor((msg) => {
      if (finished || errored) return;
      finished = true;
      upRes.destroy();
      try {
        res.write(`data: ${JSON.stringify({ type: 'status', message: `⚠ ${msg} — ending stream.` })}\n\n`);
        res.write('data: [DONE]\n\n');
      } catch { /* ignore */ }
      res.end();
    });

    upRes.on('data', (chunk) => {
      if (!stream || finished) return;
      supervisor.noteActivity(); // any byte is life
      buffer += chunk.toString();
      let sep;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        if (!event.trim()) continue;
        const dataLines = event
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim());
        for (const data of dataLines) {
          if (data === '[DONE]') {
            finished = true;
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }
          if (data) res.write(`data: ${data}\n\n`);
        }
      }
    });

    const close = () => {
      if (!finished && !errored) {
        finished = true;
        res.end();
      }
    };
    upRes.on('end', () => { supervisor.stop(); close(); });
    upRes.on('error', () => {
      supervisor.stop();
      errored = true;
      close();
    });
    res.on('close', () => upRes.destroy());
  };
}

module.exports = {
  llamaUrl,
  checkLlamaHealth,
  getContextWindow,
  buildChatMessages,
  buildChatPayload,
  chatCompletionsUrl,
  streamCompletions,
  complete,
  joinToolCallArgs,
  parseSseToClient,
};