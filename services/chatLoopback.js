/**
 * services/chatLoopback.js — drive the agentic chat loop over HTTP.
 *
 * The Telegram channel (and any future channel) needs the exact same agentic
 * pipeline the browser uses: tool loop, automations enforcement, library
 * attachments, request queue, streaming continuation. Instead of duplicating
 * that logic, we POST the conversation to our own /api/chat endpoint and
 * consume the SSE stream. This reuses the queue (Telegram requests serialize
 * with browser chats on the single model slot) and keeps one source of truth
 * for agent behavior.
 *
 * Returns { text, statuses, usage } — the final answer plus the tool-activity
 * feed, which channels can render as a progress trail.
 */
const http = require('http');
const config = require('../config');

// Chat requests through the loopback can legitimately take a while (queue +
// multi-round tool loops); the server itself enforces stall timeouts. This is
// a backstop for a wedged upstream connection.
const AGENT_TIMEOUT_MS = 10 * 60 * 1000;

const DEFAULT_GENERATION = { temperature: 0.4, top_p: 0.95, max_tokens: 2048 };

/**
 * Run one agent session. `messages` is the OpenAI-style conversation to send
 * (system/assistant roles are managed by /api/chat); `attachments` are library
 * file ids resolved by the server. Resolves with the collected output.
 */
function runAgentSession({ messages, attachments, generation, onStatus, onUsage, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const payload = {
      messages: Array.isArray(messages) ? messages : [{ role: 'user', content: String(messages || '') }],
      stream: true,
      generation: { ...DEFAULT_GENERATION, ...(generation || {}) },
    };
    if (Array.isArray(attachments) && attachments.length) payload.attachments = attachments;
    const body = JSON.stringify(payload);

    const req = http.request(
      {
        host: '127.0.0.1',
        port: config.port,
        path: '/api/chat',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let buf = '';
        let full = '';
        const statuses = [];
        let usage = null;
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buf += chunk;
          let idx;
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line.startsWith('data:')) continue; // skip keep-alive comments
            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            try {
              const j = JSON.parse(data);
              if (j.type === 'status') {
                statuses.push(j.message);
                if (onStatus) onStatus(j.message);
                continue;
              }
              const delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
              if (delta) full += delta;
              if (j.usage) { usage = j.usage; if (onUsage) onUsage(j.usage); }
            } catch { /* partial chunk — skip */ }
          }
        });
        res.on('end', () => resolve({ text: full, statuses, usage }));
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs || AGENT_TIMEOUT_MS, () => {
      req.destroy(new Error('agent loopback request timed out'));
    });
    req.end(body);
  });
}

module.exports = { runAgentSession, AGENT_TIMEOUT_MS };