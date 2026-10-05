/**
 * /api/chat — streaming agentic chat proxy to llama.cpp.
 *
 * Runs an agentic tool loop over a single SSE connection to the browser:
 *   1. Sends the OpenAI `tools` array AND a system prompt teaching the model a
 *      structured JSON-block tool-call format (for "Content-only" servers that
 *      don't emit native tool_calls).
 *   2. Intercepts a tool call (native delta.tool_calls OR JSON block in text),
 *      executes it via the toolLoop service, and feeds the result back as a
 *      `tool` message.
 *   3. Loops up to config.toolMaxIterations, streaming `type:"status"` events
 *      so the frontend shows what the agent is doing in real time.
 *   4. When the model finally answers with plain text, streams it as normal
 *      OpenAI content chunks + usage, then `data: [DONE]`.
 *
 * Heavy-output handling: generations that hit the per-call max_tokens cap
 * (finish_reason "length") are continued automatically — the partial output is
 * fed back and the model resumes where it stopped, up to
 * config.continuationMaxRounds (works for plain answers AND truncated JSON
 * tool calls, which otherwise stream as garbage). A completely silent
 * upstream is aborted after config.llamaStallTimeoutMs.
 *
 * When tool calling is disabled (TOOL_CALLING=false), it degrades to the
 * original single-completion passthrough, streamed token-by-token (still with
 * chunked continuation).
 */
const express = require('express');
const router = express.Router();
const config = require('../config');
const { complete, buildChatPayload } = require('../services/llamaClient');
const toolLoop = require('../services/toolLoop');
const historyManager = require('../services/historyManager');
const libraryManager = require('../services/libraryManager');
const toolCallParser = require('../services/toolCallParser');
const automationsTools = require('../tools/automationsTools');
const createAutomationTool = automationsTools.tools.find((t) => t.name === 'create_automation');

// --- SSE framing helpers -----------------------------------------------------
const contentChunk = (c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`;
const statusChunk = (m) => `data: ${JSON.stringify({ type: 'status', message: m })}\n\n`;
const usageChunk = (u) => `data: ${JSON.stringify({ choices: [], usage: u })}\n\n`;
const DONE_CHUNK = 'data: [DONE]\n\n';

// Fed back as a user message when max_tokens cut a generation short; the
// model resumes exactly where it stopped instead of repeating itself.
const CONTINUE_MSG =
  'Your previous response was cut off at the output limit. Continue exactly from where you left off — do not repeat anything already written, no preamble.';
const CONTINUE_STATUS = 'Output hit the token cap — continuing generation.';

// Fed back when the model answers an automation-creation request with
// explanations instead of a create_automation call — forces the tool call.
const FORCE_TOOL_MSG =
  'You must finish the automation creation by calling the create_automation tool now. ' +
  'A previous create_automation call may already have succeeded; if so, call list_automations ' +
  'to show the result and stop. Otherwise reply with EXACTLY one JSON object, no other text: ' +
  '{"tool": "create_automation", "args": {"name": "...", "schedule_type": "interval" or "cron", ' +
  '"interval_minutes": N or "cron": "5-field expression", "action_type": "script"|"skill"|"prompt", ' +
  '"script" / "skill" / "prompt": "..."}} — use the schedule and action the user asked for.';

function openSse(res, queuePosition) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  if (queuePosition) res.setHeader('X-Queue-Position', String(queuePosition));
  res.flushHeaders();
}

// Log a history-compaction event: tokens before/after, what was removed, and
// the estimated re-prefill time. The re-prefill cost is the number of prompt
// tokens AFTER THE FIRST CHANGED POSITION (what llama.cpp must re-process
// once the prefix breaks) divided by the last measured prompt speed
// (fallback 10 tok/s when the server has not reported timings yet).
function logCompaction(where, before, after, removed, rePrefillTokens, budget, getTimings) {
  const t = (getTimings && getTimings()) || {};
  const pp = Number.isFinite(t.prompt_per_second) ? t.prompt_per_second : 10;
  const rePrefillS = Math.max(1, Math.round(rePrefillTokens / pp));
  const what =
    removed.length > 4
      ? removed.slice(0, 4).join('; ') + `; +${removed.length - 4} more`
      : removed.join('; ');
  console.log(
    `[ctx] compact(${where}): before=${before} after=${after} removed=${removed.length} [${what}] ` +
      `budget=${budget.budget}(high=${budget.high}/low=${budget.low}) estRePrefill=${rePrefillS}s @${pp.toFixed(1)}t/s`
  );
}

// UI notice for a compaction: same re-prefill estimate as the log line.
function trimNotice(rePrefillTokens, getTimings) {
  const t = (getTimings && getTimings()) || {};
  const pp = Number.isFinite(t.prompt_per_second) ? t.prompt_per_second : 10;
  return `✂ Context trimmed, next reply may take longer (est. re-prefill ~${Math.max(1, Math.round(rePrefillTokens / pp))}s).`;
}

// Swallow write-after-abort / socket-closed errors during shutdown.
function safeWrite(res, chunk, lost) {
  if (lost) return;
  try {
    res.write(chunk);
  } catch { /* client gone — ignore */ }
}

// Ensure a system message leads, our tool prompt preferred.
function ensureSystem(messages, systemPrompt) {
  const rest = (messages || []).filter((m) => m && m.role !== 'system');
  return [{ role: 'system', content: systemPrompt }, ...rest];
}

// Human-readable status label for a tool call (for the frontend activity feed).
function toolLabel(name, args) {
  const a = args || {};
  switch (name) {
    case 'read_file': return `Reading file: ${a.path || '?'}`;
    case 'write_file': return `Writing file: ${a.path || '?'}`;
    case 'edit_file': return `Editing file: ${a.path || '?'}`;
    case 'list_files': return `Listing directory: ${a.path || '.'}`;
    case 'run_shell': return `Running command: ${String(a.command || '').slice(0, 90)}`;
    case 'create_automation': return `Creating automation: ${a.name || '?'}`;
    case 'run_automation': return `Triggering automation: ${a.id || '?'}`;
    case 'delete_automation': return `Deleting automation: ${a.id || '?'}`;
    case 'list_automations': return 'Listing automations';
    case 'list_library_files': return 'Listing Library files';
    case 'read_library_file': return `Reading library file: ${a.file_id || a.name || '?'}`;
    case 'upload_library_file': return `Saving to Library: ${a.name || '?'}`;
    default: return `Calling tool: ${name}`;
  }
}

// One log line per executed tool call ([tool] name=… exit=… dur=…s
// cmd="…" out="…" err="…"): real exit code, wall duration, and the first
// 200 chars of command / stdout / stderr, JSON-escaped. The server log is
// the only place tool execution is visible after the fact (the UI only
// shows a status while running) — without this, failures are undiagnosable.
function logToolCall(name, args, result, durMs) {
  const r = result && typeof result === 'object' ? result : {};
  const exit = typeof r.code === 'number' ? r.code : r.ok ? 0 : 1;
  const cmd =
    name === 'run_shell'
      ? String((args && args.command) || '')
      : JSON.stringify(args || {});
  const clip = (v) => JSON.stringify(String(v == null ? '' : v).slice(0, 200));
  console.log(
    `[tool] name=${name} exit=${exit} dur=${(durMs / 1000).toFixed(1)}s cmd=${clip(cmd)} ` +
      `out=${clip(r.stdout)} err=${clip(r.stderr || r.error)}`
  );
}

// ---------------------------------------------------------------------------
// Library attachments — resolve chat `attachments: [{id|name}]` against the
// persistent Library and inline their content into the LAST user message so
// the model sees them like any other part of the conversation. Text files are
// inlined as fenced blocks (per-file and total caps, truncated with a pointer
// to read_library_file); binary files are replaced by a metadata pointer so
// the agent can still fetch them via the read_library_file tool. Unresolvable
// attachments produce an explicit note instead of failing the request.
// ---------------------------------------------------------------------------
const ATTACH_MAX_CHARS_PER_FILE = 60000; // inlined per attachment
const ATTACH_MAX_CHARS_TOTAL = 120000; // inlined across all attachments

function formatBytes(n) {
  n = Number(n) || 0;
  if (n >= 1048576) return (n / 1048576).toFixed(2) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

function injectAttachments(messages, attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return messages;
  const lastUser = [...messages].reverse().find((m) => m && m.role === 'user');
  if (!lastUser) return messages;

  const blocks = [];
  let total = 0;

  for (const att of attachments) {
    const id =
      typeof att === 'string' ? att
        : att && typeof att === 'object' ? (att.id || att.fileId || '') : '';
    const entry = id ? libraryManager.get(id) : null;
    if (!entry) {
      blocks.push(`[Attached file not found in the Library: ${JSON.stringify(att)}]`);
      continue;
    }

    const r = libraryManager.readText(entry.id, ATTACH_MAX_CHARS_PER_FILE);
    if (r.ok) {
      if (total + r.text.length > ATTACH_MAX_CHARS_TOTAL) {
        blocks.push(`[Attached file: ${entry.name} — omitted, total inline-attachment limit reached; use read_library_file (file_id "${entry.id}") if needed]`);
        continue;
      }
      total += r.text.length;
      blocks.push(
        `[Attached library file: ${entry.name} (${formatBytes(entry.size)}, ${entry.mime || 'unknown'})]\n` +
          '```\n' + r.text + '\n```' +
          (r.truncated
            ? `\n[content truncated at ${ATTACH_MAX_CHARS_PER_FILE.toLocaleString()} characters — use read_library_file with file_id "${entry.id}" to read more]`
            : '')
      );
    } else {
      blocks.push(
        `[Attached library file: ${entry.name} (${formatBytes(entry.size)}, ${entry.mime || 'unknown'}) — ${r.reason === 'binary' ? 'binary, not inlined' : 'content unavailable'}; use read_library_file with file_id "${entry.id}" to inspect it]`
      );
    }
  }

  if (!blocks.length) return messages;
  return messages.map((m) =>
    m === lastUser
      ? { ...m, content: (m.content ? m.content + '\n\n' : '') + blocks.join('\n\n') }
      : m
  );
}

// Stream final text in bounded word-safe chunks for a natural streaming feel.
function emitTextChunks(res, text, lost) {
  if (!text) return;
  const words = text.split(/(\s+)/);
  let buf = '';
  const flush = () => { if (buf) { safeWrite(res, contentChunk(buf), lost); buf = ''; } };
  for (const w of words) {
    buf += w;
    if (buf.length >= 180) flush();
  }
  flush();
}

/**
 * Plain (tool-less) generation with chunked continuation: completes the
 * conversation without the tools array / tool system prompt and streams every
 * delta live. Used by the passthrough mode (TOOL_CALLING=false) AND as the
 * resilience fallback when a tool-enabled completion returns an empty stream
 * (some providers/models cannot carry the tools array) — the request is
 * re-run without tools so the turn always completes with an answer instead of
 * stalling. Resolves with the accumulated text.
 *
 * `firstAttempt` optionally reuses the route's pre-queued first completion
 * (which already carries an onDelta streamer); pass null to enqueue a fresh
 * one (the fallback case — the pre-queued promise already rejected as empty).
 * `plainSystem` overrides the system prompt for degraded re-runs (the base
 * prompt without tool-call instructions — so a model that cannot carry the
 * tools array answers conversationally instead of echoing call JSON).
 * Callers must NOT re-emit the returned text: it was streamed live.
 */
async function streamPlainAnswer(res, agentMessages, gen, onUsage, lost, firstAttempt, plainSystem, onTimings) {
  let out = '';
  let prevLen = -1;
  for (let r = 0; r <= config.continuationMaxRounds; r++) {
    const acc = await (r === 0 && firstAttempt
      ? firstAttempt
      : complete({
          payload: buildChatPayload(agentMessages, gen, plainSystem ? { system: plainSystem } : {}),
          onDelta: (d) => safeWrite(res, contentChunk(d), lost),
          onUsage,
          onTimings,
        }));
    out += acc.content;
    const capped = acc.finishReason === 'length';
    const progress = acc.content.length > prevLen;
    if (!capped || !progress) break; // finished, or the model made no headway
    prevLen = acc.content.length;
    agentMessages.push({ role: 'assistant', content: acc.content });
    agentMessages.push({ role: 'user', content: CONTINUE_MSG });
    safeWrite(res, statusChunk(`✂ ${CONTINUE_STATUS} (round ${r + 1}/${config.continuationMaxRounds})`), lost);
    if (lost) break; // nobody is listening — free the queue slot
  }
  return out;
}

// Error message used when a 200-OK upstream produced no usable output at all
// (see llamaClient doComplete). Detected here so a tools-enabled request can
// degrade to plain generation instead of failing the whole turn.
const EMPTY_STREAM_RE = /empty stream/i;

router.post('/', async (req, res) => {
  // Fresh per-request tool-call ledger (deduplication scope).
  toolLoop.resetSeenCalls();

  const { messages, stream = true, attachments } = req.body || {};
  const gen = req.body && typeof req.body.generation === 'object' ? req.body.generation : {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }
  if (stream !== true) {
    return res.status(400).json({ error: 'only streaming (stream: true) is supported' });
  }

  const toolsEnabled = config.toolCallingEnabled && toolLoop.listTools().length > 0;
  const systemPrompt = toolsEnabled
    ? toolLoop.buildSystemPrompt(config.llamaSystemPrompt)
    : `${config.llamaSystemPrompt}\n\n${toolLoop.AUTOMATIONS_GUIDANCE}`;
  // Degraded/tool-less re-runs must NOT instruct JSON tool-call output (a
  // model that cannot carry the tools array would echo the call as plain
  // text); they get the base prompt only.
  const plainSystemPrompt = `${config.llamaSystemPrompt}\n\n${toolLoop.AUTOMATIONS_GUIDANCE}`;

  // Working conversation history (system-first) mutated by the loop. Library
  // attachments are resolved and inlined into the last user message BEFORE
  // the first upstream call, so the model sees file content from the start.
  let agentMessages = injectAttachments(ensureSystem(messages, systemPrompt), attachments);
  let lost = false;
  res.on('close', () => { lost = true; });

  // Automation-creation interception: if the CURRENT user turn commands an
  // automation creation (imperatively — "how do I..." does NOT match), a
  // model answer without a tool call is intercepted and forced.
  const lastUserMsg = [...(messages || [])].reverse().find((m) => m && m.role === 'user');
  const firstUserText = (lastUserMsg && lastUserMsg.content) || '';
  const automationIntent = !!toolsEnabled && !!firstUserText && toolLoop.isAutomationCreationRequest(firstUserText);

  // Tool selection — prompt-cache-friendly. DEFAULT: ALL tools, always, in a
  // fixed name-sorted order (identical serialization across requests, warmed
  // up with the same prefix). LAZY_TOOLS=true (experimental) restores the
  // topic-based subset: a small CORE set always, plus tools relevant to THIS
  // conversation (union over all user messages — the set only grows, but a
  // mid-conversation tool-group addition still invalidates the KV cache,
  // which is why the default is the full set).
  const tools = toolsEnabled
    ? config.lazyTools
      ? toolLoop.selectTools(agentMessages, {
          attachments: Array.isArray(attachments) && attachments.length > 0,
          force: automationIntent
            ? ['create_automation', 'delete_automation', 'list_automations', 'run_automation']
            : [],
        })
      : toolLoop.toOpenAITools()
    : undefined;

  let usage = null;
  let lastTimings = null; // llama.cpp timings from the final chunk (cache + speeds)

  // Context budget (server-reported n_ctx, read-only) + watermark thresholds
  // for history compaction. `histTokens` tracks the estimated tokens of the
  // history (everything after the static prefix); calibrated cheaply against
  // usage.prompt_tokens after every completion, never by calling the model.
  const budget = await historyManager.budgetFor(
    await historyManager.contextTokens(),
    config.promptPrefixTokens
  );
  let histTokens = historyManager.historyTokens(agentMessages);
  let ctxRetried = false; // context-overflow recovery: compact + retry ONCE

  // Watermarked pre-compaction by deterministic REPLAY: turns are walked
  // from the start and an event fires only when the running estimate crosses
  // the high watermark, so the cut is sticky — between events the compacted
  // prefix is byte-identical across requests and the KV cache stays valid.
  // The decision never uses usage.prompt_tokens calibration (that estimate
  // only feeds logs/UI); no event when the history is below high.
  {
    const c = historyManager.compactHistory(agentMessages, {
      high: budget.high,
      low: budget.low,
      keepTurns: config.contextKeepLastTurns,
    });
    if (c.removed.length) {
      const delta = historyManager.compactionDelta(agentMessages, c.messages);
      agentMessages = c.messages;
      histTokens = c.after;
      historyManager.rememberLastCompactOutput(agentMessages);
      // Only announce when the boundary actually MOVED (stubs/drops changed
      // vs the previous request); re-applying the same stubs to the same raw
      // history is a cache no-op and would spam the log + UI every turn.
      if (delta.moved) {
        logCompaction('pre-request', c.before, c.after, c.removed, delta.rePrefill, budget, () => lastTimings);
        safeWrite(res, statusChunk(trimNotice(delta.rePrefill, () => lastTimings)), lost);
      }
    } else {
      historyManager.rememberLastCompactOutput(agentMessages);
    }
  }

  // Generation timing: measured from right before the first upstream call
  // (queue slot + model generation) to the moment the final usage chunk is
  // written. Surfaced to the client as `usage.elapsedMs` so each assistant
  // message can show a ⚡ duration badge.
  const startTs = Date.now();

  // Enqueue the first upstream LLM call BEFORE the SSE headers flush:
  // complete() registers its queue slot synchronously and exposes the FIFO
  // position, which we surface via an X-Queue-Position header plus a polite
  // status event (rendered in the tool feed) instead of a sudden network
  // error. The tool loop reuses this promise for its first iteration so the
  // request is not double-queued.
  // "Processing prompt…" visibility: on a cold start the prefill can take
  // minutes before the first byte arrives. If nothing has arrived after a
  // short grace, emit a status event so the UI shows work in progress
  // instead of looking frozen; it is cancelled the moment the first upstream
  // byte lands. (The model-status badge additionally shows "loading ·
  // prefill (N%)" from /slots polling.)
  let firstChunkSeen = false;
  const coldStartTimer = setTimeout(() => {
    if (lost || firstChunkSeen) return;
    safeWrite(
      res,
      statusChunk('⏳ Processing prompt (cold start — prefill takes a while on CPU)…'),
      lost
    );
  }, 2500);
  const markFirstChunk = () => {
    firstChunkSeen = true;
    clearTimeout(coldStartTimer);
  };
  res.on('close', () => clearTimeout(coldStartTimer));

  const firstCall = toolsEnabled
    ? {
        payload: buildChatPayload(agentMessages, gen, { system: systemPrompt, tools }),
        onUsage: (u) => { usage = u; },
        onTimings: (t) => { lastTimings = t; },
        onFirstChunk: markFirstChunk,
      }
    : {
        payload: buildChatPayload(agentMessages, gen, {}),
        onDelta: (d) => safeWrite(res, contentChunk(d), lost),
        onUsage: (u) => { usage = u; },
        onTimings: (t) => { lastTimings = t; },
        onFirstChunk: markFirstChunk,
      };
  const firstPromise = complete(firstCall);
  const queuePosition = firstPromise.position || 1;

  openSse(res, queuePosition);

  // SSE keep-alive: comment-line heartbeats during stream inactivity so
  // proxies/browsers never drop a long-running request (queue waits, tool
  // steps, slow TTFT) while the server is still working. The frontend parser
  // only reads lines starting with "data:", so ": keep-alive" lines are
  // invisible to it. Fires only when nothing was written for a full interval.
  let lastSse = Date.now();
  const rawResWrite = res.write.bind(res);
  res.write = (chunk, enc, cb) => { lastSse = Date.now(); return rawResWrite(chunk, enc, cb); };
  const hb = setInterval(() => {
    if (lost || Date.now() - lastSse < config.sseHeartbeatMs) return;
    try { rawResWrite(': keep-alive\n\n'); lastSse = Date.now(); } catch { /* client gone */ }
  }, config.sseHeartbeatMs);
  res.on('close', () => clearInterval(hb));

  if (queuePosition > 1) {
    safeWrite(
      res,
      statusChunk(`⏳ Waiting in queue — position ${queuePosition}. A previous request is still processing; this one will start automatically…`),
      lost
    );
  }

  // Watermarked mid-loop compaction by the same deterministic replay: after
  // a round appends new messages, replay the accumulated list; an event
  // fires only when the running estimate crosses the high watermark
  // (sticky cut; never usage-calibrated).
  const compactIfNeeded = (where) => {
    if (lost) return;
    const c = historyManager.compactHistory(agentMessages, {
      high: budget.high,
      low: budget.low,
      keepTurns: config.contextKeepLastTurns,
    });
    if (!c.removed.length) return; // below high, or nothing compactable (protected window only)
    const delta = historyManager.compactionDelta(agentMessages, c.messages);
    agentMessages = c.messages;
    histTokens = c.after;
    historyManager.rememberLastCompactOutput(agentMessages);
    if (!delta.moved) return; // same stubs re-applied — cache no-op, stay quiet
    logCompaction(where, c.before, c.after, c.removed, delta.rePrefill, budget, () => lastTimings);
    safeWrite(res, statusChunk(trimNotice(delta.rePrefill, () => lastTimings)), lost);
  };

  // Plain-generation path with context-overflow recovery: compact the
  // history once and retry (never loops); used by the passthrough and the
  // empty-stream fallback. onUsage also calibrates the history estimate.
  const runPlain = async (firstAttempt, plainSys) => {
    const onUsageCb = (u) => {
      usage = u;
      if (u && Number.isFinite(u.prompt_tokens)) histTokens = u.prompt_tokens - config.promptPrefixTokens;
    };
    try {
      return await streamPlainAnswer(res, agentMessages, gen, onUsageCb, lost, firstAttempt, plainSys, (t) => { lastTimings = t; });
    } catch (e) {
      if (!historyManager.isContextError(e) || ctxRetried || lost) throw e;
      ctxRetried = true;
      const c = historyManager.compactHistory(agentMessages, {
        high: budget.high,
        low: budget.low,
        keepTurns: config.contextKeepLastTurns,
        force: true,
      });
      const rePrefill = historyManager.compactionDelta(agentMessages, c.messages).rePrefill;
      agentMessages = c.messages;
      histTokens = c.after;
      historyManager.rememberLastCompactOutput(agentMessages);
      logCompaction('post-overflow(plain)', c.before, c.after, c.removed, rePrefill, budget, () => lastTimings);
      safeWrite(res, statusChunk('⚠ Context limit reached — history trimmed, retrying once.'), lost);
      return await streamPlainAnswer(res, agentMessages, gen, onUsageCb, lost, null, plainSys, (t) => { lastTimings = t; });
    }
  };

  try {
    let finalText = '';
    // Live-streamed paths (passthrough / empty-stream fallback) already
    // pushed their text to the client token-by-token — the final flush below
    // must not re-emit it (which would duplicate the answer).
    let liveStreamed = false;

    if (!toolsEnabled) {
      // --- single-completion passthrough (tool calling off), with chunked
      // --- continuation: length-capped outputs are completed instead of
      // --- silently truncated mid-code. Text is streamed live by the helper.
      finalText = await runPlain(firstPromise, null);
      liveStreamed = true;
    } else {
      // --- agentic tool loop --------------------------------------------------
      let answered = false;
      let lastRoundContent = '';
      let automationRetries = 0;
      let automationSettled = false;
      let guardRetried = false; // no-tool guard retry: at most once per user message
      let forceToolChoice = false; // one-shot tool_choice:"required" for the retry
      for (let i = 0; i < config.toolMaxIterations; i++) {
        if (lost) break; // client gone — don't spend queue slots on nobody
        let acc;
        try {
          acc = await (i === 0 && !ctxRetried
                    ? firstPromise
                    : complete({
                        payload: buildChatPayload(agentMessages, gen, (() => {
                          const o = { system: systemPrompt, tools };
                          if (forceToolChoice) {
                            o.toolChoice = 'required'; // guard retry only — one request
                            forceToolChoice = false;
                          }
                          return o;
                        })()),
                        onUsage: (u) => { usage = u; },
                        onTimings: (t) => { lastTimings = t; },
                      }));
        } catch (e) {
          // A tool-enabled completion came back as an empty stream (some
          // providers/models cannot carry the tools array — OpenRouter/Phala
          // is known to do this). Instead of failing the whole turn, degrade
          // THIS request to plain generation: the model answers (tool-less)
          // and the user sees why. Real errors still propagate.
          if (EMPTY_STREAM_RE.test((e && e.message) || String(e)) && !lost) {
            safeWrite(
              res,
              statusChunk(
                '⚠ The model returned an empty stream while tool calling was enabled — re-running this request without tool calling. (If this keeps happening, switch the active model in Tools → Models.)'
              ),
              lost
            );
            finalText = await runPlain(null, plainSystemPrompt);
            liveStreamed = true;
            answered = true;
            break;
          }
          // Context overflow recovery: llama.cpp rejected the prompt because
          // it exceeds n_ctx. Compact the history deterministically down to
          // the low watermark and retry ONCE; a second overflow is a real
          // error (no loop). The notice tells the user the reply will slow
          // down (the trimmed part must be re-prefilled).
          if (historyManager.isContextError(e) && !ctxRetried && !lost) {
            ctxRetried = true;
            const c = historyManager.compactHistory(agentMessages, {
              high: budget.high,
              low: budget.low,
              keepTurns: config.contextKeepLastTurns,
              force: true,
            });
            const rePrefill = historyManager.compactionDelta(agentMessages, c.messages).rePrefill;
            agentMessages = c.messages;
            histTokens = c.after;
            historyManager.rememberLastCompactOutput(agentMessages);
            logCompaction('post-overflow', c.before, c.after, c.removed, rePrefill, budget, () => lastTimings);
            safeWrite(
              res,
              statusChunk('⚠ Context limit reached — history trimmed, retrying once.'),
              lost
            );
            i--; // redo this round with the compacted history
            continue;
          }
          throw e;
        }
        // Calibrate the running history estimate against the REAL prompt
        // length the server reported (usage.prompt_tokens, free with
        // stream_options.include_usage — never an extra model call).
        if (acc && acc.usage && Number.isFinite(acc.usage.prompt_tokens)) {
          histTokens = acc.usage.prompt_tokens - config.promptPrefixTokens;
        }

        // Collect the tool call(s) for this turn: native tool_calls first,
        // then the structured JSON-block fallback.
        const calls = [];
        for (const tc of acc.toolCalls) {
          const name = (tc.name || '').trim() || `tool_${i}`;
          calls.push({ name, args: toolLoop.safeParseArgs(tc.arguments) });
        }
        // Tolerant fallback parser (step 2): llama.cpp sometimes leaves a
        // correctly-shaped call wrapped in a tag (<function-calls>…) or a
        // fenced JSON block in the raw content with tool_calls empty. Only
        // the assistant's own content is ever parsed (tool results / user
        // messages can contain injected tags and are never passed here);
        // strictness rules live in toolCallParser — the name must exactly
        // match a registered tool and the arguments must be valid JSON,
        // otherwise nothing is executed and the message stays plain text.
        if (!calls.length) {
          const fb = toolCallParser.parseFallbackToolCall(
            acc.content,
            toolLoop.registry.map((t) => t.name)
          );
          if (fb.ok) {
            console.log(
              `[tool-fallback] variant=${fb.variant} calls=${fb.calls.length} tool=${fb.calls
                .map((c) => c.name)
                .join(',')}`
            );
            for (const c of fb.calls) calls.push({ name: c.name, args: c.args });
          }
        }
        if (!calls.length) {
          const c = toolLoop.extractToolCall(acc.content);
          // The extractor returns { tool, args }; normalize to { name, args } so
          // the loop below can treat fenced/JSON calls uniformly with native ones.
          if (c) calls.push({ name: c.tool, args: c.args });
        }

        if (!calls.length) {
          if (acc.finishReason === 'length' && acc.content.trim()) {
            // max_tokens cut the output mid-answer (possibly mid JSON tool
            // call): feed the partial back and let the model continue
            // instead of streaming truncated code as if it were final.
            const repeated = acc.content === lastRoundContent;
            lastRoundContent = acc.content;
            if (!repeated && !lost) {
              agentMessages.push({ role: 'assistant', content: acc.content });
              agentMessages.push({ role: 'user', content: CONTINUE_MSG });
              histTokens += historyManager.estimateTokens(acc.content) + historyManager.estimateTokens(CONTINUE_MSG);
              compactIfNeeded('continuation');
              finalText += acc.content;
              safeWrite(res, statusChunk(`✂ ${CONTINUE_STATUS} (tool-loop round ${i + 1})`), lost);
              continue; // not an answer yet — keep generating
            }
          }

          // --- automation-tool enforcement ------------------------------------
          // The user commanded an automation creation, but the model produced
          // prose / raw JSON instead of a create_automation call. Intercept:
          // 1) if the text carries a complete automation body (e.g. the curl
          //    JSON it was about to quote), execute it directly; 2) otherwise
          //    force a corrective tool-call round; 3) then fall back to
          //    grounded inference from the user's own wording.
          if (automationIntent && !automationSettled && !lost) {
            const payload =
              toolLoop.findAutomationPayload(acc.content) ||
              (automationRetries > 0 ? toolLoop.inferAutomationFromUser(firstUserText) : null);
            if (payload && createAutomationTool) {
              automationSettled = true;
              // Route through toolLoop.executeTool so the strict schema
              // validation + dedup ledger apply to intercepted calls too.
              const result = await toolLoop.executeTool('create_automation', payload);
              logToolCall('create_automation', payload, result, 0);
              agentMessages.push({ role: 'assistant', content: acc.content });
              agentMessages.push({
                role: 'user',
                content:
                  '[Tool result] create_automation: ' + JSON.stringify(result) +
                  (result.ok
                    ? '\nThe automation was created. Reply with a one-line confirmation naming it.'
                    : '\nThe creation failed — reply with a short error summary.'),
              });
              histTokens += historyManager.estimateTokens(acc.content) + historyManager.estimateTokens(JSON.stringify(result));
              compactIfNeeded('automation');
              safeWrite(
                res,
                statusChunk(result.ok
                  ? `⚙ Model output intercepted — automation created (${result.automation ? result.automation.id : payload.name}) via create_automation.`
                  : `⚠ Intercepted manual output; create_automation failed: ${result.error || 'unknown error'}`),
                lost
              );
              continue; // model confirms; the explanation is never streamed as the answer
            }
            if (automationRetries < config.maxAutomationForcedRounds) {
              automationRetries++;
              agentMessages.push({ role: 'assistant', content: acc.content });
              agentMessages.push({ role: 'user', content: FORCE_TOOL_MSG });
              histTokens += historyManager.estimateTokens(acc.content) + historyManager.estimateTokens(FORCE_TOOL_MSG);
              compactIfNeeded('automation-force');
              safeWrite(
                res,
                statusChunk(`⚠ Model explained instead of calling create_automation — forcing a tool call (round ${automationRetries}/${config.maxAutomationForcedRounds})`),
                lost
              );
              continue;
            }
            // Forced rounds exhausted and the model still cannot emit the
            // call: the server takes over and creates the automation from the
            // user's own wording (grounded inference — nothing invented).
            // The follow-up round (result fed back below) lets the model
            // confirm, so the user sees the created automation verified.
            let autoResult = null;
            try {
              autoResult = toolLoop.inferAutomationFromUser(firstUserText);
            } catch { autoResult = null; }
            if (autoResult && createAutomationTool) {
              automationSettled = true; // done — the follow-up confirms
              try {
                const result = await toolLoop.executeTool('create_automation', autoResult);
                logToolCall('create_automation', autoResult, result, 0);
                const created = result && result.ok;
                safeWrite(
                  res,
                  statusChunk(created
                    ? '⚠ Model output intercepted after retries — automation created directly from your wording.'
                    : `⚠ Intercepted output; direct creation failed: ${(result && result.error) || 'unknown error'}`),
                  lost
                );
                agentMessages.push({ role: 'assistant', content: JSON.stringify({ tool: 'create_automation', args: autoResult }) });
                agentMessages.push({
                  role: 'user',
                  content:
                    '[Tool result] create_automation: ' + JSON.stringify(result) +
                    (created
                      ? '\nThe automation was created by the server. Reply with a one-line confirmation naming it.'
                      : '\nThe creation failed — reply with a short error summary.'),
                });
                histTokens += historyManager.estimateTokens(JSON.stringify(result));
                compactIfNeeded('automation-direct');
                continue;
              } catch (e) {
                safeWrite(res, statusChunk('⚠ Direct automation creation crashed: ' + String((e && e.message) || e)), lost);
              }
            } else {
              safeWrite(res, statusChunk('⚠ The model did not produce a create_automation call and the schedule/action could not be inferred — automation NOT created.'), lost);
            }
            // Last resort: free the queue slot and end the loop with a
            // truthful summary instead of burning the remaining iterations.
            safeWrite(res, statusChunk(`Automation request aborted after ${automationRetries} forced round(s).`), lost);
            finalText += 'I could not complete the automation creation this time. Please try again or check the request wording.';
            answered = true;
            break;
          }

          // --- no-tool guard retry (step 3) -----------------------------------
          // The model described a shell block / curl / wget command instead of
          // calling a tool, on a request that needs live data or an action.
          // Retry ONCE with a stable instruction; the retried completion is the
          // only one that carries tool_choice:"required" (server support is a
          // config toggle). guardRetried makes "never retry twice, never loop"
          // structural.
          if (
            !guardRetried &&
            !lost &&
            toolCallParser.shouldGuardRetry({
              content: acc.content,
              userText: firstUserText,
              guardRetried,
            })
          ) {
            guardRetried = true;
            agentMessages.push({ role: 'assistant', content: acc.content });
            agentMessages.push({ role: 'user', content: toolCallParser.GUARD_RETRY_MSG });
            histTokens +=
              historyManager.estimateTokens(acc.content) +
              historyManager.estimateTokens(toolCallParser.GUARD_RETRY_MSG);
            compactIfNeeded('guard-retry');
            safeWrite(
              res,
              statusChunk('⚠ Model described a command instead of calling a tool — retrying once with tool calling forced.'),
              lost
            );
            forceToolChoice = true;
            continue;
          }

          // --- debug visibility (step 4) --------------------------------------
          // Genuine plain-text reply (no tool call, no fallback match): log
          // the finish reason and the start of the raw content so misbehavior
          // is visible in the server log (single line, JSON-escaped).
          console.log(
            `[llm-no-call] finish=${acc.finishReason || 'unknown'} content=${JSON.stringify(
              String(acc.content || '').slice(0, 300)
            )}`
          );

          // No tool call → genuine final answer; stop the loop.
          finalText += acc.content;
          answered = true;
          break;
        }

        // Record the model's tool-call turn as an assistant message, then the
        // results as a user message. (This llama build's chat template enforces
        // strict user/assistant alternation and rejects `role:"tool"` messages,
        // so results are wrapped in a user message.) Each result is truncated
        // ONCE at insertion (historyManager.formatToolResults) — the stored
        // text never changes afterwards, keeping the prompt byte-stable.
        const callText = calls
          .map((c) => JSON.stringify({ tool: c.name, args: c.args }))
          .join('\n');
        agentMessages.push({ role: 'assistant', content: callText });
        histTokens += historyManager.estimateTokens(callText);

        const results = [];
        for (const c of calls) {
          safeWrite(res, statusChunk('\u2699 ' + toolLabel(c.name, c.args)), lost);
          // The model legitimately performed the creation through the normal
          // tool path — mark the automation request settled so the final
          // explanation is NOT mistaken for an evasion and force-fed a
          // corrective round (the pre-fix behavior burned the iteration
          // budget and reported "max tool steps" for a task that had
          // actually succeeded).
          if (c.name === 'create_automation') automationSettled = true;
          let result;
          const t0 = Date.now();
          try {
            result = await toolLoop.executeTool(c.name, c.args);
          } catch (e) {
            // A throwing tool must never kill the ReAct loop or strand the
            // SSE stream mid-generation: convert to a result object so the
            // error is fed back to the model like any other outcome.
            result = { ok: false, error: `tool execution crashed: ${String((e && e.message) || e)}` };
          }
          logToolCall(c.name, c.args, result, Date.now() - t0);
          // Strict pre-execution validation (toolLoop.validateArgs) rejects
          // calls with missing/placeholder arguments BEFORE any side effect —
          // surface the corrective message live so the UI shows why the call
          // did not run; the result itself is fed back to the model, which
          // retries with complete arguments.
          if (result && result.invalidArgs) {
            safeWrite(
              res,
              statusChunk('⚠ Tool call rejected: ' + ((result.error || 'invalid arguments').slice(0, 220))),
              lost
            );
          }
          // Dedup intercepts (exact-args ledger / consecutive-run_shell guard)
          // also deserve a visible note: the ⚙ "Running command" line above is
          // emitted pre-execution, so without this the UI would look like the
          // command ran multiple times when it was actually deduplicated.
          if (result && result.skippedDuplicate) {
            safeWrite(
              res,
              statusChunk('⚠ ' + ((result.error || 'duplicate tool call skipped').slice(0, 220))),
              lost
            );
          }
          results.push({ name: c.name, result });
        }

        const resultsText = historyManager.formatToolResults(results);
        agentMessages.push({ role: 'user', content: resultsText });
        histTokens += historyManager.estimateTokens(resultsText);
        compactIfNeeded('tool-round');
      }
      if (!answered) {
        finalText =
          finalText ||
          '\u23f9 Reached the maximum number of tool steps without a final answer. Try simplifying the request.';
      }
    }

    if (!lost) {
      if (finalText && !liveStreamed) emitTextChunks(res, finalText, lost);
      if (usage) {
        safeWrite(
          res,
          usageChunk({ ...usage, elapsedMs: Date.now() - startTs, timings: lastTimings }),
          lost
        );
      }
      safeWrite(res, DONE_CHUNK, lost);
    }
    res.end();
  } catch (err) {
    // Headers already sent (SSE open) — report the failure as an event.
    try {
      safeWrite(res, statusChunk('\u26a0 ' + (err && err.message ? err.message : 'chat failed')), lost);
      safeWrite(res, DONE_CHUNK, lost);
      res.end();
    } catch { /* ignore */ }
  }
});

module.exports = router;