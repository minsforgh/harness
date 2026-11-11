#!/usr/bin/env node
// PC 초기화: dev-wiki를 clone한 PC에서 한 번 돌린다. 여러 번 돌려도 결과가 같다.
//   node <dev-wiki>/_harness/setup.mjs [--dry-run]
//
// 1. 이 폴더를 로컬 마켓플레이스(harness)로 등록하고 harness-user 플러그인을 user 범위에 깐다. 옛 이름 플러그인은 지운다.
//    프로젝트 범위로 옮긴 외부 플러그인(공식 unity)은 user 범위에서 끈다.
//    설정 폴더(~/.claude, Orca 프로필)마다 켜 둔다. 남의 항목(Orca, deskpet 훅 등)은 건드리지 않는다.
// 2. 플러그인이 대신하게 된 옛 스킬 링크(junction)를 지운다. 링크만 지우고 원본은 그대로 둔다.
// 3. Codex 홈(~/.codex, Orca의 Codex 홈)의 AGENTS.md에 전역 지시 블록을 넣는다(Codex는 Claude 플러그인을 못 읽는다).
// 4. 설정 폴더의 CLAUDE.md가 전역 지시의 옛 사본이면 backups/로 옮긴다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HARNESS, REPO, MARKET, claude, claudeConfigs, codexHomes } from './lib/env.mjs';

const DRY = process.argv.includes('--dry-run');
const USER_PLUGINS = ['harness-user'];
// 플러그인으로 옮겼거나 묶음에서 뺀 스킬. 이 이름의 링크가 dev-wiki를 가리키면 지운다. 묶음을 옮길 때마다 늘린다.
const RETIRED_LINKS = ['grilling', 'skill-make', 'game-ui', 'game-text', 'game-idea', 'jam-init',
  'dev-flow', 'flow-close', 'flow-verify', 'poc', 'unity-module', 'kit-init', 'orchestrate', 'kickoff']; // 둘째 줄: 9단계(Q173)
// 이름을 바꿨거나 없앤 user 범위 플러그인. 깔려 있으면 지운다(hx-user -> harness-user, 2026-11-09 Q56).
const RETIRED_PLUGINS = ['hx-user'];
// user 범위에서 프로젝트 범위로 옮긴 외부 플러그인. user 범위로 켜져 있으면 끄기만 한다(설치는 남긴다).
// 켜는 것은 harness-apply가 그 묶음을 적용한 프로젝트에서 한다(공식 unity 플러그인, 2026-11-09 Q81).
const USER_SCOPE_OFF = ['unity@unity-agent-plugin'];

const done = [];
const note = (s) => { done.push(s); console.log(s); };
const act = (desc, fn) => { if (DRY) note(`(dry-run) ${desc}`); else { fn(); note(desc); } };

function pluginState(config) {
  const r = claude(['plugin', 'list', '--json'], { config });
  return Array.isArray(r.json) ? r.json : [];
}

// 1. 마켓플레이스와 user 플러그인
for (const config of claudeConfigs()) {
  const markets = claude(['plugin', 'marketplace', 'list', '--json'], { config }).json || [];
  if (!markets.some((m) => m.name === MARKET)) {
    act(`[${config.name}] 마켓플레이스 ${MARKET} 등록 (${HARNESS})`, () => {
      const r = claude(['plugin', 'marketplace', 'add', HARNESS, '--scope', 'user', '--json'], { config });
      if (r.status !== 0) throw new Error(`marketplace add 실패: ${r.stdout || r.stderr}`);
    });
  } else if (!DRY) {
    claude(['plugin', 'marketplace', 'update', MARKET, '--json'], { config });
  }
  for (const name of USER_PLUGINS) {
    const id = `${name}@${MARKET}`;
    const p = pluginState(config).find((x) => x.id === id && x.scope === 'user');
    if (!p) {
      act(`[${config.name}] ${id} 설치 (user 범위)`, () => {
        const r = claude(['plugin', 'install', id, '--scope', 'user', '--json'], { config });
        if (r.status !== 0) throw new Error(`install 실패: ${r.stdout || r.stderr}`);
      });
    } else if (!p.enabled) {
      act(`[${config.name}] ${id} 켜기`, () => claude(['plugin', 'enable', id, '--scope', 'user', '--json'], { config }));
    } else {
      note(`[${config.name}] ${id} ${p.version} 이미 켜짐`);
    }
  }
  for (const id of USER_SCOPE_OFF) {
    if (!pluginState(config).some((x) => x.id === id && x.scope === 'user' && x.enabled)) continue;
    act(`[${config.name}] ${id} user 범위 끄기 (그 묶음을 적용한 프로젝트에서 켠다)`, () => {
      const r = claude(['plugin', 'disable', id, '--scope', 'user', '--json'], { config });
      if (r.status !== 0) throw new Error(`disable 실패: ${r.stdout || r.stderr}`);
    });
  }
  for (const name of RETIRED_PLUGINS) {
    const id = `${name}@${MARKET}`;
    if (!pluginState(config).some((x) => x.id === id && x.scope === 'user')) continue;
    act(`[${config.name}] 옛 플러그인 ${id} 지우기`, () => {
      const r = claude(['plugin', 'uninstall', id, '--scope', 'user', '--json'], { config });
      if (r.status !== 0) throw new Error(`uninstall 실패: ${r.stdout || r.stderr}`);
    });
  }
}

// Orca 프로필은 plugins 폴더를 ~/.claude와 같이 쓰고 settings.json만 따로라, 한 곳에서 uninstall하면
// 나머지 프로필의 enabledPlugins에 옛 이름이 남는다. 깔려 있지 않은 옛 이름 항목만 지운다(다른 항목은 그대로).
for (const config of claudeConfigs()) {
  const file = path.join(config.dir, 'settings.json');
  if (!fs.existsSync(file)) continue;
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  const on = settings.enabledPlugins || {};
  const stale = RETIRED_PLUGINS.map((n) => `${n}@${MARKET}`).filter((id) => id in on);
  if (!stale.length || pluginState(config).some((x) => stale.includes(x.id))) continue;
  act(`[${config.name}] settings.json에 남은 옛 플러그인 항목 지우기: ${stale.join(', ')}`, () => {
    for (const id of stale) delete on[id];
    fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  });
}

// 2. 옛 스킬 링크 지우기
const linkDirs = [path.join(os.homedir(), '.claude', 'skills'), path.join(os.homedir(), '.agents', 'skills')];
const inRepo = (target) => path.resolve(target).toLowerCase().startsWith(REPO.toLowerCase() + path.sep);
for (const dir of linkDirs) {
  if (!fs.existsSync(dir)) continue;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    let st;
    try { st = fs.lstatSync(p); } catch { continue; }
    if (!st.isSymbolicLink()) continue; // 진짜 폴더는 건드리지 않는다
    const target = fs.readlinkSync(p);
    if (!inRepo(target)) continue; // dev-wiki 밖을 가리키는 링크(npx skills, Orca 설치기)는 그 설치기가 주인이다
    const broken = !fs.existsSync(target);
    if (RETIRED_LINKS.includes(name) || broken) {
      act(`링크 삭제 ${p} -> ${target}${broken ? ' (끊어짐)' : ''}`, () => fs.unlinkSync(p));
    }
  }
}

// 3. Codex 전역 지시
const instructions = fs.readFileSync(path.join(HARNESS, 'user', 'instructions.md'), 'utf8').trim();
const START = '<!-- harness:harness-user start (dev-wiki _harness/user/instructions.md에서 setup.mjs가 쓴다. 여기서 고치지 않는다) -->';
const END = '<!-- harness:harness-user end -->';
for (const home of codexHomes()) {
  const file = path.join(home, 'AGENTS.md');
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const block = `${START}\n${instructions}\n${END}`;
  // 옛 표식(harness:hx-user)도 찾아 새 블록으로 바꾼다.
  // replace에 함수를 넘긴다: 문자열이면 지시 안의 $&, $1 같은 글자를 치환 패턴으로 읽는다.
  const re = /<!-- harness:(?:hx|harness)-user start[^\n]*-->[\s\S]*?<!-- harness:(?:hx|harness)-user end -->/;
  const next = re.test(old) ? old.replace(re, () => block) : (old.trim() ? `${old.trimEnd()}\n\n${block}\n` : `${block}\n`);
  if (next !== old) act(`Codex 전역 지시 블록 쓰기 ${file}`, () => fs.writeFileSync(file, next, 'utf8'));
  else note(`Codex 전역 지시 블록 같음 ${file}`);
}

// 4. 설정 폴더의 CLAUDE.md 옛 사본
const norm = (s) => s.replace(/\s+/g, ' ').trim();
for (const config of claudeConfigs()) {
  const file = path.join(config.dir, 'CLAUDE.md');
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, 'utf8');
  if (norm(instructions).includes(norm(text))) {
    const bak = path.join(config.dir, 'backups', 'CLAUDE.md.harness-bak');
    act(`[${config.name}] CLAUDE.md는 전역 지시의 옛 사본이라 옮김 -> ${bak}`, () => {
      fs.mkdirSync(path.dirname(bak), { recursive: true });
      fs.renameSync(file, bak);
    });
  } else {
    note(`[${config.name}] CLAUDE.md에 전역 지시에 없는 내용이 있다. 건드리지 않았다: ${file}`);
  }
}

console.log(`\n${DRY ? '바꿀 것' : '끝'}: ${done.length}줄. 새 세션부터 적용된다.`);
