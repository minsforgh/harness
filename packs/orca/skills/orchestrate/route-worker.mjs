#!/usr/bin/env node
// worker를 띄우기 전에 실제 agent, model, effort를 고른다(harness-orca).
//   node route-worker.mjs --role <역할> [--agents <AGENTS.md>] [--json]
// 후보는 프로젝트 AGENTS.md "값" 표의 `| worker <역할> | agent:model:effort > agent:model:effort |` 행이다(milestone-start가 정한다).
// 앞 후보부터 보고, 그 agent의 한도가 "한도 기준" 행을 넘었으면 다음 후보로 간다. 한도나 기준을 모르면 그 후보를 쓴다.
// 첫 후보의 한도가 곧(20분 안) 풀리면 바꾸지 않고 기다리기를 권한다(waitUntil).
// 대화 내용은 읽지 않는다. Codex 기록에서는 token_count 줄의 rate_limits만 꺼낸다.
import { realpathSync } from 'node:fs';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readValueRows, valueState } from './values.mjs';

// 곧 풀리는 한도는 모델을 바꾸는 것보다 기다리는 편이 싸다. 오래된 "이내" 기록은 믿지 않는다.
export const WAIT_MINUTES = 20;
export const STALE_MINUTES = 30;

// "codex:gpt-6-sol:high > claude:claude-sonnet-5-5 > opencode" -> 후보 목록. model을 비우면 그 agent의 기본값을 쓴다.
export function parseCandidates(value) {
  return value.split('>').map((part) => part.trim()).filter(Boolean).map((part) => {
    const pieces = part.split(':').map((x) => x.trim());
    if (pieces.length > 3) throw new Error(`agent:model:effort보다 칸이 많다(model 이름에 :가 있으면 읽지 못한다): ${part}`);
    const [agent, model = '', effort = ''] = pieces;
    if (!/^[a-z][a-z0-9-]*$/.test(agent)) throw new Error(`agent 이름을 읽지 못했다: ${part}`);
    if (effort && !model) throw new Error(`effort는 model과 같이 준다(Orca 규칙): ${part}`);
    return { agent, model: model || null, effort: effort || null };
  });
}

// "codex 85/95, claude 85" -> { codex: { fiveHour: 85, weekly: 95 }, claude: { fiveHour: 85, weekly: null } }
// 적지 않은 agent는 기준이 없다(한도로 거르지 않는다). 묶음 기본값으로 메우지 않는다.
export function parseLimits(value) {
  const limits = {};
  if (!value || /^생략\s*:/.test(value)) return limits;
  for (const m of value.matchAll(/(codex|claude)\s+(\d+)\s*%?(?:\s*\/\s*(\d+)\s*%?)?/gi)) {
    limits[m[1].toLowerCase()] = { fiveHour: Number(m[2]), weekly: m[3] ? Number(m[3]) : null };
  }
  if (!Object.keys(limits).length) throw new Error(`"한도 기준"을 읽지 못했다(예: codex 85/95, claude 85): ${value}`);
  return limits;
}

export function readValues(text, role) {
  const { rows } = readValueRows(text);
  const raw = rows.get(`worker ${role}`);
  const state = valueState(raw);
  if (state === 'missing' || state === 'empty') throw new Error(`AGENTS.md "값" 표에 \`worker ${role}\` 행이 없거나 비었다. milestone-start에서 정한다`);
  if (state !== 'set') throw new Error(`AGENTS.md "값" 표의 \`worker ${role}\`는 생략이다(${raw}). 이 역할로 보내지 않는다`);
  const limit = rows.get('한도 기준');
  if (valueState(limit) === 'missing' || valueState(limit) === 'empty') throw new Error('AGENTS.md "값" 표에 `한도 기준` 행이 없거나 비었다. milestone-start에서 정한다');
  return { candidates: parseCandidates(raw), limits: parseLimits(limit) };
}

async function sessionFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sessionFiles(path);
    return entry.isFile() && entry.name.endsWith('.jsonl') ? [path] : [];
  }));
  return nested.flat();
}

async function tail(path) {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, 512 * 1024);
    const bytes = Buffer.alloc(length);
    await handle.read(bytes, 0, length, size - length);
    return bytes.toString('utf8');
  } finally { await handle.close(); }
}

function windowOf(raw) {
  if (!raw || !Number.isFinite(raw.used_percent) || !Number.isFinite(raw.resets_at)) return null;
  const resetsAt = new Date(raw.resets_at * 1000);
  return Number.isNaN(resetsAt.getTime()) ? null : { usedPercent: raw.used_percent, resetsAt: resetsAt.toISOString() };
}

function usageInTail(raw) {
  for (const line of raw.split('\n').reverse()) {
    if (!line.includes('"token_count"') || !line.includes('"rate_limits"')) continue;
    try {
      const record = JSON.parse(line);
      if (record?.payload?.type !== 'token_count') continue;
      const fiveHour = windowOf(record.payload.rate_limits?.primary);
      const asOf = new Date(record.timestamp);
      if (!fiveHour || Number.isNaN(asOf.getTime())) continue;
      return { asOf: asOf.toISOString(), fiveHour, weekly: windowOf(record.payload.rate_limits.secondary) };
    } catch { /* 쓰는 중인 마지막 줄 */ }
  }
  return null;
}

// Codex 홈은 여럿이다: ~/.codex, $CODEX_HOME, Orca가 worker에게 주는 홈. 한도는 계정 단위라 가장 새 기록을 쓴다.
export function codexSessionDirs(env = process.env) {
  const appdata = env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  return [...new Set([env.CODEX_HOME && join(env.CODEX_HOME, 'sessions'), join(homedir(), '.codex', 'sessions'),
    join(appdata, 'orca', 'codex-runtime-home', 'home', 'sessions')].filter(Boolean))];
}

export async function readCodexUsage({ sessionsDirs = codexSessionDirs() } = {}) {
  const recent = [];
  for (const dir of sessionsDirs) {
    let files;
    try { files = await sessionFiles(dir); } catch { continue; }
    for (const path of files) {
      try { recent.push({ path, modified: (await stat(path)).mtimeMs }); } catch { /* 지워진 기록 */ }
    }
  }
  recent.sort((a, b) => b.modified - a.modified);
  let newest = null;
  for (const { path } of recent.slice(0, 10)) {
    try {
      const usage = usageInTail(await tail(path));
      if (usage && (!newest || usage.asOf > newest.asOf)) newest = usage;
    } catch { /* 잠긴 기록 */ }
  }
  return newest;
}

// Claude 한도는 Claude Code가 파일로 남기지 않는다. 상태 줄 등이 쓴 파일이 있을 때만 읽는다(없으면 미확인).
export async function readClaudeUsage({ file = process.env.HARNESS_CLAUDE_USAGE
  || join(process.env.DESKPET_USAGE_DIR || join(homedir(), '.deskpet', 'usage'), 'claude-rate-limits.json') } = {}) {
  let stored;
  try { stored = JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
  const asOf = new Date(stored?.capturedAt);
  if (Number.isNaN(asOf.getTime())) return null;
  const parse = (value) => {
    if (!value || !Number.isFinite(value.usedPercent) || !Number.isFinite(value.resetsAt)) return null;
    const date = new Date(value.resetsAt * 1000);
    return Number.isNaN(date.getTime()) ? null : { usedPercent: value.usedPercent, resetsAt: date.toISOString() };
  };
  const fiveHour = parse(stored.fiveHour);
  const weekly = parse(stored.weekly);
  return fiveHour || weekly ? { asOf: asOf.toISOString(), fiveHour, weekly } : null;
}

const stale = (usage, now) => now - Date.parse(usage.asOf) >= STALE_MINUTES * 60_000;

// 그 후보의 한도 상태: 'unknown'(모름, 쓴다), 'ok', 또는 넘은 창 목록.
// 리셋이 지난 창은 넘은 것으로 치지 않는다. 기록이 오래돼도 넘은 창의 리셋이 아직 앞이면 그대로 넘은 것이다(창 안에서 사용량은 줄지 않는다).
function over(candidate, usage, limits, now) {
  const kind = candidate.agent === 'codex' ? 'codex' : candidate.agent === 'claude' ? 'claude' : null;
  const lim = kind && limits[kind];
  const u = kind && usage[kind];
  if (!lim) return { state: 'unknown', why: '한도 기준 없음' };
  if (!u || (!u.fiveHour && !u.weekly)) return { state: 'unknown', why: '한도 미확인' };
  const hit = [[u.fiveHour, lim.fiveHour], [u.weekly, lim.weekly]]
    .filter(([w, max]) => w && max != null && w.usedPercent >= max && Date.parse(w.resetsAt) > now).map(([w]) => w);
  if (hit.length) return { state: 'over', hit };
  return stale(u, now) ? { state: 'unknown', why: '한도 미확인(기록이 오래됨)' } : { state: 'ok', why: '한도 이내' };
}

export function routeWorker({ candidates, limits = {} }, { codex = null, claude = null, now = Date.now() } = {}) {
  const nowMs = new Date(now).getTime();
  const usage = { codex, claude };
  const skipped = [];
  for (const [i, c] of candidates.entries()) {
    const s = over(c, usage, limits, nowMs);
    if (s.state !== 'over') {
      return { ...c, reason: skipped.length ? `${s.why} (앞 후보 한도: ${skipped.join(', ')})` : s.why, waitUntil: null };
    }
    const latest = Math.max(...s.hit.map((w) => Date.parse(w.resetsAt)));
    if (i === 0 && latest > nowMs && latest - nowMs <= WAIT_MINUTES * 60_000) {
      return { ...c, reason: '리셋 임박: 기다림 권장', waitUntil: new Date(latest).toISOString() };
    }
    skipped.push(`${c.agent}${c.model ? ` ${c.model}` : ''}`);
  }
  return { agent: null, model: null, effort: null, reason: `모든 후보가 한도에 걸림(${skipped.join(', ')}): 사용자에게 묻는다`, waitUntil: null };
}

function argsOf(argv) {
  let role, agents = 'AGENTS.md', json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--role') role = argv[++i];
    else if (argv[i] === '--agents') agents = argv[++i];
    else if (argv[i] === '--json') json = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!role) throw new Error('Usage: node route-worker.mjs --role <구현|잡무|리뷰|...> [--agents AGENTS.md] [--json]');
  return { role, agents, json };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const { role, agents, json } = argsOf(process.argv.slice(2));
    const values = readValues((await readFile(agents, 'utf8')).replace(/^﻿/, ''), role);
    const [codex, claude] = await Promise.all([readCodexUsage(), readClaudeUsage()]);
    const routed = routeWorker(values, { codex, claude });
    console.log(json ? JSON.stringify(routed)
      : `${routed.reason}: ${routed.agent ?? '보류'} ${routed.model ?? '(기본 모델)'}${routed.effort ? ` ${routed.effort}` : ''}${routed.waitUntil ? ` (리셋 ${routed.waitUntil})` : ''}`);
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
