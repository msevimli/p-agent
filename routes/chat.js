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
  'You were asked to CREATE an automation, but you answered with instructions instead ' +
  'of calling the tool. Reply with EXACTLY one JSON object now — no other text: ' +
  '{"tool": "create_automation", "args": {"name": "...", "schedule_type": "interval" or "cron", ' +
  '"interval_minutes": N or "cron": "5-field expression", "action_type": "script"|"skill"|"prompt", ' +
  '"script" / "skill" / "prompt": "..."}}. Use the schedule and action the user asked for.';

function openSse(res, queuePosition) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  if (queuePosition) res.setHeader('X-Queue-Position', String(queuePosition));
  res.flushHeaders();
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
    default: return `Calling tool: ${name}`;
  }
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

router.post('/', async (req, res) => {
  const { messages, stream = true } = req.body || {};
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
  const tools = toolsEnabled ? toolLoop.toOpenAITools() : undefined;

  // Working conversation history (system-first) mutated by the loop.
  let agentMessages = ensureSystem(messages, systemPrompt);
  let lost = false;
  res.on('close', () => { lost = true; });

  // Automation-creation interception: if the CURRENT user turn commands an
  // automation creation (imperatively — "how do I..." does NOT match), a
  // model answer without a tool call is intercepted and forced.
  const lastUserMsg = [...(messages || [])].reverse().find((m) => m && m.role === 'user');
  const firstUserText = (lastUserMsg && lastUserMsg.content) || '';
  const automationIntent = !!toolsEnabled && !!firstUserText && toolLoop.isAutomationCreationRequest(firstUserText);

  let usage = null;
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
  const firstCall = toolsEnabled
    ? { payload: buildChatPayload(agentMessages, gen, { system: systemPrompt, tools }), onUsage: (u) => { usage = u; } }
    : {
        payload: buildChatPayload(agentMessages, gen, {}),
        onDelta: (d) => safeWrite(res, contentChunk(d), lost),
        onUsage: (u) => { usage = u; },
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

  try {
    let finalText = '';

    if (!toolsEnabled) {
      // --- single-completion passthrough (tool calling off), with chunked
      // --- continuation: length-capped outputs are completed instead of
      // --- silently truncated mid-code.
      let prevLen = -1;
      for (let r = 0; r <= config.continuationMaxRounds; r++) {
        const acc = await (r === 0
          ? firstPromise
          : complete({
              payload: buildChatPayload(agentMessages, gen, {}),
              onDelta: (d) => safeWrite(res, contentChunk(d), lost),
              onUsage: (u) => { usage = u; },
            }));
        finalText += acc.content;
        const capped = acc.finishReason === 'length';
        const progress = acc.content.length > prevLen;
        if (!capped || !progress) break; // finished, or the model made no headway
        prevLen = acc.content.length;
        agentMessages.push({ role: 'assistant', content: acc.content });
        agentMessages.push({ role: 'user', content: CONTINUE_MSG });
        safeWrite(res, statusChunk(`✂ ${CONTINUE_STATUS} (round ${r + 1}/${config.continuationMaxRounds})`), lost);
        if (lost) break; // nobody is listening — free the queue slot
      }
    } else {
      // --- agentic tool loop --------------------------------------------------
      let answered = false;
      let lastRoundContent = '';
      let automationRetries = 0;
      let automationSettled = false;
      for (let i = 0; i < config.toolMaxIterations; i++) {
        if (lost) break; // client gone — don't spend queue slots on nobody
        const acc = await (i === 0
          ? firstPromise
          : complete({
              payload: buildChatPayload(agentMessages, gen, { system: systemPrompt, tools }),
              onUsage: (u) => { usage = u; },
            }));

        // Collect the tool call(s) for this turn: native tool_calls first,
        // then the structured JSON-block fallback.
        const calls = [];
        for (const tc of acc.toolCalls) {
          const name = (tc.name || '').trim() || `tool_${i}`;
          calls.push({ name, args: toolLoop.safeParseArgs(tc.arguments) });
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
              const result = await createAutomationTool.execute(payload);
              agentMessages.push({ role: 'assistant', content: acc.content });
              agentMessages.push({
                role: 'user',
                content:
                  '[Tool result] create_automation: ' + JSON.stringify(result) +
                  (result.ok
                    ? '\nThe automation was created. Reply with a one-line confirmation naming it.'
                    : '\nThe creation failed — reply with a short error summary.'),
              });
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
              safeWrite(
                res,
                statusChunk(`⚠ Model explained instead of calling create_automation — forcing a tool call (round ${automationRetries}/${config.maxAutomationForcedRounds})`),
                lost
              );
              continue;
            }
            safeWrite(res, statusChunk('⚠ The model did not produce a create_automation call — automation NOT created.'), lost);
          }

          // No tool call → genuine final answer; stop the loop.
          finalText += acc.content;
          answered = true;
          break;
        }

        // Record the model's tool-call turn as an assistant message, then the
        // results as a user message. (This llama build's chat template enforces
        // strict user/assistant alternation and rejects `role:"tool"` messages,
        // so we keep the history alternating to stay template-safe.)
        agentMessages.push({
          role: 'assistant',
          content: calls.map((c) => JSON.stringify({ tool: c.name, args: c.args })).join('\n'),
        });

        const results = [];
        for (const c of calls) {
          safeWrite(res, statusChunk('\u2699 ' + toolLabel(c.name, c.args)), lost);
          results.push({ name: c.name, result: await toolLoop.executeTool(c.name, c.args) });
        }

        agentMessages.push({
          role: 'user',
          content:
            '[Tool results]\n' +
            results.map((r) => `${r.name}: ${JSON.stringify(r.result)}`).join('\n') +
            '\nContinue working; use more tools if needed, then reply with your final answer.',
        });
      }
      if (!answered) {
        finalText =
          finalText ||
          '\u23f9 Reached the maximum number of tool steps without a final answer. Try simplifying the request.';
      }
    }

    if (!lost) {
      emitTextChunks(res, finalText, lost);
      if (usage) safeWrite(res, usageChunk({ ...usage, elapsedMs: Date.now() - startTs }), lost);
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