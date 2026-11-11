#!/usr/bin/env node
// 사용: node new-module.js <Unity 프로젝트> --dir <Assets/...> --asmdef <이름>
//        [--namespace <이름>] [--refs a,b] [--folders Scripts,Scenes] [--editor <모듈 안 폴더>] [--tests <Assets/...>]
//        [--spec <docs/...md> --spec-from <템플릿 md>] [--inputactions-from <원본 .inputactions> --inputactions <모듈 안 경로>]
//        [--dry-run]
// Unity 모듈(폴더, asmdef, 선택: Editor asmdef, 테스트 asmdef, 스펙 문서, 입력 에셋)을 파일로 만든다. .meta는 만들지 않는다(Unity가 만든다).
// asmdef 아래의 Editor 폴더는 특별 폴더가 아니라서(그 안 코드도 런타임 asmdef로 들어가 빌드에서 깨진다), --folders에 Editor를 주면 막고
// --editor로 그 폴더에 Editor 전용 asmdef(<이름>.Editor)를 같이 만든다.
// 만들기 전에 막는 것: 이미 있는 폴더, 프로젝트 안에서 겹치는 asmdef 이름, 찾을 수 없는 참조, 테스트 패키지 없이 테스트 asmdef,
// 프로젝트(또는 Assets) 밖으로 나가는 경로, 읽지 못하는 원본 파일. 원본은 쓰기 전에 다 읽어 반쯤 만든 모듈이 남지 않게 한다.
const fs = require('fs');
const path = require('path');

function fail(msg) {
  console.error(`[unity-module] ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') a.dry = true;
    else if (argv[i].startsWith('--')) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) fail(`값이 필요하다: ${argv[i]}`);
      a[argv[i].slice(2)] = v;
      i++;
    } else a._.push(argv[i]);
  }
  return a;
}

const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
const slash = (p) => p.replace(/\\/g, '/');
const args = parseArgs(process.argv.slice(2));
const project = args._[0] && path.resolve(args._[0]);
if (!project) fail('사용: node new-module.js <Unity 프로젝트> --dir <Assets/...> --asmdef <이름> [옵션]');
if (!fs.existsSync(path.join(project, 'Assets')) || !fs.existsSync(path.join(project, 'ProjectSettings'))) fail(`Unity 프로젝트가 아니다(Assets, ProjectSettings 없음): ${project}`);
// Assets/../.. 처럼 글자로는 Assets/로 시작해도 풀면 밖인 경로를 막는다.
const inside = (base, rel) => {
  const r = path.relative(base, path.resolve(project, rel));
  return r !== '' && !r.startsWith('..') && !path.isAbsolute(r);
};
const ASSETS = path.join(project, 'Assets');
const dir = args.dir && slash(args.dir).replace(/\/$/, '');
if (!dir || !dir.startsWith('Assets/') || !inside(ASSETS, dir)) fail('--dir는 Assets/ 아래 경로여야 한다');
const name = args.asmdef;
if (!name || !/^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)*$/.test(name)) fail('--asmdef는 점으로 잇는 영문 PascalCase 이름이다 (예: POC.BloodFront, MyGame.Combat)');
const refs = list(args.refs);
const folders = list(args.folders).map((f) => slash(f).replace(/\/$/, ''));
const editorDir = args.editor && slash(args.editor).replace(/\/$/, '');
const MODULE = path.join(project, dir);

// ---- 프로젝트의 asmdef 이름 모으기 (Assets, 내장 패키지, 받은 패키지 캐시) ----
function walkAsmdefs(root, out, depth = 0) {
  if (!fs.existsSync(root) || depth > 12) return out;
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      walkAsmdefs(p, out, depth + 1);
    } else if (e.name.endsWith('.asmdef')) {
      try {
        out.set(JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')).name, slash(path.relative(project, p)));
      } catch {
        // 읽지 못하는 asmdef는 이름 검사에서 뺀다.
      }
    }
  }
  return out;
}
const known = new Map();
walkAsmdefs(path.join(project, 'Assets'), known);
walkAsmdefs(path.join(project, 'Packages'), known);
const cache = path.join(project, 'Library', 'PackageCache');
const hasCache = fs.existsSync(cache);
walkAsmdefs(cache, known);

const manifestPath = path.join(project, 'Packages', 'manifest.json');
let manifest = {};
if (fs.existsSync(manifestPath)) {
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^﻿/, '')).dependencies || {};
  } catch (e) {
    fail(`Packages/manifest.json을 읽지 못했다: ${e.message}`);
  }
}

// ---- 막을 것 ----
const errors = [];
if (fs.existsSync(path.join(project, dir))) errors.push(`이미 있는 폴더: ${dir}`);
if (known.has(name)) errors.push(`asmdef 이름이 겹친다: ${name} (${known.get(name)})`);
const testName = `${name}.Tests`;
if (args.tests) {
  if (!slash(args.tests).startsWith('Assets/') || !inside(ASSETS, args.tests)) errors.push('--tests는 Assets/ 아래 경로여야 한다');
  if (fs.existsSync(path.join(project, args.tests))) errors.push(`이미 있는 폴더: ${args.tests}`);
  if (known.has(testName)) errors.push(`asmdef 이름이 겹친다: ${testName} (${known.get(testName)})`);
  if (!manifest['com.unity.test-framework']) errors.push('테스트 asmdef를 만들려면 Packages/manifest.json에 com.unity.test-framework가 있어야 한다');
}
for (const r of refs) {
  if (!known.has(r)) errors.push(`참조를 찾을 수 없다: ${r}${hasCache ? '' : ' (Library/PackageCache가 없다. 에디터로 한 번 열어 패키지를 받은 뒤 다시 돌린다)'}`);
}
if (args.spec && !args['spec-from']) errors.push('--spec에는 --spec-from(템플릿)이 필요하다');
if (args['spec-from'] && !fs.existsSync(args['spec-from'])) errors.push(`스펙 템플릿이 없다: ${args['spec-from']}`);
if (args.spec && !inside(project, args.spec)) errors.push(`--spec은 프로젝트 안 경로여야 한다: ${args.spec}`);
if (args.spec && fs.existsSync(path.join(project, args.spec))) errors.push(`이미 있는 스펙: ${args.spec}`);
for (const f of folders) {
  if (!inside(MODULE, `${dir}/${f}`)) errors.push(`--folders는 모듈 안 폴더여야 한다: ${f}`);
  else if (f.split('/').includes('Editor')) errors.push(`asmdef 아래의 Editor 폴더는 특별 폴더가 아니다(그 안 코드가 런타임 asmdef로 들어간다): ${f}. --folders에서 빼고 --editor ${f}로 Editor asmdef를 같이 만든다`);
}
const editorName = `${name}.Editor`;
if (editorDir) {
  if (!inside(MODULE, `${dir}/${editorDir}`)) errors.push(`--editor는 모듈 안 폴더여야 한다: ${editorDir}`);
  if (known.has(editorName)) errors.push(`asmdef 이름이 겹친다: ${editorName} (${known.get(editorName)})`);
}
const inputFile = args['inputactions-from'] && slash(args.inputactions || `${name.split('.').pop()}.inputactions`);
if (args.inputactions && (!/\.inputactions$/.test(inputFile) || !inside(MODULE, `${dir}/${inputFile}`))) errors.push(`--inputactions는 모듈 안 경로(.inputactions)다: ${args.inputactions}`);
if (args['inputactions-from'] && !fs.existsSync(path.join(project, args['inputactions-from']))) errors.push(`입력 에셋 원본이 없다: ${args['inputactions-from']}`);
// 원본은 쓰기 전에 읽는다. 쓰다가 원본에서 실패하면 asmdef만 남아 다시 돌릴 때 "이름이 겹친다"로 막힌다.
let specText = null;
let inputSrc = null;
if (!errors.length && args.spec) specText = fs.readFileSync(args['spec-from'], 'utf8').replace(/\r\n/g, '\n');
if (!errors.length && args['inputactions-from']) {
  try {
    inputSrc = JSON.parse(fs.readFileSync(path.join(project, args['inputactions-from']), 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    errors.push(`입력 에셋 원본을 읽지 못했다(JSON): ${args['inputactions-from']}: ${e.message}`);
  }
}
if (errors.length) {
  errors.forEach((e) => console.error(`[unity-module] ${e}`));
  process.exit(1);
}

// ---- 만들기 ----
const created = [];
function write(rel, text) {
  created.push(rel);
  if (args.dry) return;
  const abs = path.join(project, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}
const asmdef = (o) =>
  JSON.stringify(
    {
      name: o.name,
      rootNamespace: o.rootNamespace || '',
      references: o.references || [],
      includePlatforms: o.includePlatforms || [],
      excludePlatforms: [],
      allowUnsafeCode: false,
      overrideReferences: !!o.precompiledReferences,
      precompiledReferences: o.precompiledReferences || [],
      autoReferenced: o.autoReferenced !== false,
      defineConstraints: o.defineConstraints || [],
      versionDefines: [],
      noEngineReferences: false,
    },
    null,
    4
  ) + '\n';

write(`${dir}/${name}.asmdef`, asmdef({ name, rootNamespace: args.namespace || name, references: refs }));
// 빈 폴더는 git에 남지 않아 다른 클론에서 폴더 .meta만 남는다. .gitkeep으로 폴더를 남긴다.
for (const f of folders) write(`${dir}/${f}/.gitkeep`, '');

if (editorDir) {
  write(
    `${dir}/${editorDir}/${editorName}.asmdef`,
    asmdef({ name: editorName, rootNamespace: `${args.namespace || name}.Editor`, references: [name], includePlatforms: ['Editor'], autoReferenced: false })
  );
}

if (args.tests) {
  const t = slash(args.tests).replace(/\/$/, '');
  write(
    `${t}/${testName}.asmdef`,
    asmdef({
      name: testName,
      rootNamespace: `${args.namespace || name}.Tests`,
      references: [name, 'UnityEngine.TestRunner', 'UnityEditor.TestRunner'],
      includePlatforms: ['Editor'],
      precompiledReferences: ['nunit.framework.dll'],
      autoReferenced: false,
      defineConstraints: ['UNITY_INCLUDE_TESTS'],
    })
  );
}

if (args.spec) {
  write(slash(args.spec), specText);
}

if (args['inputactions-from']) {
  // 이름이 원본과 같으면 Unity가 두 에셋을 헷갈려 보여 준다.
  inputSrc.name = path.basename(inputFile, '.inputactions');
  write(`${dir}/${inputFile}`, JSON.stringify(inputSrc, null, 4) + '\n');
}

console.log(`${args.dry ? '[dry-run] ' : ''}[unity-module] ${created.length}개`);
created.forEach((f) => console.log(`  + ${f}`));
console.log('다음: 에디터에서 새로 고침과 컴파일 뒤 verify_module.cs로 어셈블리가 로드됐는지 본다(SKILL.md 3번). 생긴 .meta를 함께 커밋한다.');
