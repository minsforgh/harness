import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCandidates, parseLimits, readCodexUsage, readClaudeUsage, readValues, routeWorker } from '../route-worker.mjs';
import { ORCA_ROWS, readValueRows, valueState } from '../values.mjs';

const now = Date.parse('2026-10-17T12:00:00.000Z');
const window = (usedPercent, minutes = 21) => ({ usedPercent, resetsAt: new Date(now + minutes * 60_000).toISOString() });
const codex = (five = 84, week = 94, minutes = 21, asOf = now) =>
  ({ asOf: new Date(asOf).toISOString(), fiveHour: window(five, minutes), weekly: window(week, 1000) });
const claude = (five = 20, minutes = 120, asOf = now) =>
  ({ asOf: new Date(asOf).toISOString(), fiveHour: window(five, minutes), weekly: null });
const impl = { candidates: parseCandidates('codex:gpt-6-sol:high > claude:claude-sonnet-5-5'), limits: parseLimits('codex 85/95, claude 85') };

const AGENTS = [
  '# x', '', '## 값', '', '| 항목 | 값 |', '|---|---|',
  '| worker 구현 | `codex:gpt-6-sol:high > claude:claude-sonnet-5-5` |',
  '| worker 잡무 | opencode > codex:gpt-5.6-luna |',
  '| worker 리뷰 | <agent:model:effort 후보> |',
  '| 한도 기준 | codex 80/90 |', '',
].join('\n');

test('values: candidates and limits come from the AGENTS.md value rows', () => {
  const v = readValues(AGENTS, '구현');
  assert.deepEqual(v.candidates, [
    { agent: 'codex', model: 'gpt-6-sol', effort: 'high' },
    { agent: 'claude', model: 'claude-sonnet-5-5', effort: null }]);
  assert.deepEqual(v.limits.codex, { fiveHour: 80, weekly: 90 });
  assert.equal(v.limits.claude, undefined, 'unset provider has no limit (no pack default)');
  assert.deepEqual(readValues(AGENTS, '잡무').candidates[0], { agent: 'opencode', model: null, effort: null });
  assert.throws(() => readValues(AGENTS, '리뷰'), /milestone-start/, 'placeholder row is not a value');
  assert.throws(() => readValues(AGENTS, '아트'), /milestone-start/);
  assert.throws(() => readValues(AGENTS.replace('| 한도 기준 | codex 80/90 |', '| 한도 기준 | <예> |'), '구현'), /한도 기준/);
  assert.throws(() => readValues(AGENTS.replace('opencode > codex:gpt-5.6-luna', '생략: 작다'), '잡무'), /생략/);
  assert.throws(() => parseCandidates('codex::high'), /model과 같이/);
  assert.throws(() => parseCandidates('opencode:zai:glm-5:high'), /칸이 많다/, 'a colon inside the model id is not silently cut');
  assert.throws(() => parseLimits('많이'), /한도 기준/);
  assert.deepEqual(parseLimits('codex 85%/95%'), { codex: { fiveHour: 85, weekly: 95 } });
  assert.deepEqual(parseLimits('생략: 한도 없음'), {});
});

test('values: rows are read only inside the 값 section, with extra columns and escaped pipes', () => {
  const text = ['# x', '', '| worker 구현 | codex:wrong |', '', '### 값 (작업 흐름)', '',
    '| 항목 | 값 | 설명 |', '|---|---|---|',
    '| **worker 구현** | `claude:claude-sonnet-5-5` | 구현과 버그 |',
    '| 수정 금지 | a\\|b 경로 | 설명 \\| 칸 |', '| 수정 금지 | 두 번째 |',
    '| 한도 기준 | claude 80 | 5시간 |', '', '### 다른 절', '', '| worker 구현 | codex:later |', ''].join('\n');
  const v = readValues(text, '구현');
  assert.deepEqual(v.candidates, [{ agent: 'claude', model: 'claude-sonnet-5-5', effort: null }]);
  assert.deepEqual(v.limits, { claude: { fiveHour: 80, weekly: null } });
  const { rows, duplicates } = readValueRows(text);
  assert.equal(rows.get('수정 금지'), 'a|b 경로', 'escaped pipe stays inside the cell');
  assert.deepEqual(duplicates, ['수정 금지']);
  assert.ok(!rows.has('항목'), 'header row is not a value');
  assert.deepEqual(ORCA_ROWS.slice(0, 2), ['coordinator', 'worker 구현']);
  assert.equal(ORCA_ROWS.length, 10);
  assert.deepEqual(['', '<x>', '생략:', '생략', '생략: 작다', '없음'].map(valueState), ['empty', 'empty', 'skip-no-reason', 'skip-no-reason', 'skipped', 'set']);
});

test('threshold is inclusive: at the limit the next candidate is used', () => {
  assert.equal(routeWorker(impl, { codex: codex(84), claude: claude(), now }).agent, 'codex');
  const moved = routeWorker(impl, { codex: codex(85), claude: claude(), now });
  assert.equal(moved.model, 'claude-sonnet-5-5');
  assert.match(moved.reason, /앞 후보 한도: codex gpt-6-sol/);
  assert.equal(routeWorker(impl, { codex: codex(84, 95), claude: claude(), now }).agent, 'claude', 'weekly limit counts');
});

test('first candidate resetting within 20 minutes waits instead of switching', () => {
  const near = routeWorker(impl, { codex: codex(85, 94, 19), claude: claude(), now });
  assert.equal(near.agent, 'codex');
  assert.equal(near.waitUntil, window(85, 19).resetsAt);
  assert.match(near.reason, /기다림/);
  assert.equal(routeWorker(impl, { codex: codex(85, 94, 21), claude: claude(), now }).agent, 'claude');
});

test('a window whose reset has passed is not over; a stale over window still is', () => {
  const reset = routeWorker(impl, { codex: codex(90, 94, -1), claude: claude(), now });
  assert.equal(reset.agent, 'codex', 'five-hour window already reset');
  assert.equal(reset.reason, '한도 이내');
  const staleOver = routeWorker(impl, { codex: codex(90, 94, 21, now - 30 * 60_000), now });
  assert.equal(staleOver.agent, 'claude', 'usage only grows until the reset, so an old over record still counts');
  const staleOk = routeWorker(impl, { codex: codex(40, 50, 21, now - 30 * 60_000), now });
  assert.equal(staleOk.agent, 'codex');
  assert.match(staleOk.reason, /오래됨/);
  const staleReset = routeWorker(impl, { codex: codex(90, 94, -1, now - 300 * 60_000), now });
  assert.equal(staleReset.agent, 'codex');
});

test('unknown limits keep the candidate; all over asks the user', () => {
  assert.equal(routeWorker(impl, { now }).reason, '한도 미확인');
  const noLimit = { candidates: impl.candidates, limits: parseLimits('claude 85') };
  assert.equal(routeWorker(noLimit, { codex: codex(99), now }).reason, '한도 기준 없음');
  const noClaude = routeWorker(impl, { codex: codex(90), now });
  assert.equal(noClaude.agent, 'claude', 'Claude limit unknown: use it');
  assert.match(noClaude.reason, /한도 미확인/);
  const all = routeWorker(impl, { codex: codex(90), claude: claude(90), now });
  assert.equal(all.agent, null);
  assert.match(all.reason, /사용자/);
  const glm = { candidates: parseCandidates('opencode > codex:gpt-5.6-luna'), limits: parseLimits('codex 85/95') };
  assert.equal(routeWorker(glm, { codex: codex(99), now }).agent, 'opencode', 'agents without limit data are not skipped');
});

test('readers consume only rate-limit windows, newest across Codex homes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'route-worker-'));
  try {
    const a = join(dir, 'a'), b = join(dir, 'b'), usage = join(dir, 'claude.json');
    mkdirSync(a); mkdirSync(b);
    const record = (timestamp, percent) => JSON.stringify({ timestamp, type: 'event_msg', payload: {
      type: 'token_count', rate_limits: { primary: { used_percent: percent, window_minutes: 300, resets_at: (now + 21 * 60_000) / 1000 },
        secondary: { used_percent: 95, window_minutes: 10080, resets_at: (now + 1000 * 60_000) / 1000 } } } });
    writeFileSync(join(a, 'old.jsonl'), `${JSON.stringify({ payload: { type: 'message', text: 'private fixture' } })}\n${record(new Date(now - 1000).toISOString(), 40)}\n`);
    writeFileSync(join(b, 'new.jsonl'), `${record(new Date(now).toISOString(), 85)}\n`);
    writeFileSync(usage, JSON.stringify({ capturedAt: new Date(now).toISOString(), fiveHour: { usedPercent: 20, resetsAt: (now + 120 * 60_000) / 1000 } }));
    const c = await readCodexUsage({ sessionsDirs: [a, b, join(dir, 'missing')] });
    const cl = await readClaudeUsage({ file: usage });
    assert.equal(c.fiveHour.usedPercent, 85);
    assert.equal(cl.fiveHour.usedPercent, 20);
    assert.equal(routeWorker(impl, { codex: c, claude: cl, now }).agent, 'claude');
    assert.ok(!JSON.stringify(c).includes('private fixture'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cli reads --agents and fails with exit 2 when the row is empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'route-worker-cli-'));
  try {
    const file = join(dir, 'AGENTS.md');
    writeFileSync(file, `﻿${AGENTS}`);
    const script = fileURLToPath(new URL('../route-worker.mjs', import.meta.url));
    const env = { ...process.env, CODEX_HOME: join(dir, 'none'), HARNESS_CLAUDE_USAGE: join(dir, 'none.json'), HOME: dir, USERPROFILE: dir, APPDATA: dir };
    const ok = spawnSync(process.execPath, [script, '--role', '잡무', '--agents', file, '--json'], { encoding: 'utf8', env });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(JSON.parse(ok.stdout).agent, 'opencode');
    const empty = spawnSync(process.execPath, [script, '--role', '리뷰', '--agents', file], { encoding: 'utf8', env });
    assert.equal(empty.status, 2);
    assert.match(empty.stderr, /worker 리뷰/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('direct-run guards fire when scripts run through a junction symlink', () => {
  const dir = mkdtempSync(join(tmpdir(), 'route-worker-link-'));
  try {
    const link = join(dir, 'orchestrate');
    symlinkSync(fileURLToPath(new URL('..', import.meta.url)), link, 'junction');
    const run = (script, args) => spawnSync(process.execPath, [join(link, script), ...args], { encoding: 'utf8' });
    const helper = run('route-worker.mjs', ['--help']);
    assert.equal(helper.status, 2);
    assert.match(helper.stderr, /Unknown argument: --help/);
    const waiter = run('wait-reset.mjs', ['--until', 'not-a-date']);
    assert.equal(waiter.status, 2);
    assert.match(waiter.stderr, /Valid ISO reset time required/);
    const summary = run('run-summarized.mjs', ['--help']);
    assert.equal(summary.status, 1);
    assert.match(summary.stderr, /Unknown or invalid option: --help/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
