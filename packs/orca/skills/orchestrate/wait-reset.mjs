#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readCodexUsage } from './route-worker.mjs';

export const MAX_WAIT_MS = 6 * 60 * 60_000;

export function resetDeadline(until, { marginMin = 3, now = Date.now() } = {}) {
  const at = Date.parse(until);
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(at) || !Number.isFinite(nowMs)) throw new Error('Valid ISO reset time required');
  if (!Number.isFinite(marginMin) || marginMin < 0) throw new Error('margin-min must be nonnegative');
  if (at <= nowMs) return nowMs;
  const deadline = at + marginMin * 60_000;
  if (deadline - nowMs > MAX_WAIT_MS) throw new Error('Wait exceeds six-hour maximum');
  return deadline;
}

export async function waitForReset(until, { marginMin = 3, now = () => Date.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const deadline = resetDeadline(until, { marginMin, now: now() });
  while (true) {
    const remaining = deadline - now();
    if (remaining <= 0) return;
    await sleep(Math.min(remaining, 60_000));
  }
}

function argsOf(argv) {
  let until, codex5h = false, marginMin = 3;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--until') until = argv[++i];
    else if (argv[i] === '--codex-5h') codex5h = true;
    else if (argv[i] === '--margin-min') marginMin = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (Boolean(until) === codex5h) throw new Error('Usage: node wait-reset.mjs (--until <ISO> | --codex-5h) [--margin-min 3]');
  return { until, codex5h, marginMin };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const options = argsOf(process.argv.slice(2));
    const until = options.codex5h ? (await readCodexUsage())?.fiveHour?.resetsAt : options.until;
    if (!until) throw new Error('Codex five-hour reset time unavailable');
    await waitForReset(until, options);
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
