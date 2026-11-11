import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('.', import.meta.url));
const watcher = resolve(directory, '../watch-workers.mjs');
const fake = resolve(directory, 'fixtures/fake-orca.mjs');
const fakeDeskpet = resolve(directory, 'fixtures/fake-deskpet.mjs');

function harness(scenario, script = watcher) {
  const temp = mkdtempSync(join(tmpdir(), 'orca-watch-test-'));
  const run = `test_${randomUUID()}`;
  const cursor = join(temp, 'cursor.json');
  const statePath = join(tmpdir(), `orca-watch-workers-${createHash('sha256').update(run).digest('hex').slice(0, 24)}.json`);
  const calls = join(temp, 'deskpet-calls.jsonl');
  const orca = `"${process.execPath}" "${fake}"`;
  const deskpet = `"${process.execPath}" "${fakeDeskpet}"`;
  let lastStderr = '';
  const invoke = (now, extra = []) => {
    const result = spawnSync(process.execPath, [script, '--run', run, '--once', '--orca', orca, ...extra], {
      encoding: 'utf8',
      env: { ...process.env, FAKE_ORCA_SCENARIO: scenario, FAKE_ORCA_CURSOR: cursor,
        FAKE_DESKPET_CALLS: calls, ORCA_WATCH_NOW_MS: String(now) },
    });
    assert.equal(result.status, 0, result.stderr);
    lastStderr = result.stderr;
    return result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  };
  const notifications = () => {
    try { return readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line)); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  return { invoke, cursor, deskpet, notifications, state: () => JSON.parse(readFileSync(statePath, 'utf8')),
    stderr: () => lastStderr, cleanup: () => { rmSync(temp, { recursive: true, force: true }); rmSync(statePath, { force: true }); } };
}

function assertAttentionCli(argv) {
  assert.equal(argv[0], 'event');
  const value = flag => argv[argv.indexOf(flag) + 1];
  assert.equal(value('--source'), 'orchestration');
  assert.ok(value('--key'));
  assert.equal(argv.includes('--ttl'), false);
  if (value('--attention') === 'resolve') {
    assert.deepEqual(argv, ['event', '--source', 'orchestration', '--key', value('--key'), '--attention', 'resolve']);
  } else if (value('--attention') === 'hold') {
    assert.ok(value('--text'));
    assert.ok(value('--voice'));
    assert.notEqual(value('--priority'), 'low');
  } else {
    assert.equal(argv.includes('--attention'), false);
  }
}

for (const [scenario, type] of [
  ['done-message', 'done'], ['question', 'question'], ['escalation', 'escalation'],
  ['update', 'start-blocked'], ['permission', 'start-blocked'],
  ['draft', 'start-blocked'], ['pasted', 'start-blocked'],
  ['all-settled', 'all-settled'], ['failure', 'watcher-error'],
]) {
  test(`${scenario} emits ${type} once`, () => {
    const h = harness(scenario);
    try {
      const first = h.invoke(1_000_000);
      assert.equal(first.length, 1);
      assert.equal(first[0].type, type);
      assert.deepEqual(Object.keys(first[0]), ['type', 'dispatchId', 'taskId', 'terminalHandle', 'reason', 'at']);
      assert.deepEqual(h.invoke(1_000_001), []);
      if (scenario === 'failure') assert.equal(JSON.parse(readFileSync(h.cursor, 'utf8')).calls['worker-list'], 6);
    } finally { h.cleanup(); }
  });
}

test('idle requires an unchanged screen for the injected duration', () => {
  const h = harness('idle');
  try {
    assert.deepEqual(h.invoke(1_000_000, ['--idle-min', '20', '--heartbeat-min', '30']), []);
    assert.deepEqual(h.invoke(2_199_999, ['--idle-min', '20', '--heartbeat-min', '30']), []);
    assert.equal(h.invoke(2_200_000, ['--idle-min', '20', '--heartbeat-min', '30'])[0].type, 'idle');
  } finally { h.cleanup(); }
});

test('heartbeat-lost uses injected time without sleeping', () => {
  const h = harness('heartbeat-lost');
  try {
    assert.deepEqual(h.invoke(1_000_000, ['--heartbeat-min', '15']), []);
    assert.equal(h.invoke(1_900_000, ['--heartbeat-min', '15'])[0].type, 'heartbeat-lost');
  } finally { h.cleanup(); }
});

test('heartbeat and changing work screens do not wake the watcher', () => {
  const h = harness('heartbeat-only');
  try {
    assert.deepEqual(h.invoke(1_000_000), []);
    // More than 15 minutes elapsed, but the second poll has a fresh heartbeat
    // whose dispatchId exists only inside Orca's string payload.
    assert.deepEqual(h.invoke(2_000_000), []);
  }
  finally { h.cleanup(); }
});

test('done message resolves IDs and sender from Orca string payload shape', () => {
  const h = harness('done-message');
  try {
    const [done] = h.invoke(1_000_000);
    assert.equal(done.type, 'done');
    assert.equal(done.dispatchId, 'd1');
    assert.equal(done.taskId, 't1');
    assert.equal(done.terminalHandle, 'term1');
  } finally { h.cleanup(); }
});

test('dispatch status transition emits done', () => {
  const h = harness('transition');
  try {
    assert.deepEqual(h.invoke(1_000_000), []);
    assert.equal(h.invoke(1_000_001)[0].type, 'done');
  } finally { h.cleanup(); }
});

test('message and dispatch transition produce one done event in follow mode', () => {
  const h = harness('done-combined');
  try {
    assert.deepEqual(h.invoke(1_000_000), []);
    const events = h.invoke(1_000_001, ['--follow']);
    assert.deepEqual(events.map(value => value.type), ['done']);
    assert.deepEqual(h.invoke(1_000_002), []);
  } finally { h.cleanup(); }
});

for (const [scenario, type, voice, priority, text] of [
  ['update', 'start-blocked', 'alert', 'high', 'worker 가 시작에서 멈췄어요: demo-worker — 업데이트 안내'],
  ['question', 'question', 'waiting', 'high', 'demo-worker 에게 질문이 왔어요: Need input'],
  ['escalation', 'escalation', 'waiting', 'high', 'demo-worker 가 도움을 요청했어요: Blocked'],
  ['failure', 'watcher-error', 'failed', 'urgent', 'worker 감시 오류: temporary: temporary fake Orca error'],
]) {
  test(`${type} sends one DeskPet event`, () => {
    const h = harness(scenario);
    try {
      assert.equal(h.invoke(1_000_000, ['--notify-deskpet', h.deskpet])[0].type, type);
      const expected = ['event', '--text', text, '--voice', voice, '--source', 'orchestration',
        '--key', `${type}:${type === 'watcher-error' ? 'unknown' : 'd1'}`, '--priority', priority];
      assert.deepEqual(h.notifications(), [expected]);
      assert.ok(text.length <= 80);
      assert.deepEqual(h.invoke(1_000_001, ['--notify-deskpet', h.deskpet]), []);
      assert.deepEqual(h.notifications(), [expected]);
    } finally { h.cleanup(); }
  });
}

test('question notification quotes the question body from the payload', () => {
  const h = harness('question-body');
  try {
    const [value] = h.invoke(1_000_000, ['--notify-deskpet', h.deskpet]);
    assert.equal(value.type, 'question');
    assert.equal(value.reason, '이 옵션 중 어느 것을 선택할까요?\nA는 빠르고 B는 안전하지만 설정이 더 필요합니다');
    const [argv] = h.notifications();
    assert.deepEqual(argv.slice(0, 3), ['event', '--text', 'demo-worker 에게 질문이 왔어요: 이 옵션 중 어느 것을 선택할까요? A는 빠르고 B는 안전하지만…']);
  } finally { h.cleanup(); }
});

for (const [scenario, type, now, prior] of [
  ['idle', 'idle', 2_200_000, ['--idle-min', '20', '--heartbeat-min', '30']],
  ['heartbeat-lost', 'heartbeat-lost', 1_900_000, ['--heartbeat-min', '15']],
]) {
  test(`${type} sends an alert to DeskPet`, () => {
    const h = harness(scenario);
    try {
      h.invoke(1_000_000, [...prior, '--notify-deskpet', h.deskpet]);
      assert.equal(h.invoke(now, [...prior, '--notify-deskpet', h.deskpet])[0].type, type);
      const [argv] = h.notifications();
      assert.deepEqual(argv.slice(0, 3), ['event', '--text', type === 'idle' ? 'demo-worker 가 오래 멈춰 있어요.' : 'demo-worker 의 heartbeat 가 끊겼어요.']);
      assert.deepEqual(argv.slice(3), ['--voice', 'alert', '--source', 'orchestration', '--key', `${type}:d1`, '--priority', 'high']);
    } finally { h.cleanup(); }
  });
}

test('done and all-settled do not notify DeskPet', () => {
  for (const scenario of ['done-message', 'all-settled']) {
    const h = harness(scenario);
    try {
      assert.equal(h.invoke(1_000_000, ['--notify-deskpet', h.deskpet]).length, 1);
      assert.deepEqual(h.notifications(), []);
    } finally { h.cleanup(); }
  }
});

test('DeskPet CLI failure keeps watcher output and exit code', () => {
  const h = harness('question');
  const old = process.env.FAKE_DESKPET_FAIL;
  try {
    process.env.FAKE_DESKPET_FAIL = '1';
    assert.equal(h.invoke(1_000_000, ['--notify-deskpet', h.deskpet])[0].type, 'question');
    assert.equal(h.notifications().length, 1);
    assert.match(h.stderr(), /^deskpet notification failed: exit 1\r?\n$/);
  } finally {
    if (old === undefined) delete process.env.FAKE_DESKPET_FAIL;
    else process.env.FAKE_DESKPET_FAIL = old;
    h.cleanup();
  }
});

test('exhaustion precedes a blocked prompt and includes agent/reset', () => {
  const h = harness('limit-hit');
  try {
    const [value] = h.invoke(1_000_000);
    assert.equal(value.type, 'limit-hit');
    assert.equal(value.agent, 'codex');
    assert.equal(value.resetsAt, '2026-10-17T12:34:00.000Z');
    assert.deepEqual(h.invoke(1_000_001), []);
  } finally { h.cleanup(); }
});

test('remaining-budget warning is not exhaustion', () => {
  const h = harness('limit-warning');
  try { assert.deepEqual(h.invoke(1_000_000), []); }
  finally { h.cleanup(); }
});

for (const [scenario, agent] of [['opencode-limit', 'opencode'], ['claude-limit', 'claude']]) {
  test(`${agent} exhaustion is recognized`, () => {
    const h = harness(scenario);
    try {
      const [value] = h.invoke(1_000_000);
      assert.equal(value.type, 'limit-hit');
      assert.equal(value.agent, agent);
      assert.equal(value.resetsAt, null);
    } finally { h.cleanup(); }
  });
}

test('limit-hit sends DeskPet voice alert', () => {
  const h = harness('limit-hit');
  try {
    assert.equal(h.invoke(1_000_000, ['--notify-deskpet', h.deskpet])[0].type, 'limit-hit');
    const [notice] = h.notifications();
    assert.equal(notice[0], 'event');
    assert.match(notice[2], /^demo-worker 가 사용 한도에 걸렸어요\(리셋 /);
    assert.equal(notice[4], 'alert');
  } finally { h.cleanup(); }
});

test('attention option holds only question, escalation, and start-blocked with valid CLI arguments', () => {
  for (const [scenario, type] of [['question', 'question'], ['escalation', 'escalation'], ['update', 'start-blocked']]) {
    const h = harness(scenario);
    try {
      assert.equal(h.invoke(1_000_000, ['--notify-deskpet', h.deskpet, '--deskpet-attention'])[0].type, type);
      const [argv] = h.notifications();
      assertAttentionCli(argv);
      assert.deepEqual(argv.slice(-2), ['--attention', 'hold']);
      assert.equal(argv[argv.indexOf('--key') + 1], `${type}:d1`);
      assert.deepEqual(h.state().held, { [`${type}:d1`]: { type, dispatchId: 'd1' } });
    } finally { h.cleanup(); }
  }
});

test('acknowledged question resolves once on the next invocation', () => {
  const h = harness('question-acked');
  const extra = ['--notify-deskpet', h.deskpet, '--deskpet-attention'];
  try {
    assert.equal(h.invoke(1_000_000, extra)[0].type, 'question');
    assert.deepEqual(h.invoke(1_000_001, extra), []);
    assert.deepEqual(h.invoke(1_000_002, extra), []);
    assert.deepEqual(h.notifications().map(argv => argv.slice(-2)), [['--attention', 'hold'], ['--attention', 'resolve']]);
    h.notifications().forEach(assertAttentionCli);
    assert.deepEqual(h.state().held, {});
  } finally { h.cleanup(); }
});

test('attention option works through an installed-style directory link', () => {
  const temp = mkdtempSync(join(tmpdir(), 'orca-watch-link-test-'));
  const link = join(temp, 'orchestrate');
  symlinkSync(resolve(directory, '..'), link, process.platform === 'win32' ? 'junction' : 'dir');
  const h = harness('question-acked', join(link, 'watch-workers.mjs'));
  const extra = ['--notify-deskpet', h.deskpet, '--deskpet-attention'];
  try {
    assert.equal(h.invoke(1_000_000, extra)[0].type, 'question');
    assert.deepEqual(h.invoke(1_000_001, extra), []);
    assert.deepEqual(h.notifications().map(argv => argv[argv.indexOf('--attention') + 1]), ['hold', 'resolve']);
  } finally { h.cleanup(); rmSync(temp, { recursive: true, force: true }); }
});

test('start-blocked resolves when the worker screen becomes working', () => {
  const h = harness('blocked-working');
  const extra = ['--notify-deskpet', h.deskpet, '--deskpet-attention'];
  try {
    assert.equal(h.invoke(1_000_000, extra)[0].type, 'start-blocked');
    assert.deepEqual(h.invoke(1_000_001, extra), []);
    assert.deepEqual(h.notifications()[1], ['event', '--source', 'orchestration', '--key', 'start-blocked:d1', '--attention', 'resolve']);
    assert.deepEqual(h.state().held, {});
  } finally { h.cleanup(); }
});

test('failed resolve retains held key and retries on the next invocation', () => {
  const h = harness('question-acked');
  const extra = ['--notify-deskpet', h.deskpet, '--deskpet-attention'];
  const old = process.env.FAKE_DESKPET_FAIL;
  try {
    h.invoke(1_000_000, extra);
    process.env.FAKE_DESKPET_FAIL = 'resolve';
    assert.deepEqual(h.invoke(1_000_001, extra), []);
    assert.deepEqual(h.state().held, { 'question:d1': { type: 'question', dispatchId: 'd1' } });
    assert.match(h.stderr(), /deskpet notification failed: exit 1/);
    delete process.env.FAKE_DESKPET_FAIL;
    assert.deepEqual(h.invoke(1_000_002, extra), []);
    assert.deepEqual(h.notifications().map(argv => argv[argv.indexOf('--attention') + 1]), ['hold', 'resolve', 'resolve']);
    assert.deepEqual(h.state().held, {});
  } finally {
    if (old === undefined) delete process.env.FAKE_DESKPET_FAIL;
    else process.env.FAKE_DESKPET_FAIL = old;
    h.cleanup();
  }
});

test('all-settled resolves remaining hold before exit', () => {
  const h = harness('question-settled');
  const extra = ['--notify-deskpet', h.deskpet, '--deskpet-attention'];
  try {
    h.invoke(1_000_000, extra);
    assert.equal(h.invoke(1_000_001, extra)[0].type, 'done');
    assert.deepEqual(h.notifications()[1], ['event', '--source', 'orchestration', '--key', 'question:d1', '--attention', 'resolve']);
    assert.deepEqual(h.state().held, {});
  } finally { h.cleanup(); }
});

test('peek failure never guesses that a question has resolved', () => {
  const h = harness('question-peek-failure');
  const extra = ['--notify-deskpet', h.deskpet, '--deskpet-attention'];
  try {
    h.invoke(1_000_000, extra);
    assert.equal(h.invoke(1_000_001, extra)[0].type, 'watcher-error');
    assert.equal(h.notifications().some(argv => argv.includes('resolve')), false);
    assert.deepEqual(h.state().held, { 'question:d1': { type: 'question', dispatchId: 'd1' } });
  } finally { h.cleanup(); }
});

test('limit-hit and idle remain ordinary notifications with attention enabled', () => {
  for (const [scenario, now, prior] of [
    ['limit-hit', 1_000_000, []],
    ['idle', 2_200_000, ['--idle-min', '20', '--heartbeat-min', '30']],
  ]) {
    const h = harness(scenario);
    const extra = [...prior, '--notify-deskpet', h.deskpet, '--deskpet-attention'];
    try {
      if (scenario === 'idle') h.invoke(1_000_000, extra);
      assert.equal(h.invoke(now, extra)[0].type, scenario);
      h.notifications().forEach(assertAttentionCli);
      assert.equal(h.notifications().some(argv => argv.includes('--attention')), false);
    } finally { h.cleanup(); }
  }
});
