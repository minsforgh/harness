#!/usr/bin/env node
// 마일스톤 시작 판정(harness-orca): 종료 코드 0일 때만 오케스트레이션을 시작한다.
//   node milestone-check.mjs [저장소] [--milestone <docs/changes/ 아래 폴더>] [--pre-approval]
// 보는 것: AGENTS.md "값" 표의 오케스트레이션 행(values.md의 행 전부), 마일스톤 폴더의 proposal.md(기준 표, 승인),
// queue.json, preflight.log. 마일스톤을 주지 않으면 docs/changes/ 아래(archive 제외) queue.json이 있는 폴더가 하나여야 한다.
// --pre-approval: 승인을 받기 전(K5)에 돌린다. 승인 날짜가 없는 것만 알림으로 낮춘다.
// 날짜를 쓴 뒤와 orchestrate가 시작할 때는 이 플래그 없이 돌린다.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseCandidates, parseLimits } from '../orchestrate/route-worker.mjs';
import { ORCA_ROWS, readValueRows, valueState } from '../orchestrate/values.mjs';

// K4 사전 점검 항목(SKILL.md K4와 같은 키). trial은 마일스톤마다 다시 한다(값 표의 모델과 계정이 지금도 도는지 본다).
export const PREFLIGHT = ['orca', 'check', 'base', 'clean', 'tools', 'codex-rules', 'trial', 'parallel'];
const NO_SKIP = new Set(['trial']);

// 같은 경로인지, 한쪽이 다른 쪽 아래인지(경로 조각 단위. src/a와 src/ab는 겹치지 않는다)
const norm = (p) => p.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/\*\*?$/, '').replace(/\/+$/, '').replace(/^\.$/, '');
export const overlaps = (p, r) => {
  const a = norm(p), b = norm(r);
  return a === b || !a || !b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
};

export function checkMilestone({ root, milestone = null, preApproval = false }) {
  const errors = new Set(), warnings = new Set();
  const err = (m) => errors.add(m), warn = (m) => warnings.add(m);
  const read = (rel) => { try { return fs.readFileSync(path.join(root, rel), 'utf8').replace(/^﻿/, ''); } catch { return null; } };

  // 1. 오케스트레이션 값
  const agents = read('AGENTS.md');
  let rows = new Map();
  if (agents == null) err('AGENTS.md 없음');
  else {
    const parsed = readValueRows(agents);
    rows = parsed.rows;
    for (const name of parsed.duplicates) err(`값 표: "${name}" 행이 둘 이상이다`);
    for (const name of ORCA_ROWS) {
      const state = valueState(rows.get(name));
      if (state === 'missing') err(`값 표: "${name}" 행 없음(harness-orca를 켜고 harness-apply를 다시 돌린다)`);
      else if (state === 'empty') err(`값 표: "${name}" 비었음`);
    }
    for (const [name, v] of rows) {
      if ((ORCA_ROWS.includes(name) || name.startsWith('worker ')) && valueState(v) === 'skip-no-reason') err(`값 표: "${name}" 생략에 이유가 없음`);
    }
    const cap = rows.get('병렬 상한');
    if (valueState(cap) === 'set' && !/^[1-9]\d*\b/.test(cap)) err(`값 표: "병렬 상한"은 수로 시작한다: ${cap}`);
    const limit = rows.get('한도 기준');
    if (valueState(limit) === 'set') try { parseLimits(limit); } catch (e) { err(`값 표: ${e.message}`); }
  }
  const roleState = (role) => {
    const v = rows.get(`worker ${role}`);
    const state = valueState(v);
    if (state !== 'set') return state;
    try { parseCandidates(v); return 'ok'; } catch (e) { err(`값 표: "worker ${role}" ${e.message}`); return 'bad'; }
  };
  for (const name of rows.keys()) if (name.startsWith('worker ')) roleState(name.slice(7));

  // 2. 마일스톤 폴더
  const changes = path.join(root, 'docs', 'changes');
  let folder = milestone;
  if (!folder) {
    const found = fs.existsSync(changes) ? fs.readdirSync(changes, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== 'archive' && fs.existsSync(path.join(changes, d.name, 'queue.json'))).map((d) => d.name) : [];
    if (found.length === 1) folder = `docs/changes/${found[0]}`;
    else if (!found.length) err('docs/changes/ 아래에 queue.json이 있는 마일스톤 폴더가 없다(K3)');
    else err(`마일스톤 폴더가 여럿이다(${found.join(', ')}). --milestone으로 준다`);
  }
  if (!folder) return { errors: [...errors], warnings: [...warnings], folder };

  const criteria = new Map();
  const proposal = read(`${folder}/proposal.md`);
  if (proposal == null) err(`${folder}/proposal.md 없음`);
  else {
    const body = proposal.replace(/<!--[\s\S]*?-->/g, '');
    const approvalLine = /^-\s*계약과 대기열 승인\s*:\s*(.*)$/m.exec(body);
    const approved = Boolean(approvalLine && /^\d{4}-\d\d-\d\d/.test(approvalLine[1].trim()));
    // 자리표시: 코드 안과 화살표(<-), 비교(< , <=)는 빼고 본다. 승인 전에는 승인 줄의 <YYYY-MM-DD>를 둔다.
    let prose = body.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '').replace(/`[^`\n]*`/g, '');
    if (preApproval && !approved) prose = prose.replace(/^-\s*계약과 대기열 승인\s*:\s*<YYYY-MM-DD>\s*$/m, '');
    const placeholder = prose.match(/<(?![-=\s])[^<>\n]+>/);
    if (placeholder) err(`proposal.md: 틀의 자리표시가 남았다: ${placeholder[0]}`);
    for (const m of body.matchAll(/^\|\s*(C\d+)\s*\|\s*(.+?)\s*\|\s*([ARH])\s*\|/gm)) {
      if (criteria.has(m[1])) err(`proposal.md: 기준 ${m[1]} 겹침`);
      criteria.set(m[1], m[3]);
    }
    if (!criteria.size) err('proposal.md: 기준 표에 "| C1 | 문장 | A/R/H |" 행이 없다');
    else if (![...criteria.values()].some((k) => k === 'A' || k === 'R')) warn('기준에 A나 R이 없다(화면에 그려진 것을 기계나 리뷰로 보는 기준을 하나 둔다)');
    if ([...criteria.values()].includes('R') && roleState('리뷰') !== 'ok') err('R 기준이 있는데 값 표 "worker 리뷰"가 비었거나 생략이다');
    if (!approved) {
      if (preApproval) warn('proposal.md: 승인 날짜 없음(승인을 받으면 날짜를 쓰고 --pre-approval 없이 다시 돌린다)');
      else err('proposal.md: 승인 날짜 없음(K5)');
    }
  }
  if (read(`${folder}/tasks.md`) == null) warn(`${folder}/tasks.md 없음(진행을 체크할 곳)`);

  // 3. 대기열
  const qtext = read(`${folder}/queue.json`);
  let q = null;
  if (qtext == null) err(`${folder}/queue.json 없음`);
  else try { q = JSON.parse(qtext); } catch (e) { err(`queue.json: ${e.message}`); }
  if (q) {
    const tasks = Array.isArray(q.tasks) ? q.tasks.filter((t) => t && typeof t === 'object') : [];
    if (!tasks.length) err('queue.json: task 없음');
    const list = (t, f) => (Array.isArray(t[f]) ? t[f].filter((x) => typeof x === 'string') : []);
    const ids = new Set(), covered = new Set();
    for (const t of tasks) {
      const tag = `queue ${t.id || '?'}`;
      for (const f of ['id', 'title', 'role', 'done', 'verify', 'forbid']) {
        if (typeof t[f] !== 'string' || !t[f].trim()) err(`${tag}: "${f}" 비었음`);
      }
      for (const f of ['scope', 'criteria', 'deps']) {
        if (t[f] === undefined) err(`${tag}: "${f}" 비었음`);
        else if (!Array.isArray(t[f]) || t[f].some((x) => typeof x !== 'string')) err(`${tag}: "${f}"는 글의 배열이다`);
        else if (!t[f].length && f !== 'deps') err(`${tag}: "${f}" 비었음`);
      }
      if (typeof t.role === 'string' && t.role && roleState(t.role) !== 'ok') err(`${tag}: 값 표에 "worker ${t.role}" 행이 없거나 생략이다`);
      if (ids.has(t.id)) err(`${tag}: id 겹침`);
      ids.add(t.id);
      for (const c of list(t, 'criteria')) { if (!criteria.has(c)) err(`${tag}: 기준 ${c}가 proposal에 없다`); covered.add(c); }
    }
    for (const t of tasks) for (const d of list(t, 'deps')) if (!ids.has(d)) err(`queue ${t.id}: 모르는 deps ${d}`);
    for (const c of criteria.keys()) if (!covered.has(c) && criteria.get(c) !== 'H') warn(`기준 ${c}에 기여하는 task가 없다`);
    const deps = Object.fromEntries(tasks.map((t) => [t.id, list(t, 'deps')]));
    const reach = (a, b, seen = new Set()) => (deps[a] || []).some((d) => d === b || (!seen.has(d) && seen.add(d) && reach(d, b, seen)));
    for (const t of tasks) if (reach(t.id, t.id)) err(`queue ${t.id}: deps가 돈다`);
    for (let i = 0; i < tasks.length; i++) for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i], b = tasks[j];
      const shared = list(a, 'scope').filter((p) => list(b, 'scope').some((r) => overlaps(p, r)));
      if (shared.length && !reach(a.id, b.id) && !reach(b.id, a.id)) warn(`queue ${a.id} / ${b.id}: ${shared[0]}을 같이 건드리는데 동시에 돌 수 있다(deps로 순서를 정한다)`);
    }
    const starts = tasks.filter((t) => !list(t, 'deps').length).length;
    const cap = parseInt(rows.get('병렬 상한'), 10);
    if (cap > 1 && starts < cap) warn(`처음에 동시에 시작할 수 있는 task가 ${starts}개로 병렬 상한 ${cap}보다 적다(파일 경계를 나누는 구조 task를 먼저 둘지 본다)`);
  }

  // 4. 사전 점검: 항목마다 PASS <키>, FAIL <키> <이유>, SKIP <키> <이유> 중 한 줄
  const pre = read(`${folder}/preflight.log`);
  if (pre == null) err(`${folder}/preflight.log 없음(K4)`);
  else {
    const seen = new Set();
    for (const line of pre.split(/\r?\n/)) {
      const m = /^(PASS|FAIL|SKIP)\s+(\S+)\s*(.*)$/.exec(line.trim());
      if (!m) continue;
      const [, verdict, key, why] = m;
      if (!PREFLIGHT.includes(key)) { warn(`preflight.log: 모르는 항목 ${key}(${PREFLIGHT.join(', ')})`); continue; }
      seen.add(key);
      if (verdict === 'FAIL') err(`사전 점검: FAIL ${key} ${why}`.trim());
      else if (verdict === 'SKIP' && NO_SKIP.has(key)) err(`사전 점검: ${key}는 생략하지 않는다(마일스톤마다 다시 한다)`);
      else if (verdict === 'SKIP' && !why.trim()) err(`사전 점검: SKIP ${key}에 이유가 없음`);
    }
    for (const key of PREFLIGHT) if (!seen.has(key)) err(`preflight.log: ${key} 줄이 없다(PASS ${key}, FAIL ${key} <이유>, SKIP ${key} <이유>)`);
  }
  return { errors: [...errors], warnings: [...warnings], folder };
}

function usage(message) {
  console.error(`${message}\nUsage: node milestone-check.mjs [저장소] [--milestone <docs/changes/ 아래 폴더>] [--pre-approval]`);
  process.exit(2);
}

function argsOf(argv) {
  let root = null, milestone = null, preApproval = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--milestone') {
      milestone = argv[++i];
      if (!milestone || milestone.startsWith('--')) usage('--milestone에 폴더를 준다');
    } else if (a === '--pre-approval') preApproval = true;
    else if (a.startsWith('--')) usage(`모르는 옵션: ${a}`);
    else if (root) usage(`저장소는 하나만 준다: ${a}`);
    else root = a;
  }
  return { root: path.resolve(root || '.'), milestone, preApproval };
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const { errors, warnings, folder } = checkMilestone(argsOf(process.argv.slice(2)));
  for (const w of warnings) console.log(`WARN  ${w}`);
  for (const e of errors) console.log(`ERROR ${e}`);
  console.log(`milestone-check: 오류 ${errors.length}, 알림 ${warnings.length}${folder ? ` (${folder})` : ''}`);
  process.exit(errors.length ? 1 : 0);
}
