#!/usr/bin/env node
/**
 * json-repair-tests.js — unit nets for services/jsonRepair.js (the
 * auto-repair fallback for LLM-mangled tool-call JSON).
 *
 * Every net asserts the SAFETY contract too: valid JSON is never touched
 * (fast path), a repaired result must JSON.parse, and hopeless input still
 * fails cleanly (callers keep their strict rejection flows).
 */
'use strict';

const { parseJsonRepaired } = require('../services/jsonRepair');

const results = [];
let n = 0;
function t(name, cond, detail) {
  n++;
  results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`);
}
function ok(name, got, want) {
  t(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}

// ----------------------------------------------------------------------
// 0. Fast path — valid JSON untouched (never enters repair)
// ----------------------------------------------------------------------
{
  const r = parseJsonRepaired('{"tool":"run_shell","args":{"command":"free -h"}}');
  t('fast path: valid JSON parses with repaired=false', r.ok && r.repaired === false, JSON.stringify(r));
  ok('fast path: value intact', r.value, { tool: 'run_shell', args: { command: 'free -h' } });
}

// ----------------------------------------------------------------------
// 1. The reported case — unescaped quotes inside inline node -e
// ----------------------------------------------------------------------
{
  // Nested double quotes inside the cmd value (the "heavily escaped"
  // failure mode): node -e "console.log(1)" with the inner quotes unescaped.
  const raw = '{"tool":"run_shell","args":{"command":"node -e "console.log(1)""}}';
  const r = parseJsonRepaired(raw);
  t('node -e stray quotes: repaired + parsed', r.ok && r.repaired === true && r.value.args.command === 'node -e "console.log(1)"', JSON.stringify(r.value));
}
{
  // Unescaped quotes + the closing brace survives (worst case from the report).
  const raw = '{"tool":"run_shell","args":{"command":"node -e "let x=1; console.log(x)""}}';
  const r = parseJsonRepaired(raw);
  t('node -e with braces inside: repaired', r.ok && r.repaired === true && r.value.args.command.includes('let x=1'), r.ok ? r.value.args.command : 'FAIL');
}
{
  // Two stray quotes inside one value.
  const raw = '{"tool":"run_shell","args":{"command":"python3 -c "print("hi")""}}';
  const r = parseJsonRepaired(raw);
  t('two stray quotes: repaired', r.ok && r.value.args.command === 'python3 -c "print("hi")"', r.ok ? r.value.args.command : 'FAIL');
}

// ----------------------------------------------------------------------
// 2. Markdown fences / backticks around the call
// ----------------------------------------------------------------------
{
  const r = parseJsonRepaired('```json\n{"tool":"run_shell","args":{"command":"ls -la"}}\n```');
  t('fenced ```json block: repaired', r.ok && r.repaired === true && r.value.args.command === 'ls -la', '');
}
{
  const r = parseJsonRepaired('`{"tool":"run_shell","args":{"command":"pwd"}}`');
  t('backtick-wrapped JSON: repaired', r.ok && r.value.args.command === 'pwd', '');
}
{
  const r = parseJsonRepaired('Some prose before\n```{"tool":"read_file","args":{"path":"a.txt"}}```\nafter');
  t('fence embedded in prose: repaired via strip', r.ok && r.value.tool === 'read_file', '');
}

// ----------------------------------------------------------------------
// 3. Single-quoted strings
// ----------------------------------------------------------------------
{
  const r = parseJsonRepaired("{'tool':'run_shell','args':{'command':'echo hi'}}");
  t('single-quoted keys+values: repaired', r.ok && r.value.tool === 'run_shell' && r.value.args.command === 'echo hi', JSON.stringify(r.value));
}
{
  // Mixed: single-quoted wrapper around content with legit inner doubles.
  const r = parseJsonRepaired("{'tool':'run_shell','args':{'command':'echo \"already quoted\"'}}");
  t('single quotes wrapping embedded doubles: repaired', r.ok && r.value.args.command === 'echo "already quoted"', r.ok ? r.value.args.command : 'FAIL');
}

// ----------------------------------------------------------------------
// 4. Unquoted keys
// ----------------------------------------------------------------------
{
  const r = parseJsonRepaired('{tool:"run_shell",args:{command:"df -h"}}');
  t('unquoted keys: repaired', r.ok && r.value.tool === 'run_shell' && r.value.args.command === 'df -h', JSON.stringify(r.value));
}

// ----------------------------------------------------------------------
// 5. Trailing commas
// ----------------------------------------------------------------------
{
  const r = parseJsonRepaired('{"tool":"run_shell","args":{"command":"whoami",}}');
  t('trailing comma: repaired', r.ok && r.value.args.command === 'whoami', '');
}
{
  const r = parseJsonRepaired('{"tool":"run_shell","args":{"command":"echo a","timeout_ms":100,}}');
  t('trailing comma with extra key: repaired', r.ok && r.value.args.timeout_ms === 100, '');
}

// ----------------------------------------------------------------------
// 6. JS/Python literals
// ----------------------------------------------------------------------
{
  const r = parseJsonRepaired('{"tool":"run_shell","args":{"command":"echo ok","timeout_ms":undefined}}');
  t('undefined literal: repaired', r.ok && r.value.args.timeout_ms === null, JSON.stringify(r.value.args));
}
{
  const r = parseJsonRepaired('{"tool":"run_shell","args":{"command":"echo ok","flag":True},"extra":False,"nil":None}');
  t('True/False/None: repaired', r.ok && r.value.args.flag === true && r.value.extra === false && r.value.nil === null, JSON.stringify(r.value));
}
{
  // Word only OUTSIDE strings must change; a legit "True" inside a string stays.
  const r = parseJsonRepaired('{"tool":"run_shell","args":{"command":"echo True"}}');
  t('literal inside string untouched', r.ok && r.value.args.command === 'echo True', r.ok ? r.value.args.command : 'FAIL');
}

// ----------------------------------------------------------------------
// 7. Smart/curly quotes
// ----------------------------------------------------------------------
{
  const r = parseJsonRepaired('{\u201Ctool\u201D:\u201Crun_shell\u201D,\u201Cargs\u201D:{\u201Ccommand\u201D:\u201Cecho hi\u201D}}');
  t('curly quotes: repaired', r.ok && r.value.tool === 'run_shell' && r.value.args.command === 'echo hi', '');
}

// ----------------------------------------------------------------------
// 8. Raw newlines/control chars inside values
// ----------------------------------------------------------------------
{
  const raw = '{"tool":"write_file","args":{"path":"scripts/a.py","content":"line1\nline2"}}';
  const r = parseJsonRepaired(raw);
  t('raw newline in string: repaired to \\n', r.ok && r.value.args.content === 'line1\nline2', r.ok ? JSON.stringify(r.value.args.content) : 'FAIL');
}
{
  const raw = '{"tool":"run_shell","args":{"command":"echo a\tb"}}';
  const r = parseJsonRepaired(raw);
  t('raw tab in string: repaired to \\t', r.ok && r.value.args.command === 'echo a\tb', r.ok ? JSON.stringify(r.value.args.command) : 'FAIL');
}

// ----------------------------------------------------------------------
// 9. Truncation
// ----------------------------------------------------------------------
{
  const r = parseJsonRepaired('{"tool":"run_shell","args":{"command":"free -h"');
  t('truncated (missing }): repaired', r.ok && r.value.args.command === 'free -h', r.ok ? 'ok' : 'FAIL');
}
{
  const r = parseJsonRepaired('{"tool":"run_shell","args":{"command":"top -bn1"}}');
  t('truncation candidate still wrong shape → repaired via close or none', r.ok === true && (r.repaired === false || r.ok), '');
}
{
  // Truncation must NOT fire when a string is unterminated — closing would
  // corrupt; the candidate must parse before acceptance (it won't).
  const r = parseJsonRepaired('{"tool":"run_shell","args":{"command":"echo "unterminated');
  t('unterminated string: no bogus repair', r.ok === false, JSON.stringify(r));
}

// ----------------------------------------------------------------------
// 10. Combined cascades (overlapping defects)
// ----------------------------------------------------------------------
{
  const raw = "```json\n{tool: 'run_shell', args: {command: 'node -e \"console.log(1)\"', timeout_ms: 5000,}}\n```";
  const r = parseJsonRepaired(raw);
  t('fence + unquoted keys + single quotes + trailing comma: repaired', r.ok && r.value.tool === 'run_shell' && r.value.args.command === 'node -e "console.log(1)"' && r.value.args.timeout_ms === 5000, r.ok ? JSON.stringify(r.value) : 'FAIL');
}

// ----------------------------------------------------------------------
// 11. Safety guards — hopeless input still fails cleanly
// ----------------------------------------------------------------------
{
  const r = parseJsonRepaired('this is not json at all {{{{');
  t('garbage: ok=false', r.ok === false, '');
}
{
  const r = parseJsonRepaired('{"tool":"run_shell","args":{"command":"echo hi"}} trailing garbage');
  t('valid JSON + trailing garbage: still repaired or fails, never a wrong value', r.ok === true && r.value.args.command === 'echo hi', '');
}
{
  const r = parseJsonRepaired('{"tool":"run_shell","args":{"command":"echo hi"}');
  t('brace-balanced truncation signal: ok', r.ok === true && r.value.args.command === 'echo hi', '');
}

// ----------------------------------------------------------------------
// 12. Integration: the parse sites that consume the repair
// ----------------------------------------------------------------------
{
  // toolLoop.safeParseArgs + extractToolCalls through the real module.
  const tl = require('../services/toolLoop');
  const args = tl.safeParseArgs('{"cmd": "node -e "console.log(1)""}');
  t('safeParseArgs repairs the node -e case', args.cmd === 'node -e "console.log(1)"', JSON.stringify(args));
  const calls = tl.extractToolCalls('```json\n{"tool":"run_shell","args":{"command":"df -h",}}\n```');
  t('extractToolCalls repairs fenced trailing comma', calls.length === 1 && calls[0].args.command === 'df -h', JSON.stringify(calls));
  // toolCallParser fallback path.
  const tcp = require('../services/toolCallParser');
  const fb = tcp.parseFallbackToolCall(
    '<tools>{"name":"run_shell","arguments":"{\\"command\\": \\"node -e \\\\\\"console.log(1)\\\\\\"\\"}"}</tools>',
    ['run_shell']
  );
  t('toolCallParser repairs double-encoded arguments', fb.ok === true && fb.calls.length === 1 && fb.calls[0].args.command === 'node -e "console.log(1)"', JSON.stringify(fb.calls));
}

// ----------------------------------------------------------------------
// 13. CODE PAYLOADS — embedded script quotes in write_file / write_skill
//     values (the reported edge case: `data["solana"]["usd"]`, f-strings).
//     Strays sit ANYWHERE in the value, often 6+ at once — beyond the
//     tail-combination budget — so the span-based code-quotes step must
//     repair them.
// ----------------------------------------------------------------------
{
  // The reported shape: quoted-string args + unescaped bracket lookups +
  // f-string, far from the doc tail (literal \n escapes in the value).
  const raw =
    '{"tool":"write_file","args":{"path":"run.py","content":"import requests\\ndata = requests.get(url).json()["solana"]["usd"]\\nprint(f"{value}")"}}';
  const r = parseJsonRepaired(raw);
  const want = 'import requests\ndata = requests.get(url).json()["solana"]["usd"]\nprint(f"{value}")';
  t('code payload: bracket lookups + f-string repaired (exact content)', r.ok && r.repaired === true && r.value.args.content === want, r.ok ? JSON.stringify(r.value.args.content) : 'FAIL');
  t('code payload: repaired via the code-quotes step', r.repaired === true && r.steps.includes('code-quotes'), JSON.stringify(r.steps));
}
{
  // Same payload with RAW newlines (must compose with squashControlChars).
  const raw = '{"tool":"write_file","args":{"path":"run.py","content":"import requests\n' + 'data = requests.get(url).json()["solana"]["usd"]\n' + 'print(f"{value}")"}}';
  const r = parseJsonRepaired(raw);
  t('code payload: raw-newline variant repaired', r.ok && r.value.args.content === 'import requests\ndata = requests.get(url).json()["solana"]["usd"]\nprint(f"{value}")', r.ok ? JSON.stringify(r.value.args.content) : 'FAIL');
}
{
  // Multi-file skills map: TWO broken values, both escaped in one pass.
  const raw = '{"tool":"write_skill","args":{"name":"p","files":{"run.py":"print(d["a"])","main.py":"x = f"{y}""}}}';
  const r = parseJsonRepaired(raw);
  t('code payload: write_skill files map (two values) repaired', r.ok && r.repaired === true && r.value.args.files['run.py'] === 'print(d["a"])' && r.value.args.files['main.py'] === 'x = f"{y}"', r.ok ? JSON.stringify(r.value.args.files) : 'FAIL');
}
{
  // Array literal in code makes the first comma-followed quote a FALSE
  // closer — the second/third closer choice must recover.
  const raw = '{"tool":"write_file","args":{"path":"t.py","content":"items = ["a", "b"]\\nfor i in items:\\n    print(i)\\ndone = f"{n} ok""}}';
  const r = parseJsonRepaired(raw);
  const want = 'items = ["a", "b"]\nfor i in items:\n    print(i)\ndone = f"{n} ok"';
  t('code payload: array-literal false closer recovered', r.ok && r.value.args.content === want, r.ok ? JSON.stringify(r.value.args.content) : 'FAIL');
}
{
  // Dict literal INSIDE the code: `{"a": "b"}` — the inner b-close followed
  // by } is a false closer; the true closer still wins.
  const raw = '{"tool":"write_file","args":{"path":"c.py","content":"cfg = {"a": "b"}; print(cfg["a"])"}}';
  const r = parseJsonRepaired(raw);
  t('code payload: dict literal inside code repaired', r.ok && r.value.args.content === 'cfg = {"a": "b"}; print(cfg["a"])', r.ok ? JSON.stringify(r.value.args.content) : 'FAIL');
}
{
  // Prose with UNESCAPED quotes (same defect class, text instead of code).
  const raw = '{"tool":"write_file","args":{"path":"a.txt","content":"say "hi" then "bye""}}';
  const r = parseJsonRepaired(raw);
  t('code payload: prose quotes in a value repaired', r.ok && r.value.args.content === 'say "hi" then "bye"', r.ok ? JSON.stringify(r.value.args.content) : 'FAIL');
}
{
  // Mixed: properly escaped quotes PRESERVED while strays get escaped.
  const raw = '{"tool":"write_file","args":{"path":"b.txt","content":"use \\"escaped\\" and "oops""}}';
  const r = parseJsonRepaired(raw);
  t('code payload: escaped quotes preserved, strays escaped', r.ok && r.value.args.content === 'use "escaped" and "oops"', r.ok ? JSON.stringify(r.value.args.content) : 'FAIL');
}
{
  // Early-position strays with a LATER healthy value (strays not in the
  // tail window; per-value span repair must find them anyway).
  const raw = '{"tool":"write_skill","args":{"name":"s","files":{"gen.py":"out = open("f.txt", "w")\\nout.write(data["k"])","readme.md":"# fine"}}}';
  const r = parseJsonRepaired(raw);
  t('code payload: early strays + healthy sibling repaired', r.ok && r.value.args.files['gen.py'] === 'out = open("f.txt", "w")\nout.write(data["k"])', r.ok ? JSON.stringify(r.value.args.files) : 'FAIL');
}
{
  // REGRESSION: the dual-role boundary shape must STILL be rejected
  // (structural gate + keysClean — never a mangled-but-parseable accept).
  const r = parseJsonRepaired('{"tool": "write_file", "args": {"path": "x.txt", "content:"broken"}}');
  t('REGRESSION: dual-role boundary shape still rejected', r.ok === false, JSON.stringify(r.steps));
}
{
  // REGRESSION: hopeless payload stays rejected (no over-guessing).
  const r = parseJsonRepaired('{"tool":"write_file","args":{"content":"still open');
  t('REGRESSION: hopeless payload stays rejected', r.ok === false, JSON.stringify(r.steps));
}

const fails = results.filter((x) => x.startsWith('FAIL')).length;
console.log(results.join('\n'));
console.log(`\n${results.length - fails}/${results.length} json-repair checks passed${fails ? ` (${fails} FAILED)` : ''}`);
process.exit(fails ? 1 : 0);