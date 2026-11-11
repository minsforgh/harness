#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createWriteStream, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
export function stripAnsi(text) { return text.replace(ANSI, ''); }

export function summarize(output, { maxLines = 40 } = {}) {
  const lines = stripAnsi(output).replace(/\r/g, '').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const vitest = lines.filter(line => /^\s*(?:Test Files|Tests|Duration)\s+/u.test(line)).map(line => line.trim());
  const failures = lines.filter(line => /^\s*(?:FAIL\s+|❯\s+.*\|.*failed|×\s+)/u.test(line)).map(line => line.trim());
  const errors = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*(?:AssertionError|Error|TypeError|ReferenceError|SyntaxError):/u.test(lines[i])) continue;
    errors.push(lines[i].trim());
    for (let next = i + 1, count = 0; next < lines.length && count < 2; next++) {
      if (!lines[next].trim() || /^\s*(?:FAIL\s+|Test Files|Tests|Duration)/u.test(lines[next])) break;
      errors.push(lines[next].trim());
      count++;
    }
  }
  if (vitest.length || failures.length) {
    const result = ['vitest'];
    result.push(...vitest.slice(-3), ...failures, ...errors);
    return bound(result, maxLines);
  }

  const tsc = lines.filter(line => /^(?:.+?\(\d+,\d+\)|.+?:\d+(?::\d+)?)\s*(?::|\s+-)\s*error TS\d+:/u.test(line)).map(line => line.trim());
  if (tsc.length) return bound([`tsc: ${tsc.length} errors`, ...tsc], maxLines);

  const eslintRows = lines.filter(line => /^\s*\d+:\d+\s+(?:error|warning)\s+/u.test(line));
  const eslintTotal = lines.find(line => /\b\d+ problems? \(\d+ errors?, \d+ warnings?\)/u.test(line));
  if (eslintRows.length || eslintTotal) {
    const errorCount = eslintRows.filter(line => /^\s*\d+:\d+\s+error\s+/u.test(line)).length;
    const warningCount = eslintRows.filter(line => /^\s*\d+:\d+\s+warning\s+/u.test(line)).length;
    const counts = eslintTotal?.match(/(\d+) errors?, (\d+) warnings?/u);
    const result = [`eslint: ${counts?.[1] ?? errorCount} errors, ${counts?.[2] ?? warningCount} warnings`];
    let file = '';
    for (const line of lines) {
      if (/^\s*\d+:\d+\s+error\s+/u.test(line)) result.push(`${file}${file ? ':' : ''}${line.trim()}`);
      else if (line.trim() && !/^\s*\d+:\d+\s+(?:error|warning)\s+/u.test(line) && /\.(?:[cm]?[jt]sx?|vue|svelte)$/u.test(line.trim())) file = line.trim();
    }
    return bound(result, maxLines);
  }
  return bound(['output (last lines)', ...lines.slice(-(maxLines - 1))], maxLines);
}

function bound(lines, limit) {
  return lines.slice(0, limit);
}

function parse(argv) {
  let log;
  let maxLines = 40;
  let i = 0;
  for (; i < argv.length && argv[i] !== '--'; i++) {
    if (argv[i] === '--log' && argv[i + 1]) log = argv[++i];
    else if (argv[i] === '--max-lines' && /^\d+$/u.test(argv[i + 1] ?? '') && Number(argv[i + 1]) >= 4) maxLines = Number(argv[++i]);
    else throw new Error(`Unknown or invalid option: ${argv[i]}`);
  }
  const command = argv.slice(i + 1);
  if (argv[i] !== '--' || !command.length) throw new Error('Usage: node run-summarized.mjs [--log <file>] [--max-lines 40] -- <command...>');
  return { log: log ?? join(tmpdir(), `run-summarized-${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID()}.log`), maxLines, command };
}

// cmd.exe is required for Windows .cmd shims such as pnpm. Quote each token so
// spaces and shell metacharacters in ordinary arguments are not split.
function cmdQuote(value) {
  return `"${value.replace(/\^/gu, '^^').replace(/%/gu, '%%').replace(/!/gu, '^!').replace(/"/gu, '\\"')}"`;
}

export async function run(argv = process.argv.slice(2)) {
  const { log, maxLines, command } = parse(argv);
  const started = performance.now();
  const windows = process.platform === 'win32';
  const child = windows
    ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${command.map(cmdQuote).join(' ')}"`],
      { windowsVerbatimArguments: true, windowsHide: true, stdio: ['inherit', 'pipe', 'pipe'] })
    : spawn(command[0], command.slice(1), { stdio: ['inherit', 'pipe', 'pipe'] });
  const stream = createWriteStream(log);
  for (const output of [child.stdout, child.stderr]) output.on('data', chunk => stream.write(chunk));
  const outcome = await new Promise(resolve => {
    child.once('error', error => resolve({ code: 1, error }));
    child.once('close', (code, signal) => resolve({ code: code ?? 1, signal }));
  });
  await new Promise(resolve => stream.end(resolve));
  const duration = ((performance.now() - started) / 1000).toFixed(2);
  const head = [`Command: ${command.join(' ')}`, `Exit code: ${outcome.code}${outcome.signal ? ` (${outcome.signal})` : ''}`, `Duration: ${duration}s`];
  const tail = [`Log: ${log}`];
  const content = readFileSync(log, 'utf8') + (outcome.error ? `\n${outcome.error.message}\n` : '');
  const body = summarize(content, { maxLines: Math.max(0, maxLines - head.length - tail.length) });
  process.stdout.write([...head, ...body, ...tail].join('\n') + '\n');
  return outcome.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  run().then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
