import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ruleFiles } from '../rule-files.mjs';

const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });

test('rule files: installed rules of enabled packs, core level doc, found from a worktree too', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rule-files-'));
  try {
    const repo = join(dir, 'repo'), home = join(dir, 'home');
    const install = (pack, files) => {
      const p = join(home, 'cache', pack);
      mkdirSync(p, { recursive: true });
      for (const f of files) writeFileSync(join(p, f), `# ${pack} ${f}\n`);
      return p;
    };
    mkdirSync(join(repo, '.claude'), { recursive: true });
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'AGENTS.md'), '# a\n\n| 항목 | 값 |\n|---|---|\n| 문서 수준 | light |\n');
    writeFileSync(join(repo, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: {
      'harness-core@harness': true, 'harness-unity@harness': true, 'harness-orca@harness': true, 'harness-user@harness': true, 'other@x': true } }));
    git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'init');
    const core = install('core', ['rules.md', 'docs-light.md', 'docs-standard.md']);
    const unity = install('unity', ['rules.md']);
    mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
    writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: {
      'harness-core@harness': [{ scope: 'project', projectPath: repo, installPath: core }],
      'harness-unity@harness': [{ scope: 'project', projectPath: join(dir, 'elsewhere'), installPath: join(dir, 'nope') },
        { scope: 'project', projectPath: repo.toUpperCase(), installPath: unity }],
    } }));
    const out = ruleFiles(repo, { home });
    assert.deepEqual(out.files, [join(core, 'rules.md'), join(core, 'docs-light.md'), join(unity, 'rules.md')]);
    assert.equal(out.roots['harness-unity'], unity);
    assert.deepEqual(out.missing, ['orca'], 'enabled but not installed is reported, user pack is skipped');
    const wt = join(dir, 'wt');
    git(repo, 'worktree', 'add', '-q', wt);
    assert.deepEqual(ruleFiles(wt, { home }).files, out.files);
    // local이 project를 이기고, worktree에 적힌 끔은 main의 켬보다 먼저다
    writeFileSync(join(repo, '.claude', 'settings.local.json'), JSON.stringify({ enabledPlugins: { 'harness-orca@harness': false } }));
    assert.deepEqual(ruleFiles(repo, { home }).missing, [], 'local false turns off the project true');
    mkdirSync(join(wt, '.claude'), { recursive: true });
    writeFileSync(join(wt, '.claude', 'settings.local.json'), JSON.stringify({ enabledPlugins: { 'harness-unity@harness': false } }));
    assert.deepEqual(ruleFiles(wt, { home }).files, [join(core, 'rules.md'), join(core, 'docs-light.md')], 'explicit false in the worktree wins');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
