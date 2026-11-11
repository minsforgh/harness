#!/usr/bin/env node
// 원본을 고친 뒤 설치본에 반영한다. dev-wiki 세션에서 돌린다.
//   node <dev-wiki>/_harness/release.mjs <플러그인 이름> [--minor|--major] [--no-bump] [--untested]
//
// 플러그인은 설치할 때 버전별로 캐시에 복사되므로, 버전을 올리지 않으면 update가 아무것도 하지 않는다.
// 1. plugin.json 버전을 올린다(기본 patch).
// 2. 마켓플레이스를 다시 읽고, 이 플러그인이 깔린 곳(user 범위는 설정 폴더마다, project/local 범위는 그 프로젝트에서)마다 update한다.
// 3. 바뀐 파일 목록을 보여 준다. 커밋은 하지 않는다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { HARNESS, REPO, MARKET, claude, claudeConfigs, marketplacePlugins, readJson } from './lib/env.mjs';
import { stampProblem } from './lib/stamp.mjs';

const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith('--'));
const entry = marketplacePlugins().find((p) => p.name === name);
if (!entry) {
  console.error(`플러그인 이름을 준다: ${marketplacePlugins().map((p) => p.name).join(', ')}`);
  process.exit(2);
}
const dir = path.resolve(HARNESS, entry.source);
const manifestFile = path.join(dir, '.claude-plugin', 'plugin.json');
const manifest = readJson(manifestFile);

// 시험을 통과한 원본만 낸다(lib/stamp.mjs). --untested는 급할 때만 쓰고 보고에 적는다
const untested = stampProblem();
if (untested && !args.includes('--untested')) {
  console.error(`[release] ${untested}. 먼저 node _harness/tests/run.mjs를 돌린다(모두 통과하면 지문을 남긴다).`);
  process.exit(2);
}
if (untested) console.log(`[release] 시험 없이 낸다(--untested): ${untested}`);

if (!args.includes('--no-bump')) {
  const [maj, min, pat] = manifest.version.split('.').map(Number);
  manifest.version = args.includes('--major') ? `${maj + 1}.0.0` : args.includes('--minor') ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`;
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`${name} 버전 -> ${manifest.version}`);
}

const id = `${name}@${MARKET}`;
claude(['plugin', 'marketplace', 'update', MARKET, '--json']);

const installed = (readJson(path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json'), {}).plugins || {})[id] || [];
if (!installed.length) console.log(`${id}는 아직 어디에도 깔리지 않았다.`);
for (const inst of installed) {
  if (inst.scope === 'user') {
    for (const config of claudeConfigs()) {
      const r = claude(['plugin', 'update', id, '--scope', 'user', '--json'], { config });
      console.log(`[${config.name}] ${r.json?.message || r.stdout || r.stderr}`);
    }
  } else if (inst.projectPath && fs.existsSync(inst.projectPath)) {
    const r = claude(['plugin', 'update', id, '--scope', inst.scope, '--json'], { cwd: inst.projectPath });
    console.log(`[${inst.scope} ${inst.projectPath}] ${r.json?.message || r.stdout || r.stderr}`);
  }
}

const st = spawnSync('git', ['status', '--short', '--', path.relative(REPO, dir)], { cwd: REPO, encoding: 'utf8' });
console.log(`\n바뀐 파일 (커밋은 따로 한다):\n${st.stdout.trim() || '(없음)'}`);
console.log('적용은 새 세션부터다.');
