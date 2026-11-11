import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDeadline, waitForReset } from '../wait-reset.mjs';

const start = Date.parse('2026-10-17T12:00:00Z');

test('waits until reset plus margin using injected clock and sleep', async () => {
  let clock = start;
  const sleeps = [];
  await waitForReset(new Date(start + 90_000).toISOString(), { now: () => clock,
    sleep: async ms => { sleeps.push(ms); clock += ms; } });
  assert.equal(clock, start + 270_000);
  assert.deepEqual(sleeps, [60_000, 60_000, 60_000, 60_000, 30_000]);
});

test('past deadline returns immediately and six-hour ceiling rejects', async () => {
  let slept = false;
  await waitForReset(new Date(start - 60_000).toISOString(), { now: () => start,
    sleep: async () => { slept = true; } });
  assert.equal(slept, false);
  assert.throws(() => resetDeadline(new Date(start + 6 * 60 * 60_000).toISOString(), { now: start }), /six-hour/);
  assert.equal(resetDeadline(new Date(start + 6 * 60 * 60_000).toISOString(), { now: start, marginMin: 0 }), start + 6 * 60 * 60_000);
});
