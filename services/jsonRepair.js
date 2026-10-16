/**
 * services/jsonRepair.js — auto-repair for LLM-mangled tool-call JSON.
 *
 * High-capability cloud models (Nemotron via OpenRouter, etc.) occasionally
 * emit tool-call payloads that fail strict JSON.parse: unescaped quotes or
 * newlines inside nested inline commands (`node -e "…"`), single-quoted
 * strings, unquoted keys, trailing commas, smart/curly quotes, Python-ish
 * None/True/False, truncation.
 *
 * SAFETY CONTRACT (the parse gate):
 *  - The fast path returns the ORIGINAL parse result untouched — repair only
 *    ever runs when JSON.parse FAILED, so valid documents are never touched
 *    (a curly quote inside a legit string can never be corrupted).
 *  - Every repair step produces a CANDIDATE string; a candidate is accepted
 *    ONLY if it JSON.parses. No heuristic output is ever trusted unchecked,
 *    and no repair step can turn one valid document into another — the
 *    original wasn't valid to begin with.
 *  - Callers keep their shape checks (plain object, registered tool name…)
 *    and their rejection flows: repair failure returns { ok:false } and the
 *    existing strict guards/hints fire unchanged.
 *  - Cost-bounded: candidates capped (24), scan cap 8 for huge docs, raw
 *    input capped at 256 KB.
 */
'use strict';

const MAX_INPUT = 256 * 1024;
const MAX_QUOTE_CANDIDATES = 24;
const MAX_QUOTE_CANDIDATES_BIG = 8; // docs > 32 KB
const BIG_DOC = 32 * 1024;

/** Convert one raw control char inside a string to its JSON escape (or drop
 *  it outside strings). */
function escapeControlChars(s, inStr, ch) {
  if (ch === '\n') return inStr ? '\\n' : '';
  if (ch === '\r') return inStr ? '\\r' : '';
  if (ch === '\t') return inStr ? '\\t' : '';
  return ''; // other C0 chars are never valid — drop in both cases
}

/**
 * Step 1 — cheap scoping fixes: trim, BOM, markdown fences, surrounding
 * backticks. Applied before scanning so quote analysis sees the payload.
 */
function stripFences(s) {
  let t = String(s || '').replace(/^\uFEFF/, '').trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/);
  if (fence) t = fence[1].trim();
  if (t.startsWith('`') && t.endsWith('`') && t.length > 1) {
    t = t.slice(1, -1).trim();
  }
  return t;
}

/**
 * Step 2 — squash every raw control char: escape inside strings, drop
 * outside. JSON forbids raw control characters everywhere, so this cannot
 * alter a parseable document (repair mode only).
 */
function squashControlChars(s) {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' && !esc) inStr = !inStr;
    if (esc) esc = false;
    else if (ch === '\\') esc = true;
    const code = ch.charCodeAt(0);
    if (code < 0x20) {
      out += escapeControlChars(s, inStr, ch);
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Step 3 — smart/curly quotes → straight. Only reachable in repair mode;
 * the candidate must still parse to be accepted.
 */
function curlify(s) {
  return s
    .replace(/[\u201C\u201D\u201E]/g, '"')
    .replace(/[\u2018\u2019]/g, "'");
}

/**
 * Step 4 — single-quoted strings → double-quoted (quote-aware scan; the
 * doc is already broken, so a tolerant scanner is acceptable).
 */
function singleToDouble(s) {
  let out = '';
  let inDq = false;
  let inSq = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (esc) { out += ch; esc = false; continue; }
    if (ch === '\\') { out += ch; esc = true; continue; }
    if (inSq) {
      if (ch === "'") { inSq = false; out += '"'; continue; } // CLOSE as a double quote
      if (ch === '"') { out += '\\"'; continue; } // escape inside sq
      out += ch;
      continue;
    }
    if (inDq) {
      if (ch === '"') inDq = false;
      out += ch;
      continue;
    }
    if (ch === '"') { inDq = true; out += ch; continue; }
    if (ch === "'") { inSq = true; out += '"'; continue; }
    out += ch;
  }
  return out;
}

/**
 * Step 5 — unquoted keys → quoted: `{cmd: "x"}` → `{"cmd": "x"}`.
 * Key pattern: [A-Za-z_$][A-Za-z0-9_$-]* immediately followed by `:`.
 */
function quoteKeys(s) {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (esc) { out += ch; esc = false; continue; }
    if (ch === '\\') { out += ch; esc = true; continue; }
    if (ch === '"') { inStr = !inStr; out += ch; continue; }
    if (inStr) { out += ch; continue; }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1;
      while (j < s.length && /[A-Za-z0-9_$-]/.test(s[j])) j++;
      // must be immediately followed by ':' (with optional ws) to be a key
      let k = j;
      while (k < s.length && s[k] === ' ') k++;
      if (k < s.length && s[k] === ':') {
        out += '"' + s.slice(i, j) + '"';
        i = j - 1;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

/**
 * Step 6 — trailing commas: `,` directly before `}`/`]` (outside strings).
 */
function dropTrailingCommas(s) {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (esc) { out += ch; esc = false; continue; }
    if (ch === '\\') { out += ch; esc = true; continue; }
    if (ch === '"') { inStr = !inStr; out += ch; continue; }
    if (!inStr && ch === ',') {
      let j = i + 1;
      while (j < s.length && (s[j] === ' ' || s[j] === '\n' || s[j] === '\t' || s[j] === '\r')) j++;
      if (j < s.length && (s[j] === '}' || s[j] === ']')) continue; // drop
    }
    out += ch;
  }
  return out;
}

/**
 * Step 7 — JS/Python literals: undefined/None/True/False → JSON literals
 * (word-boundary, outside strings).
 */
function fixLiterals(s) {
  const re = /\b(undefined|None|True|False)\b/g;
  const map = { undefined: 'null', None: 'null', True: 'true', False: 'false' };
  let out = '';
  let last = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (!inStr) {
      re.lastIndex = i;
      const m = re.exec(s);
      if (m && m.index === i) {
        out += s.slice(last, i) + map[m[0]];
        i += m[0].length - 1;
        last = i + 1;
        continue;
      }
    }
  }
  return out + s.slice(last);
}

/**
 * Step 8 — stray-double-quote repair: when a string region contains
 * UNESCAPED double quotes that should be literal content (the model nested
 * quotes in an inline `node -e "…"`), escape 1, 2 or 3 of the candidate
 * quotes at once and re-verify. Priority: singles over the whole doc
 * (earliest strays first), then k-combinations over the TAIL window — the
 * strays almost always sit in the final value string, right before the
 * closing braces, so the front-loaded pairs of a naive loop never reach
 * them. Cost-bounded (parse-verified candidates only).
 */
function escapeStrayQuotes(s) {
  const limit = s.length > BIG_DOC ? MAX_QUOTE_CANDIDATES_BIG : MAX_QUOTE_CANDIDATES;
  // Every unescaped '"' position.
  const quotes = [];
  for (let i = 1; i < s.length; i++) {
    if (s[i] !== '"') continue;
    let backslashes = 0;
    for (let j = i - 1; j >= 0 && s[j] === '\\'; j--) backslashes++;
    if (backslashes % 2 === 1) continue; // escaped
    quotes.push(i);
  }
  if (!quotes.length) return [];
  const candidates = [];
  const push = (idxSet) => {
    if (candidates.length >= limit * 4) return;
    let c = '';
    let last = 0;
    const positions = [...idxSet].sort((a, b) => a - b);
    for (const p of positions) {
      c += s.slice(last, p) + '\\"';
      last = p + 1;
    }
    // STRUCTURAL-BOUNDARY GUARD (the shape-corruption tell): if any escaped
    // quote is immediately followed by `,"key":` — a comma + quoted
    // identifier + colon — the quote was a DUAL-ROLE boundary (value close
    // AND next key open, e.g. `"path": "x.txt", "content:"…`), and escaping
    // it would merge two key/value pairs into one mangled string that still
    // parses. Reject: the repair must never swallow a key boundary.
    for (const p of positions) {
      let k = p + 1;
      while (k < s.length && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n' || s[k] === '\r')) k++;
      if (s[k] === ',') {
        const keyRe = /^[\s]*,\s*"[A-Za-z_$][A-Za-z0-9_$-]*(?:\s*:|"\s*:)/;
        if (keyRe.test(s.slice(k))) return; // boundary quote — drop candidate
      }
    }
    candidates.push(c + s.slice(last));
  };
  // k=1: every quote, earliest first.
  quotes.slice(0, limit).forEach((q) => push([q]));
  // k=2..4: combinations over the TAIL window — up to four unescaped
  // quotes can hide in one final inline command (e.g.
  // `python3 -c "print("hi")"` → 4 escapes + the closer), and the strays
  // always sit right before the closing braces. C(6,2)+C(6,3)+C(6,4)=50,
  // well inside the budget, and tail-priority keeps the cap from cutting
  // off the pairs that matter.
  const tail = quotes.slice(-TAIL_WINDOW);
  for (let k = 2; k <= 4 && candidates.length < limit * 4; k++) {
    const idx = Array.from({ length: k }, (_, i) => i);
    while (candidates.length < limit * 4) {
      push(idx.map((i) => tail[i]));
      let p = k - 1;
      while (p >= 0 && idx[p] === tail.length - k + p) p--;
      if (p < 0) break;
      idx[p]++;
      for (let q = p + 1; q < k; q++) idx[q] = idx[q - 1] + 1;
    }
  }
  return candidates.slice(0, limit * 4);
}

/** Step 8b — boundaries: `tail` window picks the LAST 6 quote positions
 *  (C(6,2)+C(6,3)=35 combos — small enough that the budget cap never
 *  front-loads early structural quotes and cuts off the tail pairs, which
 *  is where the strays always live). */
const TAIL_WINDOW = 6;

/**
 * Step 9 — truncation repair: if the scanner ends inside structure (not a
 * string) with small depth, append the missing closers. Unambiguous-ish
 * (the doc was already unparseable; the candidate still has to parse).
 */
function closeTruncated(s) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  const stack = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (inStr) {
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') { depth++; stack.push('}'); }
    else if (ch === '[') { depth++; stack.push(']'); }
    else if (ch === '}' || ch === ']') {
      depth--;
      stack.pop();
    }
  }
  if (inStr || depth <= 0 || depth > 3) return null;
  return s + stack.reverse().join('');
}

/**
 * Repair-mode shape gate: a repaired result is only accepted if every
 * object key is a clean simple key. The parse gate alone is not enough —
 * an escape candidate can mangle structural quotes into a weird-but-valid
 * key (e.g. `{"tool":"run_shell","args\":{"command":"echo hi"}`), which
 * JSON.parse happily accepts. Keys containing quotes/braces/brackets/colon
 * are never legitimate for our tool schemas, so they are rejected.
 * Fast path (unchanged valid JSON) is NEVER subject to this check.
 */
function keysClean(v) {
  if (Array.isArray(v)) return v.every(keysClean);
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) {
      if (typeof k !== 'string' || !/^[^"\\{}\[\]:,]+$/.test(k)) return false;
      if (!keysClean(v[k])) return false;
    }
  }
  return true;
}

/**
 * Parse tool-call JSON with the repair cascade.
 *
 * @param {string} raw
 * @returns {{ok: boolean, value?: any, repaired?: boolean, steps?: string[]}}
 *   ok=false ⇒ nothing (even repaired) parsed within the safety gates —
 *   the caller's strict rejection flow continues unchanged.
 */
function parseJsonRepaired(raw) {
  if (typeof raw !== 'string') {
    return { ok: false };
  }
  const input = raw.slice(0, MAX_INPUT);
  // Fast path: valid JSON is NEVER touched.
  try {
    return { ok: true, value: JSON.parse(input), repaired: false, steps: [] };
  } catch { /* fall through to repair */ }

  const steps = [];
  let t = stripFences(input);
  t = squashControlChars(t);
  try {
    const value = JSON.parse(t);
    if (keysClean(value)) {
      return { ok: true, value, repaired: true, steps: [...steps, 'strip'] };
    }
  } catch { /* continue */ }
  steps.push('strip');

  // Ordered candidate cascade — every candidate must parse AND have clean
  // keys to be accepted.
  const accept = (value) => keysClean(value);
  const transforms = [
    ['curly', curlify],
    ['single-quotes', singleToDouble],
    ['keys', quoteKeys],
    ['trailing-commas', dropTrailingCommas],
    ['literals', fixLiterals],
  ];
  for (const [name, fn] of transforms) {
    const candidate = fn(t);
    if (candidate === t) continue;
    try {
      const value = JSON.parse(candidate);
      if (accept(value)) {
        return { ok: true, value, repaired: true, steps: [...steps, name] };
      }
    } catch {
      /* not this one */
    }
    steps.push(name);
    t = candidate; // chain: later transforms build on the repaired shape
  }

  // Quote-escape candidates (each verified).
  for (const candidate of escapeStrayQuotes(t)) {
    try {
      const value = JSON.parse(candidate);
      if (accept(value)) {
        return { ok: true, value, repaired: true, steps: [...steps, 'stray-quotes'] };
      }
    } catch { /* next candidate */ }
  }
  if (!steps.includes('stray-quotes')) steps.push('stray-quotes');

  // Truncation close.
  const closed = closeTruncated(t);
  if (closed !== null) {
    try {
      const value = JSON.parse(closed);
      if (accept(value)) {
        return { ok: true, value, repaired: true, steps: [...steps, 'truncated'] };
      }
    } catch { steps.push('truncated'); }
  }

  // Full-document extraction (last resort): the JSON may be EMBEDDED in
  // prose or fences ("here is the call: ```json {…}```", or trailing
  // prose after the object). Extract candidate regions and re-run the
  // cascade on each — every result is still parse-verified + key-gated,
  // and the call-layer shape checks (registered tool name, exact args
  // schema) remain the final execution gate.
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const m of t.matchAll(fenceRe)) {
    if (!m[1] || !m[1].trim()) continue;
    const inner = parseJsonRepaired(m[1]);
    if (inner.ok) {
      return { ok: true, value: inner.value, repaired: true, steps: [...steps, 'fence'] };
    }
  }
  const region = firstBalancedRegion(t);
  if (region !== null && region !== t) {
    const inner = parseJsonRepaired(region);
    if (inner.ok) {
      return { ok: true, value: inner.value, repaired: true, steps: [...steps, 'embedded'] };
    }
  }

  return { ok: false, steps };
}

/**
 * The first balanced {...} region in the text (string-aware brace
 * matching) — used to lift a JSON object out of surrounding prose.
 * Returns null when no balanced region exists.
 */
function firstBalancedRegion(s) {
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let j = start; j < s.length; j++) {
    const ch = s[j];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (inStr) {
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(start, j + 1);
    }
  }
  return null;
}

module.exports = { parseJsonRepaired };