import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('.', import.meta.url));
const script = resolve(directory, '../start-worker.sh');
const fixtures = join(directory, 'fixtures');
const gitRoot = 'C:/Program Files/Git';
const bash = `${gitRoot}/bin/bash.exe`;

function runGit(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function harness() {
  const temp = mkdtempSync(join(tmpdir(), 'orca-start-test-'));
  const repo = join(temp, 'repo');
  const home = join(temp, 'home');
  const log = join(temp, 'orca.log');
  const fakeBin = join(temp, 'fixtures');
  mkdirSync(repo);
  mkdirSync(fakeBin);
  for (const name of ['orca', 'codex', 'opencode']) {
    const destination = join(fakeBin, name);
    writeFileSync(destination, readFileSync(join(fixtures, name), 'utf8').replaceAll('\r\n', '\n'));
    chmodSync(destination, 0o755);
  }
  const testPath = [fakeBin, dirname(process.execPath), `${gitRoot}/mingw64/bin`, `${gitRoot}/usr/bin`].join(delimiter);
  mkdirSync(join(home, '.codex'), { recursive: true });
  runGit(['init', '-q'], repo);
  runGit(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'init'], repo);
  const config = join(home, '.codex', 'config.toml');
  writeFileSync(config, 'check_for_update_on_startup = false\n');
  const invoke = (args = [], extraEnv = {}, cwd = repo) => spawnSync(bash, [script, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: testPath,
      HOME: home.replaceAll('\\', '/'),
      ORCA_FAKE_LOG: log.replaceAll('\\', '/'),
      ORCA_START_WORKER_SLEEP_SECONDS: '0',
      ORCA_FAKE_TAIL: 'Working',
      ORCA_CLI_COMMAND: '',
      ORCA_DEV_REPO_ROOT: '',
      ...extraEnv,
    },
  });
  const calls = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split(/\r?\n/) : [];
  return { temp, repo, home, config, log, invoke, calls, cleanup: () => rmSync(temp, { recursive: true, force: true }) };
}

test('missing CLI and failing --version stop before worker-start', () => {
  const h = harness();
  try {
    const missing = h.invoke(['--agent', 'claude', '--worktree', 'current']);
    assert.equal(missing.status, 2, missing.stderr);
    assert.match(missing.stdout, /PREFLIGHT FAIL agent: .*PATH/);
    assert.match(missing.stdout, /DISPATCH - preflight-failed\s*$/);
    const broken = h.invoke(['--agent', 'codex', '--worktree', 'current'], { FAKE_CODEX_VERSION_FAIL: '1' });
    assert.equal(broken.status, 2, broken.stderr);
    assert.match(broken.stdout, /PREFLIGHT FAIL agent: .*--version/);
    assert.deepEqual(h.calls(), []);
  } finally { h.cleanup(); }
});

test('Orca CLI name follows ORCA_CLI_COMMAND and other agents are left to worker-start', () => {
  const h = harness();
  try {
    const missing = h.invoke(['--agent', 'opencode', '--worktree', 'current'], { ORCA_CLI_COMMAND: 'orca-not-here' });
    assert.equal(missing.status, 2, missing.stderr);
    assert.match(missing.stdout, /PREFLIGHT FAIL orca: 'orca-not-here' is not on PATH/);
    writeFileSync(join(h.temp, 'fixtures', 'orca-wsl'), readFileSync(join(fixtures, 'orca'), 'utf8').replaceAll('\r\n', '\n'));
    chmodSync(join(h.temp, 'fixtures', 'orca-wsl'), 0o755);
    const other = h.invoke(['--agent', 'gemini', '--worktree', 'current'], { ORCA_CLI_COMMAND: 'orca-wsl' });
    assert.equal(other.status, 0, other.stdout + other.stderr);
    assert.match(other.stdout, /PREFLIGHT skip agent 'gemini'/);
    assert.match(h.calls()[0], /^orchestration worker-start --agent gemini/);
  } finally { h.cleanup(); }
});

test('Codex config is required and a valid version is printed', () => {
  const h = harness();
  try {
    writeFileSync(h.config, 'check_for_update_on_startup = true\n');
    const failed = h.invoke(['--agent', 'codex', '--worktree', 'current']);
    assert.equal(failed.status, 2, failed.stderr);
    assert.match(failed.stdout, /PREFLIGHT ok codex codex 9\.9\.9-fake/);
    assert.match(failed.stdout, /PREFLIGHT FAIL codex-config:/);
    assert.deepEqual(h.calls(), []);
  } finally { h.cleanup(); }
});

test('new worktrees require an existing base ref in the target repository', () => {
  const h = harness();
  try {
    for (const mode of ['new-child', 'new-top-level']) {
      const missing = h.invoke(['--agent', 'opencode', '--worktree', mode, '--name', 'x']);
      assert.equal(missing.status, 2, missing.stderr);
      assert.match(missing.stdout, /PREFLIGHT FAIL base-branch:/);
    }
    const invalid = h.invoke(['--agent', 'opencode', '--worktree', 'new-child', '--base-branch', 'no-such-ref']);
    assert.equal(invalid.status, 2, invalid.stderr);
    assert.match(invalid.stdout, /PREFLIGHT FAIL base-branch: .*does not resolve/);
    assert.deepEqual(h.calls(), []);
  } finally { h.cleanup(); }
});

test('project preflight failure stops launch, including --repo path: target', () => {
  const h = harness();
  try {
    mkdirSync(join(h.repo, '.orca'));
    writeFileSync(join(h.repo, '.orca', 'preflight.sh'), 'echo missing project tool\nexit 3\n');
    const result = h.invoke(['--agent', 'opencode', '--worktree', 'current', '--repo', `path:${h.repo.replaceAll('\\', '/')}`], {}, h.temp);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stdout, /missing project tool/);
    assert.match(result.stdout, /PREFLIGHT FAIL project-hook:/);
    assert.deepEqual(h.calls(), []);
  } finally { h.cleanup(); }
});

test('healthy launch forwards arguments and reports new worktree and postsetup warning', () => {
  const h = harness();
  try {
    const created = join(h.temp, 'created');
    mkdirSync(join(created, '.orca'), { recursive: true });
    writeFileSync(join(created, '.orca', 'postsetup-check.sh'), 'echo "POSTSETUP ARG $1"\nexit 4\n');
    const args = ['--agent', 'opencode', '--worktree', 'new-child', '--name', 'x', '--base-branch', 'HEAD'];
    const result = h.invoke(args, { ORCA_FAKE_WORKTREE: created.replaceAll('\\', '/') });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PREFLIGHT ok opencode opencode 9\.9\.9-fake/);
    assert.match(result.stdout, /WORKTREE .*created/);
    assert.match(result.stdout, /POSTSETUP ARG .*created/);
    assert.match(result.stdout, /POSTSETUP WARN:/);
    assert.match(result.stdout, /DISPATCH ctx_fake working\s*$/);
    assert.equal(h.calls()[0], `orchestration worker-start ${args.join(' ')} --json`);
  } finally { h.cleanup(); }
});

test('worktree path can be read from an Orca worktree ID', () => {
  const h = harness();
  try {
    const created = join(h.temp, 'created').replaceAll('\\', '/');
    const result = h.invoke(['--agent', 'opencode', '--worktree', 'new-top-level', '--base-branch', 'HEAD'], {
      ORCA_FAKE_ID_ONLY: '1', ORCA_FAKE_WORKTREE: created,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(`WORKTREE ${created}`));
  } finally { h.cleanup(); }
});

for (const [tail, state] of [
  ['Working Permission required Allow once Allow always', 'blocked-permission'],
  ['Update now', 'blocked-update'],
]) {
  test(`${state} never sends Enter`, () => {
    const h = harness();
    try {
      const result = h.invoke(['--agent', 'opencode', '--worktree', 'current'], { ORCA_FAKE_TAIL: tail });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, new RegExp(`DISPATCH ctx_fake ${state}\\s*$`));
      assert.ok(h.calls().some(call => call.startsWith('orchestration worker-start ')));
      assert.ok(!h.calls().some(call => call.startsWith('terminal send ')));
    } finally { h.cleanup(); }
  });
}

test('idle screen still sends Enter under the existing interface', () => {
  const h = harness();
  try {
    const result = h.invoke(['--agent', 'opencode', '--worktree', 'current'], { ORCA_FAKE_TAIL: 'waiting' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /DISPATCH ctx_fake submitted\s*$/);
    assert.ok(h.calls().some(call => call.startsWith('terminal send ')));
  } finally { h.cleanup(); }
});
