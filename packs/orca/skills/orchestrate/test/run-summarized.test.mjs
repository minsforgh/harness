import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarize } from '../run-summarized.mjs';

const dir = fileURLToPath(new URL('.', import.meta.url));
const script = resolve(dir, '../run-summarized.mjs');
const fixture = name => readFileSync(resolve(dir, 'fixtures', name), 'utf8');

test('vitest pass keeps totals and duration', () => {
  const lines = summarize(fixture('vitest-pass.txt'));
  assert.match(lines.join('\n'), /Test Files  1 passed/);
  assert.match(lines.join('\n'), /Tests  2 passed/);
  assert.match(lines.join('\n'), /Duration  431ms/);
});

test('vitest failure names file, test, and first error', () => {
  const lines = summarize(fixture('vitest-fail.txt'));
  assert.match(lines.join('\n'), /src\/sum\.test\.ts > sum > adds numbers/);
  assert.match(lines.join('\n'), /AssertionError: expected 3 to be 4/);
  assert.match(lines.join('\n'), /Expected: 4/);
});

test('tsc reports count and bounded errors', () => {
  const lines = summarize(fixture('tsc.txt'), { maxLines: 2 });
  assert.equal(lines.length, 2);
  assert.equal(lines[0], 'tsc: 2 errors');
  assert.match(lines[1], /TS2322/);
});

test('eslint reports counts and errors without warning details', () => {
  const lines = summarize(fixture('eslint.txt'));
  assert.equal(lines[0], 'eslint: 1 errors, 1 warnings');
  assert.match(lines[1], /foo\.ts:2:3.*unused/u);
  assert.doesNotMatch(lines.join('\n'), /Unexpected console/u);
});

test('unknown format uses the last lines', () => {
  assert.deepEqual(summarize(fixture('unknown.txt'), { maxLines: 3 }), ['output (last lines)', 'processing', 'finished']);
  assert.deepEqual(summarize('\u001b[31mred\u001b[0m\n', { maxLines: 2 }), ['output (last lines)', 'red']);
});

test('runs a child, preserves exit code, writes full log, and limits screen output', () => {
  const temp = mkdtempSync(join(tmpdir(), 'summarized-test-'));
  try {
    const log = join(temp, 'full log.txt');
    const result = spawnSync(process.execPath, [script, '--log', log, '--max-lines', '5', '--', process.execPath,
      '-e', 'console.log("one\\ntwo\\nthree\\nfour"); process.exit(3)'], { encoding: 'utf8' });
    assert.equal(result.status, 3, result.stderr);
    assert.equal(readFileSync(log, 'utf8'), 'one\ntwo\nthree\nfour\n');
    assert.ok(result.stdout.trim().split('\n').length <= 5);
    assert.match(result.stdout, /Exit code: 3/u);
    assert.match(result.stdout, /Log: /u);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
