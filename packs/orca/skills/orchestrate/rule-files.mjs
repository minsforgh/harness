#!/usr/bin/env node
// Codex worker에게 줄 하네스 규칙 파일 경로를 낸다(harness-orca).
//   node rule-files.mjs [--project <저장소>] [--json]
// Codex는 Claude 플러그인 주입을 못 받는다. 그래서 task 명세의 "먼저 읽을 것"에 이 경로들을 넣는다.
// 프로젝트에 켜진 harness 묶음(.claude/settings.json, settings.local.json)마다 설치본의 rules.md를,
// core는 문서 수준의 docs-<수준>.md도 낸다. 규칙 안의 `<harness-<묶음>>`은 그 설치본 폴더다.
// worktree에서 불러도 본 저장소(설치 기록의 projectPath)로 찾는다.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const readJson = (file, fallback) => {
  try { return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return fallback; }
};
const same = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase();

export function mainRoot(project) {
  const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: project, encoding: 'utf8' });
  const common = r.status === 0 ? r.stdout.trim() : '';
  return common && common.endsWith('.git') ? dirname(common) : resolve(project);
}

function topLevel(project) {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: project, encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() ? resolve(r.stdout.trim()) : resolve(project);
}

// 한 폴더에서 묶음마다 켜짐/꺼짐. local이 project를 이긴다(Claude Code 설정 우선순위와 같다).
function packStates(base) {
  const states = new Map();
  for (const f of ['settings.json', 'settings.local.json']) {
    for (const [id, on] of Object.entries(readJson(join(base, '.claude', f), {}).enabledPlugins || {})) {
      const m = id.match(/^harness-([a-z0-9-]+)@harness$/);
      if (m && typeof on === 'boolean' && m[1] !== 'user') states.set(m[1], on);
    }
  }
  return states;
}

export function ruleFiles(project, { home = homedir() } = {}) {
  const root = topLevel(project);
  const main = mainRoot(project);
  // worktree에 적힌 값(켬이든 끔이든)이 먼저다. 적히지 않은 묶음만 main worktree의 값을 따른다(local 설정은 새 worktree로 따라가지 않는다).
  const here = packStates(root), fromMain = same(root, main) ? new Map() : packStates(main);
  const enabled = new Set([...here.keys(), ...fromMain.keys()].filter((p) => (here.has(p) ? here.get(p) : fromMain.get(p)) === true));
  const installed = readJson(join(home, '.claude', 'plugins', 'installed_plugins.json'), {}).plugins || {};
  const agents = existsSync(join(root, 'AGENTS.md')) ? readFileSync(join(root, 'AGENTS.md'), 'utf8') : '';
  const level = (agents.match(/^\|\s*문서\s*수준\s*\|\s*`?([a-z]+)`?\s*\|/m) || [])[1] || 'standard';
  const files = [], roots = {}, missing = [];
  for (const pack of [...enabled].sort((a, b) => (a === 'core' ? -1 : b === 'core' ? 1 : a.localeCompare(b)))) {
    const list = installed[`harness-${pack}@harness`] || [];
    const entry = list.find((e) => e.projectPath && (same(e.projectPath, main) || same(e.projectPath, root)))
      || list.find((e) => e.scope === 'user');
    if (!entry?.installPath || !existsSync(entry.installPath)) { missing.push(pack); continue; }
    roots[`harness-${pack}`] = entry.installPath;
    for (const name of pack === 'core' ? ['rules.md', `docs-${level}.md`] : ['rules.md']) {
      const file = join(entry.installPath, name);
      if (existsSync(file)) files.push(file);
    }
  }
  return { files, roots, missing };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  let project = '.', json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project') project = argv[++i];
    else if (argv[i] === '--json') json = true;
    else { console.error(`Unknown argument: ${argv[i]}`); process.exit(2); }
  }
  const out = ruleFiles(project);
  if (json) console.log(JSON.stringify(out));
  else {
    for (const f of out.files) console.log(f);
    for (const [k, v] of Object.entries(out.roots)) console.log(`<${k}> = ${v}`);
    for (const p of out.missing) console.log(`! harness-${p}가 켜져 있는데 설치본을 찾지 못했다. harness-apply를 다시 돌린다`);
  }
  if (!out.files.length) process.exitCode = 1;
}
