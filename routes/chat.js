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
 *   3. Loops until the model answers in plain text (no round ceiling) —
 *      streaming `type:"status"` events so the frontend shows what the
 *      agent is doing in real time. The only structural stop is the
 *      repeated-invalid-call freeze; otherwise the loop ends only on a
 *      final answer, a lost client, or a manual stop.
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
const fs = require('fs');
const path = require('path');
const config = require('../config');
const systemPromptSvc = require('../services/systemPrompt');
const { complete, buildChatPayload } = require('../services/llamaClient');
const toolLoop = require('../services/toolLoop');
const historyManager = require('../services/historyManager');
const libraryManager = require('../services/libraryManager');
const toolCallParser = require('../services/toolCallParser');
const cascadeService = require('../services/cascade');
const automationsTools = require('../tools/automationsTools');
const createAutomationTool = automationsTools.tools.find((t) => t.name === 'create_automation');

// --- SSE framing helpers -----------------------------------------------------
const contentChunk = (c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`;
const reasoningChunk = (r) => `data: ${JSON.stringify({ choices: [{ delta: { content: '', reasoning: r } }] })}\n\n`;
// Round boundary for live-streamed loop rounds: the frontend keeps the
// streamed text of the FINAL round (final:true) and wipes any earlier
// round's raw text (tool-call JSON / ROUTE_TO_PRIMARY markers) once the
// round concludes (final:false) — live tokens without tool-JSON pollution.
const roundChunk = (final) => `data: ${JSON.stringify({ type: 'round', final: !!final })}\n\n`;
const statusChunk = (m) => `data: ${JSON.stringify({ type: 'status', message: m })}\n\n`;
// Structured tool-run event: the DURABLE record of one executed (or
// dedup-skipped) tool step — tool name, arguments (bounded), outcome
// preview and a timestamp. The frontend persists it into the session
// message history, so tool rounds survive session switches/refreshes and
// can be replayed from history. Rejected (invalidArgs) calls stay status
// lines — they never executed and their corrective note is live-only.
const toolChunk = (entry) => `data: ${JSON.stringify({ type: 'tool', ...entry })}\n\n`;
const toolRunEvent = (name, args, result) => {
  let argsJson = '';
  try { argsJson = JSON.stringify(args || {}); } catch {}
  if (argsJson.length > 600) argsJson = argsJson.slice(0, 600) + '…[truncated]';
  const r = result || {};
  let out = String(r.stdout || r.stderr || '').trim();
  if (out.length > 400) out = out.slice(0, 400) + '…[truncated]';
  let error = String(r.error || '');
  if (error.length > 240) error = error.slice(0, 240) + '…[truncated]';
  return {
    ts: Date.now(),
    tool: name,
    args: argsJson,
    ok: r.ok === true,
    skipped: !!(r.skippedDuplicate || r.skippedRedundant || r.skippedAntiSpam),
    code: typeof r.code === 'number' ? r.code : undefined,
    out: out || undefined,
    error: error || undefined,
  };
};
const usageChunk = (u) => `data: ${JSON.stringify({ choices: [], usage: u })}\n\n`;
const DONE_CHUNK = 'data: [DONE]\n\n';

// ---------------------------------------------------------------------------
// Turn-state registry: /api/chat/state/:sessionId re-attachment recovery.
// While a POST /api/chat turn is running, safeWrite() mirrors every status
// line and streamed token into res._chatState (created below), and the GET
// route below exposes it. A frontend that lost its SSE reader (hard refresh
// mid-turn) can re-attach by polling the registry and replaying statuses +
// accumulated text; entries outlive the request by REATTACH_GRACE_MS so a
// late poller still sees the final state.
// ---------------------------------------------------------------------------
const REATTACH_GRACE_MS = 90 * 1000;
const chatTurnRegistry = new Map(); // 'chat:' + sessionId -> state record

function registerChatTurn(sessionId, res) {
  if (!sessionId) return null;
  const st = {
    sessionId,
    statuses: [],
    text: '',
    updatedAt: Date.now(),
    done: false,
  };
  res._chatState = st;
  chatTurnRegistry.set('chat:' + sessionId, st);
  return st;
}

/** Mark a turn finished; the record stays readable for the grace window. */
function finalizeChatTurn(sessionId, st) {
  if (!st) return;
  st.done = true;
  st.updatedAt = Date.now();
  if (!sessionId) return;
  setTimeout(() => {
    if (chatTurnRegistry.get('chat:' + sessionId) === st) {
      chatTurnRegistry.delete('chat:' + sessionId);
    }
  }, REATTACH_GRACE_MS);
}

router.get('/state/:sessionId', (req, res) => {
  const st = chatTurnRegistry.get('chat:' + String(req.params.sessionId || ''));
  if (!st) return res.status(404).json({ ok: false, error: 'no turn known for this session' });
  res.json({
    ok: true,
    active: !st.done,
    statuses: st.statuses,
    text: st.text,
    updatedAt: st.updatedAt,
  });
});

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

// Fed back when the final answer LOOKS like a tool call but could not be
// parsed (malformed JSON — unbalanced quotes, stray commas). Never serve
// raw JSON as the final answer; one corrective round re-emits the call.
const MALFORMED_TOOL_MSG =
  'Your previous reply looked like a tool call, but its JSON was malformed and could not ' +
  'be parsed, so NOTHING was executed. Re-emit the ENTIRE call as valid JSON now, with ' +
  'nothing before or after it, e.g. {"tool": "<tool_name>", "args": {...}} — mind the ' +
  'quotes and commas.';

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

// Swallow write-after-abort / socket-closed errors during shutdown. While a
// request is active it also mirrors every status line and streamed token into
// res._chatState (the recovery registry), so a client that lost its SSE socket
// can poll GET /api/chat/state/:sessionId and recover the turn. Recording
// happens even when `lost` — only the actual socket write is skipped then.
function safeWrite(res, chunk, lost) {
  const st = res && res._chatState;
  if (st && typeof chunk === 'string' && chunk.startsWith('data: ')) {
    try {
      const j = JSON.parse(chunk.slice(6));
      if (j && j.type === 'status' && typeof j.message === 'string') {
        st.statuses.push(String(j.message).slice(0, 300));
        if (st.statuses.length > 100) st.statuses.shift();
        st.updatedAt = Date.now();
      } else if (
        j && j.choices && j.choices[0] && j.choices[0].delta &&
        typeof j.choices[0].delta.content === 'string'
      ) {
        st.text = (st.text + j.choices[0].delta.content).slice(-2_000_000);
        st.updatedAt = Date.now();
      }
    } catch { /* not a JSON payload — ignore */ }
  }
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
// File labels resolve alias keys (file/filepath/filename/src) and bare-string
// args to `path` — same normalization as executeTool, so the status never
// shows "Reading file: ?" for a call that will actually execute. run_shell
// resolves the same alias set for `command` (cmd/exec/script/c/shell_command).
const FILE_PATH_ALIASES = ['file', 'filepath', 'file_path', 'filename', 'src', 'target'];
const SHELL_COMMAND_ALIASES = ['cmd', 'exec', 'script', 'c', 'shell_command'];
function labelCommand(a) {
  if (a === null || a === undefined) return '?';
  if (typeof a === 'string') return a.trim() || '?';
  if (typeof a !== 'object' || Array.isArray(a)) return '?';
  if (typeof a.command === 'string' && a.command.trim() !== '') return a.command;
  for (const alias of SHELL_COMMAND_ALIASES) {
    if (typeof a[alias] === 'string' && a[alias].trim() !== '') return a[alias];
  }
  return '?';
}
function labelPath(a) {
  if (a === null || a === undefined) return '?';
  if (typeof a === 'string') return a.trim() || '?';
  if (typeof a !== 'object' || Array.isArray(a)) return '?';
  if (typeof a.path === 'string' && a.path.trim() !== '') return a.path;
  for (const alias of FILE_PATH_ALIASES) {
    if (typeof a[alias] === 'string' && a[alias].trim() !== '') return a[alias];
  }
  return '?';
}
// Conversation-aware path recovery for file tools with unusable args: when
// the model calls read_file/write_file/edit_file with empty/missing args,
// the single existing file path in the conversation is overwhelmingly the
// intended target ("can you check and refactor: scripts/get_solana_price.py").
// Fill it ONLY when exactly one unique candidate exists AND it resolves to a
// real file inside the workspace — ambiguous or missing targets stay
// rejected (a rejected call is safe and teaches the model; a wrong read
// would confuse it). write/edit never EXECUTE on the filled path alone
// (content/old_text+new_text are still required), so this cannot overwrite
// anything without the model also supplying real content. delete_file is
// deliberately excluded (destructive).
const FILE_PATH_RE = /[\w./-]+\.(?:py|js|ts|sh|md|txt|json|ya?ml|toml|csv|html|css|log)\b/gi;
function recoverFilePath(msgs) {
  const text = (msgs || [])
    .map((m) => (m && typeof m.content === 'string' ? m.content : ''))
    .join('\n');
  const cands = [...new Set((text.match(FILE_PATH_RE) || []).map((s) => s.trim()))].filter(
    (s) => s.includes('/') && !/^https?:\/\//i.test(s)
  );
  if (cands.length !== 1) return null;
  const abs = path.resolve(config.workRoot, cands[0]);
  if (!(abs === config.workRoot || abs.startsWith(config.workRoot + path.sep))) return null;
  try {
    if (!fs.statSync(abs).isFile()) return null;
  } catch {
    return null;
  }
  return cands[0];
}

// Order-insensitive serialization of a call's args — used to count repeated
// IDENTICAL invalid emissions (the model re-emitting the same broken call is
// a stronger signal than the 7-round cap).
function stableArgsKey(args) {
  if (args === null || args === undefined || typeof args !== 'object') return '::' + String(args);
  return Object.keys(args)
    .sort()
    .map((k) => `${k}=${JSON.stringify(args[k])}`)
    .join('&');
}

function toolLabel(name, args) {
  const a = args || {};
  switch (name) {
    case 'read_file': return `Reading file: ${labelPath(a)}`;
    case 'write_file': return `Writing file: ${labelPath(a)}`;
    case 'edit_file': return `Editing file: ${labelPath(a)}`;
    case 'list_files': return `Listing directory: ${labelPath(a) !== '?' ? labelPath(a) : '.'}`;
    case 'run_shell': return `Running command: ${String(labelCommand(a)).slice(0, 90)}`;
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
async function streamPlainAnswer(res, agentMessages, gen, onUsage, lost, firstAttempt, plainSystem, onTimings, target) {
  let out = '';
  let prevLen = -1;
  for (let r = 0; r <= config.continuationMaxRounds; r++) {
    const acc = await (r === 0 && firstAttempt
      ? firstAttempt
      : complete({
          payload: buildChatPayload(agentMessages, gen, {
            ...(plainSystem ? { system: plainSystem } : {}),
            ...(target ? { target } : {}),
          }),
          // Socket-layer target override (doComplete/streamCompletions).
          target,
          onDelta: (d) => safeWrite(res, contentChunk(d), lost),
          onReasoning: (r) => safeWrite(res, reasoningChunk(r), lost),
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
  const { messages, stream = true, attachments } = req.body || {};
  // Session id for the turn-state registry (GET /api/chat/state/:sessionId):
  // purely a re-attachment key, never part of the model history.
  const sessionId = typeof (req.body && req.body.sessionId) === 'string' ? req.body.sessionId : null;
  const turnState = registerChatTurn(sessionId, res);
  const gen = req.body && typeof req.body.generation === 'object' ? req.body.generation : {};
  // Reasoning effort/visibility controller rides the gen object so EVERY
  // buildChatPayload call site (plain path, tool loop, cascade router)
  // inherits it from this one line; buildChatPayload maps it to payload
  // params (reasoning_effort / thinking budget) per endpoint class.
  const reasoningLevel = String((req.body && req.body.reasoningLevel) || '').toLowerCase();
  if (reasoningLevel && gen && typeof gen === 'object') gen.reasoningLevel = reasoningLevel;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }
  if (stream !== true) {
    return res.status(400).json({ error: 'only streaming (stream: true) is supported' });
  }

  const toolsEnabled = config.toolCallingEnabled && toolLoop.listTools().length > 0;
  // A persisted system-prompt override (System view) replaces the generated
  // template byte-for-byte, on both the tool path and the tool-less path.
  const generatedPrompt = toolsEnabled
    ? toolLoop.buildSystemPrompt(config.llamaSystemPrompt)
    : `${config.llamaSystemPrompt}\n\n${toolLoop.AUTOMATIONS_GUIDANCE}`;
  const systemPromptText = systemPromptSvc.getOverride() || generatedPrompt;
  const systemPrompt = systemPromptText;
  // Degraded/tool-less re-runs must NOT instruct JSON tool-call output (a
  // model that cannot carry the tools array would echo the call as plain
  // text); they get the base prompt only. The override still applies.
  const plainSystemPrompt = systemPromptSvc.getOverride() || `${config.llamaSystemPrompt}\n\n${toolLoop.AUTOMATIONS_GUIDANCE}`;

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

  // Two-stage cascade: a fast 'router' model handles stage 1 (intent + tool
  // selection), a heavy 'primary' model stage 2 (final generation). Resolved
  // fresh per request from the registry roles; when no router role exists the
  // classic single-model loop on the active model is used unchanged.
  const cascade = cascadeService.resolve();
  // Router-stage tools: the five core file/shell tools only (automation,
  // Library, skills are primary-model territory). Same byte-stable array for
  // warm-up and every router round — PROMPT-CACHE CONTRACT.
  const routerToolsArr = cascadeService.routerTools();
  // Names the router may actually execute at stage 1. Anchor for the
  // off-registry guard: a router-emitted call for ANY other registered tool
  // escalates to the primary without executing (see the guard inside the loop).
  // NOTE: routerToolsArr holds OpenAI-wrapped tools ({ type, function: { name } })
  // — read the name from the wrapped shape (t.name is undefined there; this
  // mistake once made the Set a single `undefined` and blocked ALL router calls).
  const routerToolNames = new Set(
    routerToolsArr.map((t) => (t && t.function && t.function.name) || t.name).filter(Boolean)
  );

  // Router-stage payloads must carry the ROUTER system prompt (agent prompt +
  // routing addendum). agentMessages holds the PRIMARY system prompt, so the
  // leading system message is swapped for router rounds (buildChatMessages
  // only injects opts.system when no system message exists). The swap is
  // byte-stable: same router prompt string every round -> KV cache stays
  // valid for the shared tail.
  const withRouterSystem = (msgs) =>
    cascade.enabled && Array.isArray(msgs) && msgs[0] && msgs[0].role === 'system'
      ? msgs.map((m, idx) => (idx === 0 ? { ...m, content: cascade.routerSystem } : m))
      : msgs;

  let usage = null;
  let lastTimings = null; // llama.cpp timings from the final chunk (cache + speeds)

  // Per-turn token telemetry: llama.cpp reports usage PER COMPLETION, so
  // accumulate completion_tokens across every round of this turn (router +
  // tool loop + final answer). The client's message badge then shows ONLY
  // what this response generated — never the cumulative session context.
  // prompt_tokens keeps the final round's value (the session context that
  // completion actually saw — used for the client budget + histTokens
  // calibration, which stay per-completion).
  const captureUsage = (u) => {
    if (!u) return;
    usage = {
      ...u,
      completion_tokens: (Number(usage && usage.completion_tokens) || 0) + (Number(u.completion_tokens) || 0),
    };
  };

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

  // Live-stream handlers shared by the pre-queued first completion AND every
  // tool-loop round: content deltas and reasoning traces are written to the
  // client as they arrive. roundStreamed records whether the current round
  // actually emitted tokens (declared here — firstCall is built above the
  // loop; the final-round flush decision reads it after the loop).
  let roundStreamed = false;
  const streamDelta = (d) => {
    roundStreamed = true;
    safeWrite(res, contentChunk(d), lost);
  };
  const streamReasoning = (r) => safeWrite(res, reasoningChunk(r), lost);

  const firstCall = toolsEnabled
    ? {
        payload: buildChatPayload(cascade.enabled ? withRouterSystem(agentMessages) : agentMessages, gen, cascade.enabled
          ? { system: cascade.routerSystem, tools: routerToolsArr, target: cascade.targets.router, maxTokens: config.routerMaxTokens, temperature: config.routerTemperature }
          : { system: systemPrompt, tools }),
        // Target override for the SOCKET layer (doComplete/streamCompletions) —
        // the payload-level target only stamps payload.model/samplers.
        target: cascade.enabled ? cascade.targets.router : undefined,
        // Stream round 1 live exactly like every other loop round (the
        // round-boundary events then keep or wipe the text as appropriate).
        onDelta: streamDelta,
        onReasoning: streamReasoning,
        onUsage: captureUsage,
        onTimings: (t) => { lastTimings = t; },
        onFirstChunk: markFirstChunk,
      }
    : {
        payload: buildChatPayload(agentMessages, gen, {}),
        onDelta: (d) => safeWrite(res, contentChunk(d), lost),
        onReasoning: (r) => safeWrite(res, reasoningChunk(r), lost),
        onUsage: captureUsage,
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

  if (cascade.enabled) {
    safeWrite(res, statusChunk(`⚡ ${cascade.router.name} — fast routing (intent + tool selection)…`), lost);
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
  const runPlain = async (firstAttempt, plainSys, target) => {
    const onUsageCb = (u) => {
      captureUsage(u);
      if (u && Number.isFinite(u.prompt_tokens)) histTokens = u.prompt_tokens - config.promptPrefixTokens;
    };
    try {
      return await streamPlainAnswer(res, agentMessages, gen, onUsageCb, lost, firstAttempt, plainSys, (t) => { lastTimings = t; }, target);
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
      return await streamPlainAnswer(res, agentMessages, gen, onUsageCb, lost, null, plainSys, (t) => { lastTimings = t; }, target);
    }
  };

  try {
    let finalText = '';
    // Live-streamed paths (passthrough / empty-stream fallback) already
    // pushed their text to the client token-by-token — the final flush below
    // must not re-emit it (which would duplicate the answer).
    let liveStreamed = false;
    // Same for the tool loop's FINAL round: it streams itself live, so the
    // flush must not re-emit it either. Declared here because the flush
    // block below lives OUTSIDE the tool-loop block. `roundStreamed` (the
    // handler-scope flag streamDelta sets above) records whether the CURRENT
    // round's deltas actually reached the client (some upstreams/models
    // never fire onDelta — an empty-string round, non-streaming mocks in
    // tests) — the flush is skipped ONLY when the final round really
    // streamed its text, otherwise the answer would be lost.
    let finalStreamedLive = false;

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
      let malformedCallRetried = false; // malformed tool-call correction: at most once per user message
      let forceToolChoice = false; // one-shot tool_choice:"required" for the retry
      // Cascade stage tracking: 'route' (fast router) until it answers
      // directly, escalates, or tools execute — then 'primary' for the rest of
      // the loop. Without a cascade the loop starts (and stays) in 'primary'
      // with stageTarget=null, i.e. the classic active-model behavior.
      let stage = cascade.enabled ? 'route' : 'primary';
      let stageTarget = cascade.enabled ? cascade.targets.router : null;
      let stageSystem = cascade.enabled ? cascade.routerSystem : systemPrompt;
      let firstRoundDone = false; // never re-await the pre-queued firstPromise
      // Loop termination (per user message): there is NO round ceiling —
      // the loop runs until the model answers in plain text, the client
      // disconnects, or the repeated-invalid-call freeze below stops it
      // (identical broken emissions make zero progress, so a 3× repeat
      // forces the final answer instead of spinning forever). Tool calls
      // are NEVER suppressed by history — identical repeats execute, so a
      // model re-running a grep or re-reading a file after an edit gets
      // fresh state (the dedup/anti-repetition guards were removed for
      // exactly this workflow).
      let frozen = false; // tool execution locked out; final answer forced
      let frozenRounds = 0;
      // Per-request count of IDENTICAL rejected emissions (name -> argsKey ->
      // count): the model repeating the exact same invalid call 3 times gets
      // frozen instead of repeating the same mistake forever.
      const rejectedCalls = new Map();
      // Live-streaming bookkeeping: loop rounds stream their deltas to the
      // client in real time (see onDelta/onReasoning below); the round
      // boundary events tell the frontend which text to keep. The FINAL
      // round streams itself — the end-of-request flush must not re-emit it.
      // (finalStreamedLive itself is declared at the handler scope — the
      // flush block reads it from outside this block.)
      const endRound = (final_) => safeWrite(res, roundChunk(final_), lost);
      const switchToPrimary = (why) => {
        if (stage === 'primary') return;
        stage = 'primary';
        stageTarget = cascade.targets.primary;
        stageSystem = systemPrompt;
        console.log(`[cascade] stage=primary (${why})`);
      };
      // No round ceiling: the loop ends only on a plain-text final answer,
      // a lost client, or the repeated-invalid-call freeze below.
      for (let i = 0; ; i++) {
        if (lost) break; // client gone — don't spend queue slots on nobody
        roundStreamed = false; // per-round: did THIS round's deltas reach the client?
        let acc;
        try {
          acc = await (i === 0 && !firstRoundDone
                    ? firstPromise
                    : complete({
                        payload: buildChatPayload(stage === 'route' && cascade.enabled ? withRouterSystem(agentMessages) : agentMessages, gen, (() => {
                          const o = { system: stageSystem, tools: stage === 'route' && cascade.enabled ? routerToolsArr : tools, target: stageTarget };
                          if (stage === 'route' && cascade.enabled) {
                            o.maxTokens = config.routerMaxTokens;
                            o.temperature = config.routerTemperature;
                          }
                          if (forceToolChoice) {
                            o.toolChoice = 'required'; // guard retry only — one request
                            forceToolChoice = false;
                          }
                          return o;
                        })()),
                        // Socket-layer target override (see firstCall above).
                        target: stageTarget,
                        // Live-stream this round's tokens to the client:
                        // content deltas as they arrive, reasoning traces as
                        // they arrive; round boundary events (roundChunk)
                        // let the frontend keep only the final round's text.
                        onDelta: streamDelta,
                        onReasoning: streamReasoning,
                        onUsage: captureUsage,
                        onTimings: (t) => { lastTimings = t; },
                      }));
          if (i === 0) firstRoundDone = true;
        } catch (e) {
          // The pre-queued first promise can never be re-awaited after any
          // failure — subsequent rounds use a fresh complete().
          if (i === 0) firstRoundDone = true;
          // Cascade graceful fallback (stage 1): ANY router failure
          // (unreachable, empty stream, HTTP error) escalates this round to
          // the primary model — the turn never dies on the fast model.
          if (cascade.enabled && stage === 'route' && !lost) {
            console.log(`[cascade] router fallback: ${String((e && e.message) || e).slice(0, 200)}`);
            safeWrite(
              res,
              statusChunk(`⚠ ${cascade.router.name} failed — falling back to ${cascade.primary.name} for this step.`),
              lost
            );
            switchToPrimary('router-error');
            i--; // redo this round on the primary
            continue;
          }
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
            finalText = await runPlain(null, plainSystemPrompt, stageTarget);
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
          // Each embedded call (Qwen2.5-Coder <tools>…</tools> blocks, JSON
          // contract objects) becomes its own call in this round, in the
          // order the model emitted them.
          for (const c of toolLoop.extractToolCalls(acc.content)) {
            calls.push({ name: c.tool, args: c.args });
          }
        }

        // The round's streamed deltas reached the client live (onDelta
        // below). If any tool call was parsed, this round's raw text is
        // transient tool JSON — close the round so the frontend wipes it;
        // the FINAL round (no calls) closes as final and its live text stays.
        if (calls.length) endRound(false);

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
              endRound(false); // partial max-tokens output — next round replaces it
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
          // Cascade: automation requests escalate to the primary immediately —
          // the router stage never carries automation/library/skills tools.
          if (cascade.enabled && stage === 'route' && automationIntent && !automationSettled && !lost) {
            safeWrite(res, statusChunk(`🧠 ${cascade.primary.name} — automation request delegated to the primary model (router has core tools only).`), lost);
            switchToPrimary('automation');
            continue;
          }
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
              endRound(false); // intercepted round text never becomes the answer
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
              endRound(false);
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
                endRound(false);
                continue;
              } catch (e) {
                safeWrite(res, statusChunk('⚠ Direct automation creation crashed: ' + String((e && e.message) || e)), lost);
              }
            } else {
              safeWrite(res, statusChunk('⚠ The model did not produce a create_automation call and the schedule/action could not be inferred — automation NOT created.'), lost);
            }
            // Last resort: free the queue slot and end the loop with a
            // truthful summary instead of burning further rounds without
            // progress.
            safeWrite(res, statusChunk(`Automation request aborted after ${automationRetries} forced round(s).`), lost);
            endRound(false);
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
            endRound(false); // described-command round text is never the answer
            continue;
          }

          // --- cascade routing decision (stage 1, no tool call) ----------------
          // The router either answered directly (fast final) or asked to
          // escalate: the ROUTE_TO_PRIMARY marker (or CASCADE_ESCALATE=always)
          // re-runs this round on the primary. The router's internal reply is
          // NEVER stored in history — the primary sees only the user context.
          if (cascade.enabled && stage === 'route') {
            if (cascadeService.decideNoCall(acc.content, cascade.escalate) === 'escalate') {
              console.log(
                `[cascade] route->primary ${cascade.escalate === 'always' ? '(escalate=always)' : '(marker)'} ` +
                  `routerReply=${JSON.stringify(String(acc.content || '').slice(0, 120))}`
              );
              safeWrite(
                res,
                statusChunk(`🧠 ${cascade.primary.name} — heavy reasoning/coding delegated to the primary model.`),
                lost
              );
              switchToPrimary(cascade.escalate === 'always' ? 'always' : 'marker');
              endRound(false); // ROUTE_TO_PRIMARY marker text is invisible glue
              continue;
            }
            // Router hallucinated an unregistered tool (e.g. {"tool":
            // "documentation",...}) — the parser refused it; never serve the
            // raw JSON as the final answer, let the primary handle the turn.
            if (cascadeService.looksLikeToolAttempt(acc.content)) {
              console.log(`[cascade] route->primary (unparseable tool attempt) routerReply=${JSON.stringify(String(acc.content || '').slice(0, 120))}`);
              safeWrite(
                res,
                statusChunk(`⚠ ${cascade.router.name} produced an unrecognized tool call — delegating to ${cascade.primary.name}.`),
                lost
              );
              switchToPrimary('unparseable-tool');
              endRound(false);
              continue;
            }
            // The router never executes-and-sees results (after a core-5 call
            // the primary takes over), so a no-call reply asserting an action
            // succeeded — "Skill removed successfully" after "remove
            // greeting.txt" — is a fabricated confirmation that would block
            // the real operation. Escalate: the primary re-does the work.
            if (cascadeService.looksLikeFabricatedConfirmation(acc.content, firstUserText)) {
              console.log(
                `[cascade] route->primary (fabricated confirmation) routerReply=${JSON.stringify(String(acc.content || '').slice(0, 120))}`
              );
              safeWrite(
                res,
                statusChunk(`⚠ ${cascade.router.name} replied without executing a tool — delegating to ${cascade.primary.name}.`),
                lost
              );
              switchToPrimary('fabricated-confirmation');
              endRound(false);
              continue;
            }
          }

          // --- malformed tool-call correction (primary stage) ----------------
          // The final answer LOOKS like a tool call (a {"tool":…} object or a
          // fenced block) but failed to parse — malformed JSON (unbalanced
          // quotes, stray commas). Serving the raw fragment as the answer
          // silently SKIPS the requested action; correct it ONCE so the model
          // re-emits valid JSON. Router-stage tool attempts never reach here
          // (they escalate via looksLikeToolAttempt above).
          if (!malformedCallRetried && !lost) {
            const rawContent = String(acc.content || '');
            const noCalls = !toolLoop.extractToolCalls(rawContent).length;
            const toolishStart = /^\s*\{\s*"(?:tool|name|function)"\s*:/.test(rawContent);
            const toolishFenced =
              /```(?:json)?[\s\S]*"(?:tool|name|function)"\s*:[\s\S]*```/.test(rawContent);
            if (noCalls && (toolishStart || toolishFenced)) {
              malformedCallRetried = true;
              console.log(
                `[tool-call] malformed tool-call reply — corrective round; content=${JSON.stringify(rawContent.slice(0, 140))}`
              );
              agentMessages.push({ role: 'assistant', content: acc.content });
              agentMessages.push({ role: 'user', content: MALFORMED_TOOL_MSG });
              histTokens +=
                historyManager.estimateTokens(acc.content) + historyManager.estimateTokens(MALFORMED_TOOL_MSG);
              compactIfNeeded('malformed-tool');
              safeWrite(
                res,
                statusChunk('⚠ Tool call could not be parsed (malformed JSON) — asking the model to re-emit it.'),
                lost
              );
              endRound(false);
              continue;
            }
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

          // No tool call → genuine final answer; stop the loop. The deltas
          // already streamed live above — close the round as FINAL so the
          // frontend keeps the live text, and skip the end-of-request flush
          // (ONLY when this round actually streamed; otherwise the flush
          // remains the only way the answer reaches the client).
          endRound(true);
          if (roundStreamed) finalStreamedLive = true;
          finalText += acc.content;
          answered = true;
          break;
        }

        // Cascade router-stage restriction: the router advertises ONLY the
          // core-5 file/shell tools (routerToolsArr), and may therefore only
          // EXECUTE those. A router-emitted call for any other registered
          // tool — a stage-1 hallucination (e.g. delete_skill, run_skill,
          // automations) — must not run: the primary is the only stage that
          // may invoke non-core tools. Escalate WITHOUT executing and keep
          // the router's internal reply out of history, exactly like the
          // unparseable-tool-attempt path.
          if (cascade.enabled && stage === 'route') {
            const offRegistry = calls.find((c) => !routerToolNames.has(c.name));
            if (offRegistry) {
              console.log(
                `[cascade] route->primary (off-registry tool call) routerCall=${JSON.stringify({ tool: offRegistry.name, args: offRegistry.args }).slice(0, 140)}`
              );
              safeWrite(
                res,
                statusChunk(`⚠ ${cascade.router.name} called ${offRegistry.name} — outside its core tool set; delegating to ${cascade.primary.name}.`),
                lost
              );
              switchToPrimary('off-registry-tool');
              endRound(false); // unexecuted hallucinated call — never shown as an answer
              continue;
            }
          }

          // --- repeated-invalid-call freeze (structural stop) -------------
          // The SAME invalid call was rejected 3× in this request: tool
          // execution is locked out (no progress is possible while the
          // model repeats a broken emission). Tell the model to write the
          // final answer from what it has, and after one more non-compliant
          // round close deterministically.
          if (frozen) {
            if (frozenRounds >= 1) {
              // The stop notice was ignored and tool calls were emitted again:
              // deterministic close — no further LLM/execution rounds.
              finalText =
                'The task was stopped because the same invalid tool call was repeated 3 times. Everything that ran is ' +
                'shown in the tool results above; anything not listed there was not completed. ' +
                'Please rephrase the request or ask for a specific step if something is missing.';
              endRound(false); // raw attempt text — the deterministic close follows
              answered = true;
              break;
            }
            frozen = true;
            frozenRounds++;
            const frozenCallText = calls
              .map((c) => JSON.stringify({ tool: c.name, args: c.args }))
              .join('\n');
            agentMessages.push({ role: 'assistant', content: frozenCallText });
            agentMessages.push({
              role: 'user',
              content:
                '[System] Execution stopped: the same invalid tool call was repeated 3 times, so ' +
                'no further tool calls will execute. Write your final ' +
                'answer NOW from the results you already have — say honestly what was completed and ' +
                'what was not.',
            });
            histTokens +=
              historyManager.estimateTokens(frozenCallText) + historyManager.estimateTokens(120);
            compactIfNeeded('anti-spam-stop');
            safeWrite(
              res,
              statusChunk('⛔ Tool execution frozen — forcing the final answer.'),
              lost
            );
            endRound(false); // frozen round's raw text — next round's stream replaces it
            continue;
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
        // Parallel-safe execution: independent calls of the round run
        // concurrently (single group), dependent/same-target/share-state
        // calls run in later groups in emission order. Results are
        // reassembled in EMISSION order, so history messages and log lines
        // are identical to a fully sequential run — only wall-clock time
        // shrinks. (groupIndependent guarantees identical duplicates can
        // never share a group, so same-target calls stay ordered.)
        const groups = toolLoop.groupIndependent(calls);
        const slots = new Array(calls.length);
        for (const group of groups) {
          await Promise.all(
            group.map(async (c) => {
              const idx = calls.indexOf(c);
              // read_file/write_file/edit_file with unusable args: recover the single
              // existing workspace path the conversation names (see
              // recoverFilePath). Other tools (run_shell, delete_skill,
              // delete_file, automations) are NEVER path-inferred.
              let inferred = false;
              if (
                (c.name === 'read_file' || c.name === 'write_file' || c.name === 'edit_file') &&
                labelPath(c.args) === '?'
              ) {
                const recovered = recoverFilePath(messages);
                if (recovered) {
                  c.args = { ...(c.args || {}), path: recovered };
                  inferred = true;
                }
              }
              safeWrite(
                res,
                statusChunk('⚙ ' + toolLabel(c.name, c.args) + (inferred ? ' (path inferred from conversation)' : '')),
                lost
              );
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
                // Fail fast on the SAME broken emission repeated: count
                // identical rejected calls per request; the 3rd identical
                // reject freezes the loop (the model is not correcting
                // itself, so further rounds only burn latency).
                let perName = rejectedCalls.get(c.name);
                if (!perName) {
                  perName = new Map();
                  rejectedCalls.set(c.name, perName);
                }
                const rkey = stableArgsKey(c.args);
                perName.set(rkey, (perName.get(rkey) || 0) + 1);
                if (perName.get(rkey) >= 3 && !frozen) {
                  frozen = true;
                  safeWrite(
                    res,
                    statusChunk('⛔ The same invalid tool call was repeated 3 times — tool loop stopped; forcing the final answer.'),
                    lost
                  );
                }
              }
              // Durable tool-step record (executed). Emitted
              // for every real outcome so the UI history shows what ran, with
              // what arguments and what result, at what time.
              safeWrite(res, toolChunk(toolRunEvent(c.name, c.args, result)), lost);
              slots[idx] = { name: c.name, result };
            })
          );
        }
        for (const r of slots) results.push(r);

        const resultsText = historyManager.formatToolResults(results);
        agentMessages.push({ role: 'user', content: resultsText });
        histTokens += historyManager.estimateTokens(resultsText);
        compactIfNeeded('tool-round');
        // Stage-2 hand-off: tools executed — the heavy model now generates
        // the final response from the full accumulated context.
        if (cascade.enabled && stage === 'route') {
          safeWrite(res, statusChunk(`🧠 ${cascade.primary.name} — tools executed, generating the final response.`), lost);
          switchToPrimary('tools-executed');
        }
      }
    }

    if (!lost) {
      if (finalText && !liveStreamed && !finalStreamedLive) emitTextChunks(res, finalText, lost);
      if (usage) {
        safeWrite(
          res,
          usageChunk({ ...usage, elapsedMs: Date.now() - startTs, timings: lastTimings }),
          lost
        );
      }
      safeWrite(res, DONE_CHUNK, lost);
    }
    finalizeChatTurn(sessionId, turnState);
    res.end();
  } catch (err) {
    // Headers already sent (SSE open) — report the failure as an event.
    try {
      safeWrite(res, statusChunk('\u26a0 ' + (err && err.message ? err.message : 'chat failed')), lost);
      safeWrite(res, DONE_CHUNK, lost);
      finalizeChatTurn(sessionId, turnState);
      res.end();
    } catch { /* ignore */ }
  }
});

module.exports = router;