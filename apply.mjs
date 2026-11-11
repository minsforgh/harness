#!/usr/bin/env node
// 프로젝트에 묶음을 적용한다. 여러 번 돌려도 결과가 같다. harness-user:harness-apply 스킬이 부른다.
//   node <dev-wiki>/_harness/apply.mjs <프로젝트> [--profile <이름> | --packs core,unity] [--docs standard|light] [--personal] [--dry-run] [--no-plugins]
// 프로필과 묶음을 둘 다 주지 않으면 프로젝트에 이미 켜진 harness 묶음을 따르고, 켜진 것이 없으면 personal이다.
//
// 새 프로젝트: --new [--unity <에디터 버전>] [--unity-template 2d|3d|<id>]. 경로가 없거나 빈 폴더여야 한다.
//   묶음 폴더에 new-project.mjs가 있으면 그것이 프로젝트를 만든다(unity: 공식 unity projects create, 고칠 점).
//   없으면 빈 폴더를 만든다. 그다음 git init -b main을 하고 아래 적용을 이어 간다. 개인 모드와 같이 쓰지 않는다.
//
// 1. 묶음 플러그인을 켠다: 저장소 모드는 project 범위(.claude/settings.json), --personal은 local 범위(settings.local.json, git에 안 올라감).
//    team 묶음이 들면(unity-team, 내가 PR 관리자인 팀 저장소) 플러그인은 local 범위로 켜고 2, 3은 저장소 모드대로 한다.
//    팀원에게는 플러그인이 없으므로 팀원 결과물에 닿는 규칙과 검사는 저장소 파일(블록, 사본, 훅)로 들어간다(harness-design Q156, Q167).
//    규칙, 스킬, 훅, 커밋 전 검사는 플러그인 안에 있고 프로젝트에 복사하지 않는다.
//    묶음 폴더의 plugins.json에 적힌 외부 플러그인(unity 묶음의 공식 unity 플러그인)도 같은 범위로 켠다. 마켓플레이스가 없으면 등록한다.
// 2. (저장소 모드만) 묶음 폴더의 파일을 프로젝트에 넣는다. 파일은 방금 켠 버전의 설치본에서 읽는다(없으면 원본).
//    scaffold/  처음 파일. common/과 문서 수준 폴더(standard/, light/)를 합친다. 없을 때만 만든다. 그 뒤로는 프로젝트 것이다.
//               같은 경로면 수준 폴더, 뒤 묶음 것을 쓴다
//    managed/   연결 파일(.githooks/pre-commit 등). 적용할 때마다 덮어쓴다
//    lines/     줄 목록 파일(.gitattributes, .gitignore). 없는 줄만 "# harness-<묶음>" 아래에 더한다
//    values.md  AGENTS.md "값" 표의 행. 없는 행만 더한다(값은 프로젝트가 고친다). 같은 항목은 뒤 묶음 것을 쓴다. "문서 수준" 행은 apply가 넣는다
//    decisions.md 나중에 바꾸기 비싼 구조 결정("- 이름: 고를 것. 정할 때: ..."). standard에서 개요를 처음 만들 때 "미정"에 넣는다.
//               같은 이름은 뒤 묶음 것을 쓴다("- 이름: 정함 ..."이면 뺀다). 개요가 이미 있으면 넣지 않고, 문서 어디에도 안 보이는 이름만 알린다
//    copies.json 다른 묶음 파일의 저장소 사본(team: core 문서 검사를 .githooks/harness-core/에). 적용할 때마다 덮어쓴다
//    merge/     JSON 파일(.claude/settings.json 등). 없는 키와 배열에 없는 값만 더한다(남의 값은 그대로)
//    agents-block.mjs AGENTS.md의 <!-- harness-<묶음>:start --> ~ end 블록을 만든다(team: core와 unity 규칙의 저장소 층 줄). 적용할 때마다 다시 쓴다
// 문서 수준: --docs > AGENTS.md "값" 표에 이미 있는 값 > 프로필의 docs > standard. --docs가 표의 값과 다르면 표를 고친다.
// unity 묶음이면 Unity 프로젝트 위치와 com.unity.pipeline 유무, 버전(0.10 아래면 알림)을 보인다. 패키지는 설치하지 않는다.
// 3. (저장소 모드만) core.hooksPath를 .githooks로. 다른 값이 이미 있으면 바꾸지 않고 알린다.
// 커밋은 하지 않는다. --no-plugins는 플러그인 단계를 건너뛰고 원본 폴더 파일을 쓴다(시험, 오프라인용).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { HARNESS, MARKET, claude, marketplacePlugins, readJson } from './lib/env.mjs';

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const DRY = argv.includes('--dry-run');
const PERSONAL = argv.includes('--personal');
const NO_PLUGINS = argv.includes('--no-plugins');
const NEW = argv.includes('--new');
const VALUE_OPTS = ['--profile', '--packs', '--docs', '--unity', '--unity-template'];
const target = argv.find((a, i) => !a.startsWith('--') && !VALUE_OPTS.includes(argv[i - 1]));

function fail(msg) { console.error(msg); process.exit(2); }
if (!target) fail('프로젝트 경로를 준다: node apply.mjs <프로젝트> --profile personal');
const profiles = readJson(path.join(HARNESS, 'profiles.json'));
const market = marketplacePlugins();

if (NEW) {
  if (PERSONAL) fail('--new는 내 새 프로젝트를 만든다. 개인 모드(--personal)와 같이 쓰지 않는다.');
  const dir = path.resolve(target);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) fail(`${dir}가 이미 있고 비어 있지 않다. --new는 없는 폴더나 빈 폴더에만 쓴다.`);
  // 켜진 묶음이 있을 수 없으니 프로필이나 묶음 목록으로 정한다
  const want = opt('--packs') ? opt('--packs').split(',') : profiles[opt('--profile') || 'personal']?.packs;
  if (!want) fail(`없는 프로필이다. 있는 것: ${Object.keys(profiles).filter((k) => k !== '_').join(', ')}`);
  const makers = want.map((p) => path.join(HARNESS, 'packs', p, 'new-project.mjs')).filter((f) => fs.existsSync(f));
  if (DRY) {
    console.log(`(dry-run) 새 프로젝트 ${dir}: ${makers.length ? makers.map((f) => `${path.basename(path.dirname(f))}/new-project.mjs`).join(', ') : '빈 폴더'}, git init -b main, 그다음 적용`);
    console.log('(dry-run) 폴더가 없어 적용 단계는 미리 볼 수 없다. --dry-run 없이 돌린다.');
    process.exit(0);
  }
  for (const f of makers) {
    if (fs.existsSync(path.join(dir, 'Packages')) || (fs.existsSync(dir) && fs.readdirSync(dir).length)) break;
    const mod = await import(pathToFileURL(f).href);
    try {
      mod.createProject({ target: dir, version: opt('--unity'), template: opt('--unity-template') || undefined, note: (s) => console.log(s) });
    } catch (e) { fail(e.message); }
  }
  fs.mkdirSync(dir, { recursive: true });
  const init = spawnSync('git', ['init', '-b', 'main'], { cwd: dir, encoding: 'utf8' });
  if (init.status !== 0) fail(`git init 실패: ${init.stderr}`);
  console.log(`git init -b main (${dir})`);
}

const git = (...args) => spawnSync('git', args, { cwd: target, encoding: 'utf8' });
const top = git('rev-parse', '--show-toplevel');
if (top.status !== 0) fail(`${target}는 git 저장소가 아니다. 먼저 git init 한다.`);
const ROOT = path.resolve(top.stdout.trim());
// 프로젝트에 이미 켜진 harness 묶음(.claude/settings.json, 개인 모드는 settings.local.json). 마켓플레이스 순서로.
const enabledPacks = (() => {
  const on = new Set();
  for (const f of ['settings.json', 'settings.local.json']) {
    let en = {};
    try { en = readJson(path.join(ROOT, '.claude', f)).enabledPlugins || {}; } catch { continue; }
    for (const [id, v] of Object.entries(en)) {
      const m = id.match(/^harness-(.+)@(.+)$/);
      if (m && m[2] === MARKET && v === true && fs.existsSync(path.join(HARNESS, 'packs', m[1]))) on.add(m[1]);
    }
  }
  return market.map((p) => p.name.replace(/^harness-/, '')).filter((p) => on.has(p));
})();
// 프로필도 묶음도 주지 않으면 이미 켜진 묶음을 따른다(묶음을 고친 뒤 다시 돌릴 때 프로필을 빠뜨려도 덜 적용되지 않게). 없으면 personal.
const INFERRED = !opt('--packs') && !opt('--profile') && enabledPacks.length > 0;
const profile = opt('--packs') || INFERRED ? null : profiles[opt('--profile') || 'personal'];
if (!opt('--packs') && !INFERRED && !profile?.packs) fail(`없는 프로필이다. 있는 것: ${Object.keys(profiles).filter((k) => k !== '_').join(', ')}`);
const packs = opt('--packs') ? opt('--packs').split(',') : INFERRED ? enabledPacks : profile.packs;
// core가 AGENTS.md 틀, 값 표, 커밋 전 검사 연결을 준다. 다른 묶음은 그 위에 얹는다.
if (!packs.includes('core')) fail(`core 묶음 없이 적용하지 않는다(다른 묶음의 바탕). 예: --packs core,${packs.join(',')}`);
const LEVELS = ['standard', 'light'];
// 값 칸의 백틱과 굵게 표시는 벗기고 읽는다(lib/project.py의 level_info와 같게).
const LEVEL_ROW = /^\|\s*문서\s*수준\s*\|([^|\n]*)\|.*$/m;
const agentsNow = fs.existsSync(path.join(ROOT, 'AGENTS.md')) ? fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8').replace(/^﻿/, '') : '';
const levelNow = (agentsNow.match(LEVEL_ROW) || [])[1]?.trim().replace(/^[`*_\s]+|[`*_\s]+$/g, '').toLowerCase() || undefined;
const level = opt('--docs') || levelNow || profile?.docs || 'standard';
if (!LEVELS.includes(level)) fail(`문서 수준은 ${LEVELS.join(' 또는 ')}이다: ${level}`);
const entries = packs.map((p) => {
  const e = market.find((m) => m.name === `harness-${p}`);
  if (!e) fail(`harness-${p} 묶음이 마켓플레이스에 없다. 있는 것: ${market.map((m) => m.name).join(', ')}`);
  return { pack: p, id: `${e.name}@${MARKET}`, source: path.resolve(HARNESS, e.source) };
});

const log = [];
const note = (s) => { log.push(s); console.log(s); };
const act = (desc, fn) => { if (DRY) note(`(dry-run) ${desc}`); else { fn(); note(desc); } };
note(INFERRED ? `프로필을 주지 않아 켜진 묶음(${packs.join(', ')})으로 적용한다`
  : !opt('--packs') && !opt('--profile') ? '프로필을 주지 않았고 켜진 묶음도 없어 personal로 적용한다' : `묶음: ${packs.join(', ')}`);
for (const p of enabledPacks.filter((x) => !packs.includes(x))) {
  note(`! harness-${p}가 켜져 있지만 이번 묶음 목록에 없다. 그대로 둔다(빼려면 그 플러그인을 끄고, 남은 줄과 값 행은 손으로 지운다).`);
}

// 1. 플러그인
const TEAM = packs.includes('team');
const scope = PERSONAL || TEAM ? 'local' : 'project';
if (TEAM && !PERSONAL) note('팀 저장소(team 묶음): 플러그인은 이 PC에만 local 범위로 켜고, 팀원에게 닿는 규칙과 검사는 저장소 파일로 넣는다');
function installed(id) {
  const file = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
  const list = (readJson(file, {}).plugins || {})[id] || [];
  const same = list.filter((e) => e.projectPath && path.resolve(e.projectPath).toLowerCase() === ROOT.toLowerCase());
  return [...same, ...list].find((e) => fs.existsSync(e.installPath || ''));
}
// 묶음이 같이 켜는 외부 플러그인(묶음 폴더의 plugins.json, 예: unity 묶음의 공식 unity 플러그인)
const external = entries.flatMap((e) => {
  const file = path.join(e.source, 'plugins.json');
  return fs.existsSync(file) ? readJson(file).plugins.map((p) => ({ ...p, pack: e.pack })) : [];
});
if (!NO_PLUGINS) {
  if (!DRY) claude(['plugin', 'marketplace', 'update', MARKET, '--json']);
  const markets = (claude(['plugin', 'marketplace', 'list', '--json']).json || []).map((m) => m.name);
  for (const p of external.filter((x) => !markets.includes(x.marketplace))) {
    act(`마켓플레이스 ${p.marketplace} 등록 (${p.source}, harness-${p.pack}이 씀)`, () => {
      const r = claude(['plugin', 'marketplace', 'add', p.source, '--json']);
      if (r.status !== 0) throw new Error(`marketplace add 실패: ${r.stdout || r.stderr}`);
    });
  }
  const state = claude(['plugin', 'list', '--json'], { cwd: ROOT }).json || [];
  for (const { id } of [...entries, ...external]) {
    const here = state.find((x) => x.id === id && x.scope === scope);
    if (!here) {
      act(`${id} 설치 (${scope} 범위)`, () => {
        const r = claude(['plugin', 'install', id, '--scope', scope, '--json'], { cwd: ROOT });
        if (r.status !== 0) throw new Error(`install 실패: ${r.stdout || r.stderr}`);
      });
    } else if (!here.enabled) {
      act(`${id} 켜기 (${scope} 범위)`, () => claude(['plugin', 'enable', id, '--scope', scope, '--json'], { cwd: ROOT }));
    } else {
      note(`${id} ${here.version} 이미 켜짐 (${scope} 범위)`);
    }
  }
}

if (PERSONAL) {
  note('개인 모드: 플러그인만 local 범위로 켰다. 공용 파일과 git 훅은 건드리지 않는다(남의 팀 저장소용. 내가 PR 관리자인 팀 저장소는 --profile unity-team).');
  process.exit(0);
}

// 2. 파일
const filesDir = (e) => {
  if (NO_PLUGINS) return e.source;
  const inst = installed(e.id);
  if (inst) return inst.installPath;
  note(`! ${e.id} 설치본을 못 찾아 원본 폴더를 쓴다(${e.source})`);
  return e.source;
};
const dirs = entries.map((e) => ({ ...e, dir: filesDir(e) }));

function walk(dir, base = '') {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const rel = base ? `${base}/${d.name}` : d.name;
    return d.isDirectory() ? walk(path.join(dir, d.name), rel) : [rel];
  });
}
const read = (f) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const write = (rel, text) => {
  const full = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text, 'utf8');
};

const scaffold = new Map();
for (const d of dirs) {
  for (const part of ['common', level]) {
    const dir = path.join(d.dir, 'scaffold', part);
    for (const rel of walk(dir)) scaffold.set(rel, path.join(dir, rel));
  }
}
note(`문서 수준 ${level}${levelNow && levelNow !== level ? ` (지금 표는 ${levelNow})` : ''}`);
if (opt('--profile') && !opt('--docs') && profile?.docs && levelNow && profile.docs !== levelNow) {
  note(`! 프로필 ${opt('--profile')}의 문서 수준은 ${profile.docs}지만 표의 ${levelNow}를 따랐다. 바꾸려면 --docs ${profile.docs}를 준다.`);
}
// 초기 구조 결정: light(짧게 끝낼 프로젝트)는 묶음 규칙의 기본값으로 가므로 넣지 않는다.
const OVERVIEW = 'docs/overview.md';
const decisions = new Map();
if (level === 'standard') {
  for (const d of dirs) {
    const file = path.join(d.dir, 'decisions.md');
    if (!fs.existsSync(file)) continue;
    for (const l of read(file).split('\n')) {
      const m = l.match(/^- ([^:]+):\s*(.*)$/);
      if (!m) continue;
      // 묶음이 이미 정한 결정은 앞 묶음의 같은 이름을 "미정"에서 뺀다(team: 어셈블리 나누기는 시스템마다)
      if (/^정함/.test(m[2])) decisions.delete(m[1].trim());
      else decisions.set(m[1].trim(), l.trim());
    }
  }
}
function withDecisions(text) {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => /^##\s+미정\s*$/.test(l));
  if (at < 0 || !decisions.size) return text;
  let end = lines.findIndex((l, i) => i > at && /^#{1,2}\s/.test(l));
  if (end < 0) end = lines.length;
  while (end > at + 1 && !lines[end - 1].trim()) end--;
  lines.splice(end, 0, '', '나중에 바꾸기 비싼 구조 결정(정할 때가 오면 묻는다. 이 프로젝트에 해당 없으면 지운다):', '', ...decisions.values());
  return lines.join('\n');
}
for (const [rel, src] of scaffold) {
  if (fs.existsSync(path.join(ROOT, rel))) note(`그대로 ${rel} (이미 있음)`);
  else act(`만듦 ${rel}${rel === OVERVIEW && decisions.size ? ` ("미정"에 구조 결정 ${decisions.size}개)` : ''}`,
    () => write(rel, rel === OVERVIEW ? withDecisions(read(src)) : read(src)));
}
if (decisions.size && fs.existsSync(path.join(ROOT, OVERVIEW))) {
  const docs = ['AGENTS.md', OVERVIEW, 'docs/architecture.md', ...walk(path.join(ROOT, 'docs', 'adr')).map((r) => `docs/adr/${r}`)]
    .filter((r) => fs.existsSync(path.join(ROOT, r))).map((r) => read(path.join(ROOT, r)).replace(/\s+/g, '')).join('\n');
  const unseen = [...decisions.keys()].filter((k) => !docs.includes(k.replace(/\s+/g, '')));
  if (unseen.length) note(`! 개요가 이미 있어 구조 결정 목록을 넣지 않았다. 문서에 안 보이는 것: ${unseen.join(', ')}. 아직 안 정한 것만 개요 "미정"에 더한다(harness-apply).`);
}
// CLAUDE.md는 @AGENTS.md만 둔다. /init이나 "CLAUDE.md에 추가해"로 쌓인 내용은 Codex가 못 본다.
const claudeFile = path.join(ROOT, 'CLAUDE.md');
if (fs.existsSync(claudeFile)) {
  const claudeLines = read(claudeFile).split('\n');
  const extra = claudeLines.filter((l) => l.trim() && !/^\s*@\S+\s*$/.test(l) && !/^#{1,6}\s/.test(l) && !l.trim().startsWith('<!--'));
  if (!claudeLines.some((l) => l.trim() === '@AGENTS.md')) note('! CLAUDE.md에 @AGENTS.md 줄이 없다. 첫 줄에 더한다.');
  if (extra.length) note(`! CLAUDE.md에 @ 줄 밖의 내용이 ${extra.length}줄 있다. AGENTS.md로 옮기고 @AGENTS.md만 남긴다(standard는 커밋 전 검사가 막는다).`);
}

for (const d of dirs) {
  for (const rel of walk(path.join(d.dir, 'managed'))) {
    const text = read(path.join(d.dir, 'managed', rel));
    const full = path.join(ROOT, rel);
    if (fs.existsSync(full) && read(full) === text) continue;
    act(`${fs.existsSync(full) ? '덮어씀' : '만듦'} ${rel} (harness-${d.pack} 연결 파일)`, () => {
      write(rel, text);
      if (rel.startsWith('.githooks/') && !rel.endsWith('.py')) fs.chmodSync(full, 0o755);
    });
  }
}

for (const d of dirs) {
  const file = path.join(d.dir, 'copies.json');
  if (!fs.existsSync(file)) continue;
  for (const c of readJson(file).copies || []) {
    const from = dirs.find((x) => x.pack === c.pack);
    if (!from || !fs.existsSync(path.join(from.dir, c.from))) {
      note(`! harness-${d.pack} 사본: harness-${c.pack}의 ${c.from}가 이번 적용에 없어 ${c.to}를 넣지 않았다`);
      continue;
    }
    const text = read(path.join(from.dir, c.from));
    const full = path.join(ROOT, c.to);
    if (fs.existsSync(full) && read(full) === text) continue;
    act(`${fs.existsSync(full) ? '덮어씀' : '만듦'} ${c.to} (harness-${c.pack} 사본, harness-${d.pack})`, () => write(c.to, text));
  }
}

// 없는 키와 배열에 없는 값만 더한다. 더한 수를 돌려준다
function mergeJson(have, want) {
  let added = 0;
  for (const [k, v] of Object.entries(want)) {
    if (Array.isArray(v)) {
      if (have[k] === undefined) have[k] = [];
      if (!Array.isArray(have[k])) continue;
      for (const x of v) if (!have[k].includes(x)) { have[k].push(x); added++; }
    } else if (v && typeof v === 'object') {
      if (have[k] === undefined) have[k] = {};
      if (have[k] && typeof have[k] === 'object' && !Array.isArray(have[k])) added += mergeJson(have[k], v);
    } else if (have[k] === undefined) {
      have[k] = v;
      added++;
    }
  }
  return added;
}
for (const d of dirs) {
  for (const rel of walk(path.join(d.dir, 'merge'))) {
    const full = path.join(ROOT, rel);
    let have = {};
    if (fs.existsSync(full)) {
      try { have = JSON.parse(read(full).replace(/^\uFEFF/, '')); } catch { note(`! ${rel}가 JSON으로 안 읽혀 harness-${d.pack} 값을 넣지 않았다`); continue; }
    }
    const added = mergeJson(have, JSON.parse(read(path.join(d.dir, 'merge', rel))));
    if (added) act(`${rel}에 ${added}개 더함 (harness-${d.pack})`, () => write(rel, JSON.stringify(have, null, 2) + '\n'));
  }
}

for (const d of dirs) {
  for (const rel of walk(path.join(d.dir, 'lines'))) {
    const want = read(path.join(d.dir, 'lines', rel)).split('\n').filter((l) => l.trim());
    const full = path.join(ROOT, rel);
    const have = fs.existsSync(full) ? read(full) : '';
    const haveSet = new Set(have.split('\n').map((l) => l.trim()));
    const missing = want.filter((l) => !haveSet.has(l.trim()));
    if (!missing.length) continue;
    act(`${rel}에 ${missing.length}줄 더함 (harness-${d.pack})`, () =>
      write(rel, (have && !have.endsWith('\n') ? have + '\n' : have) + `${have ? '\n' : ''}# harness-${d.pack}\n${missing.join('\n')}\n`));
    // eol=lf를 새로 넣으면 이미 CRLF로 커밋된 파일은 건드릴 때마다 줄 끝 전체가 바뀐 것으로 보인다
    if (rel === '.gitattributes' && missing.some((l) => /\beol=lf\b/.test(l))) {
      const crlf = git('ls-files', '--eol').stdout.split('\n').filter((l) => l.startsWith('i/crlf')).length;
      if (crlf) note(`! 이미 CRLF로 커밋된 파일이 ${crlf}개 있다. git add --renormalize . 로 한 번 맞추고 따로 커밋한다(파일 내용은 그대로, 줄 끝만 바뀐다).`);
    }
  }
}

const agentsFile = path.join(ROOT, 'AGENTS.md');
const rowKey = (r) => r.split('|')[1].trim().replace(/\s+/g, '');
// 같은 항목(team의 커밋 등)은 뒤 묶음 행이 앞 묶음 행을 대신한다(자리는 앞 행 자리)
const rows = [...new Map([`| 문서 수준 | ${level} |`, ...dirs.flatMap((d) => (fs.existsSync(path.join(d.dir, 'values.md')) ? read(path.join(d.dir, 'values.md')).split('\n') : [])
  .filter((l) => l.startsWith('|')))].map((r) => [rowKey(r), r])).values()];
// "값" 절(## 값, ### 값, ## 값 (설명))의 첫 표 끝에 없는 행만 더한다. 절이나 표가 없으면 만든다. 다음 같은 급 제목을 넘어가지 않는다.
// 표의 칸 수가 더 많으면 빈칸을 채우고, 표 바로 뒤에 글이 붙어 있으면 빈 줄을 넣는다(GFM은 빈 줄 전까지를 표로 읽는다).
function addValueRows(text, rows) {
  const lines = text.split('\n');
  const key = (r) => r.split('|')[1].trim().replace(/\s+/g, '');
  let at = lines.findIndex((l) => /^#{2,3}\s+값(\s|$)/.test(l));
  if (at < 0) {
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    lines.push('', '## 값', '');
    at = lines.length - 2;
  }
  const depth = lines[at].match(/^#+/)[0].length;
  let next = lines.findIndex((l, i) => i > at && new RegExp(`^#{1,${depth}}\\s`).test(l));
  if (next < 0) next = lines.length;
  let first = lines.findIndex((l, i) => i > at && i < next && l.startsWith('|'));
  if (first < 0) { lines.splice(at + 1, 0, '', '| 항목 | 값 |', '|---|---|'); first = at + 2; }
  let last = first;
  while (last + 1 < lines.length && lines[last + 1].startsWith('|')) last++;
  const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').length;
  const cols = cells(lines[first]);
  const have = new Set(lines.slice(first + 2, last + 1).map(key));
  const add = rows.filter((r) => !have.has(key(r))).map((r) => r + ' |'.repeat(Math.max(0, cols - cells(r))));
  lines.splice(last + 1, 0, ...add);
  const after = last + 1 + add.length;
  if (add.length && after < lines.length && lines[after].trim() && !lines[after].startsWith('|')) lines.splice(after, 0, '');
  return { text: lines.join('\n'), added: add.map((r) => r.split('|')[1].trim()) };
}
if (rows.length && (fs.existsSync(agentsFile) || DRY)) {
  const before = fs.existsSync(agentsFile) ? read(agentsFile) : read(scaffold.get('AGENTS.md'));
  let { text, added } = addValueRows(before, rows);
  // 값 칸만 바꾼다(설명 칸은 남긴다)
  if (levelNow && levelNow !== level) text = text.replace(LEVEL_ROW, (line, cell) => line.replace(`|${cell}|`, `| ${level} |`));
  const changed = [...(added.length ? [`${added.length}행 더함 (${added.join(', ')})`] : []),
    ...(levelNow && levelNow !== level ? [`문서 수준 ${levelNow} -> ${level}`] : [])];
  if (changed.length) act(`AGENTS.md "값" 표: ${changed.join(', ')}`, () => write('AGENTS.md', text));
  if (levelNow && levelNow !== level) note('! AGENTS.md 나머지는 그대로 두었다. "먼저 읽을 것"을 새 수준의 틀(harness-core scaffold)에 맞춰 고친다.');
  if (levelNow === 'standard' && level === 'light') note('! standard에서 light로 내렸다. docs/architecture.md와 docs/changes/는 그대로 두었다. 더 쓰지 않으면 docs/archive/로 옮긴다.');
}

// 묶음 블록(agents-block.mjs): AGENTS.md 표식 사이를 다시 쓴다. 표식이 없으면 끝에 더한다
for (const d of dirs) {
  const mod = path.join(d.dir, 'agents-block.mjs');
  if (!fs.existsSync(mod)) continue;
  const { build, upsert } = await import(pathToFileURL(mod).href);
  const { text: inner, problems } = build({ dirOf: (p) => dirs.find((x) => x.pack === p)?.dir || null });
  for (const p of problems) note(`! harness-${d.pack} 블록: ${p}`);
  const size = inner.split('\n').length;
  if (!fs.existsSync(agentsFile)) {
    note(DRY ? `(dry-run) AGENTS.md에 harness-${d.pack} 블록 더함 (${size}줄)` : `! AGENTS.md가 없어 harness-${d.pack} 블록을 넣지 못했다`);
    continue;
  }
  const before = read(agentsFile);
  const after = upsert(before, d.pack, inner);
  if (after === null) {
    note(`! AGENTS.md에 harness-${d.pack} 표식이 하나만 있다. 고치지 않았다. start와 end 표식을 맞춘 뒤 다시 돌린다.`);
    continue;
  }
  if (after !== before) act(`AGENTS.md harness-${d.pack} 블록 ${before.includes(`<!-- harness-${d.pack}:start -->`) ? '고침' : '더함'} (${size}줄)`, () => write('AGENTS.md', after));
  const total = after.replace(/\n$/, '').split('\n').length;
  if (total > 200) note(`! AGENTS.md가 ${total}줄이다. 200줄을 넘으면 커밋 전 검사가 막는다. 한 폴더에만 해당하는 규칙을 폴더 AGENTS.md로 옮긴다.`);
}

// Unity 묶음: 세션 시작 훅과 같은 판정(Unity 프로젝트 위치, pipeline 패키지 유무와 버전)을 한 번 보인다. 설치는 하지 않는다.
const unity = dirs.find((d) => d.pack === 'unity');
if (unity) {
  const r = spawnSync('python', [path.join(unity.dir, 'hooks', 'inject.py')], { input: JSON.stringify({ cwd: ROOT }), encoding: 'utf8' });
  let first = '';
  try { first = JSON.parse(r.stdout).hookSpecificOutput.additionalContext.split('\n\n')[0]; } catch { first = `[harness-unity] 확인 실패: ${r.stderr || r.stdout}`; }
  const ok = /^\[harness-unity\] Unity 프로젝트 \S.*, com\.unity\.pipeline [^:(]+\.$/.test(first);
  note(ok ? first : `! ${first}`);
  if (/^\|\s*Unity\s*프로젝트\s*\|\s*`?[^.\s|`][^|]*\|/m.test(fs.existsSync(agentsFile) ? read(agentsFile) : '')) {
    note('! Unity 프로젝트가 저장소 뿌리가 아니다. harness-unity .gitignore 줄(/Library/ 등)은 저장소 뿌리 기준이라 그 폴더 앞부분을 붙여 고친다.');
  }
}

// 3. git 훅 경로
const hooksPath = git('config', '--get', 'core.hooksPath').stdout.trim();
if (!hooksPath) act('git config core.hooksPath .githooks', () => git('config', 'core.hooksPath', '.githooks'));
else if (hooksPath !== '.githooks') note(`! core.hooksPath가 이미 ${hooksPath}다. 바꾸지 않았다. 그 훅에서 .githooks/pre-commit을 부르게 하거나 직접 정한다.`);

const hookFiles = [...new Set(dirs.flatMap((d) => walk(path.join(d.dir, 'managed')).filter((r) => r.startsWith('.githooks/') && !r.endsWith('.py'))))];
console.log(`\n끝. 커밋은 하지 않았다. 남은 일: AGENTS.md 한 줄 소개와 "값" 표를 채우고, 만든 파일을 한 커밋으로 넣는다${NEW ? '(새 프로젝트는 이것이 첫 커밋이다)' : ''}.`
  + ` 훅은 git add --chmod=+x ${hookFiles.join(' ')} 으로 넣어 다른 OS에서 클론해도 돈다. 플러그인 규칙은 새 세션부터 들어간다.`
  + (TEAM ? ' 팀원은 docs/SETUP.md만 한다(플러그인 설치 없음). 원격에 main이 아직 없을 때의 첫 push만 훅이 통과시킨다. 그 뒤로 main에는 PR로만 들어간다.' : ''));
