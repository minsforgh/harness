#!/usr/bin/env node
// unity-module 자체 테스트. 사용: node tests/run.js
// 임시 폴더에 가짜 Unity 프로젝트를 만들어 파일 결과만 본다. 에디터 컴파일은 SKILL.md 3번으로 실제 프로젝트에서 확인한다.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.resolve(__dirname, '..', 'new-module.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unity-module-test-'));
let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${ok ? '' : ' :: ' + detail}`);
}
const write = (root, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const exists = (root, rel) => fs.existsSync(path.join(root, rel));
const json = (root, rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
const run = (...a) => spawnSync('node', [SCRIPT, ...a], { encoding: 'utf8' });

const proj = path.join(tmp, 'proj');
write(proj, 'ProjectSettings/ProjectVersion.txt', 'm_EditorVersion: 6000.3.0f1\n');
write(proj, 'Packages/manifest.json', JSON.stringify({ dependencies: { 'com.unity.inputsystem': '1.0.0', 'com.unity.test-framework': '1.0.0' } }));
write(proj, 'Library/PackageCache/com.unity.inputsystem@1/InputSystem/Unity.InputSystem.asmdef', '﻿' + JSON.stringify({ name: 'Unity.InputSystem' }));
write(proj, 'Assets/Scripts/Core/Game.Core.asmdef', JSON.stringify({ name: 'Game.Core' }));
write(proj, 'Assets/Settings/Base.inputactions', JSON.stringify({ name: 'Base', maps: [{ name: 'Player' }] }));
write(tmp, 'spec-template.md', '# 시스템 스펙\r\n\r\n## 목적\r\n');

let r = run(proj, '--dir', 'Assets/POCs/Trial', '--asmdef', 'POC.Trial', '--refs', 'Unity.InputSystem', '--folders', 'Scripts,Scenes', '--dry-run');
check('dry-run은 아무것도 쓰지 않음', r.status === 0 && !exists(proj, 'Assets/POCs') && r.stdout.includes('[dry-run]'), r.stdout + r.stderr);

r = run(proj, '--dir', 'Assets/POCs/Trial', '--asmdef', 'POC.Trial', '--refs', 'Unity.InputSystem,Game.Core', '--folders', 'Scripts,Scenes', '--inputactions-from', 'Assets/Settings/Base.inputactions');
const a = exists(proj, 'Assets/POCs/Trial/POC.Trial.asmdef') ? json(proj, 'Assets/POCs/Trial/POC.Trial.asmdef') : {};
check('POC: asmdef 이름, 네임스페이스, 참조', r.status === 0 && a.name === 'POC.Trial' && a.rootNamespace === 'POC.Trial' && a.references.join() === 'Unity.InputSystem,Game.Core' && a.autoReferenced === true, r.stdout + r.stderr);
check('POC: 하위 폴더에 .gitkeep, .meta는 만들지 않음', exists(proj, 'Assets/POCs/Trial/Scripts/.gitkeep') && exists(proj, 'Assets/POCs/Trial/Scenes/.gitkeep') && !fs.readdirSync(path.join(proj, 'Assets/POCs/Trial')).some((f) => f.endsWith('.meta')));
check('POC: 입력 에셋을 복사하고 이름을 바꿈', exists(proj, 'Assets/POCs/Trial/Trial.inputactions') && json(proj, 'Assets/POCs/Trial/Trial.inputactions').name === 'Trial' && json(proj, 'Assets/POCs/Trial/Trial.inputactions').maps[0].name === 'Player');

r = run(proj, '--dir', 'Assets/POCs/Trial', '--asmdef', 'POC.Other');
check('막음: 이미 있는 폴더', r.status === 1 && r.stderr.includes('이미 있는 폴더'), r.stderr);
r = run(proj, '--dir', 'Assets/POCs/Again', '--asmdef', 'POC.Trial');
check('막음: 겹치는 asmdef 이름 (방금 만든 것 포함)', r.status === 1 && r.stderr.includes('asmdef 이름이 겹친다: POC.Trial'), r.stderr);
r = run(proj, '--dir', 'Assets/POCs/Typo', '--asmdef', 'POC.Typo', '--refs', 'Unity.InputSystm');
check('막음: 찾을 수 없는 참조', r.status === 1 && r.stderr.includes('참조를 찾을 수 없다: Unity.InputSystm') && !exists(proj, 'Assets/POCs/Typo'), r.stderr);
r = run(proj, '--dir', 'Scripts/X', '--asmdef', 'X');
check('막음: Assets 밖 폴더', r.status === 1, r.stderr);
r = run(proj, '--dir', 'Assets/X', '--asmdef', 'bad name');
check('막음: 이름 규칙', r.status === 1, r.stderr);

// kit-init 시스템 모양: 시스템 asmdef, 테스트 asmdef, 스펙
r = run(proj, '--dir', 'Assets/Scripts/Combat', '--asmdef', 'Game.Combat', '--refs', 'Game.Core', '--tests', 'Assets/Tests/EditMode/Combat', '--spec', 'docs/systems/combat.md', '--spec-from', path.join(tmp, 'spec-template.md'));
const t = exists(proj, 'Assets/Tests/EditMode/Combat/Game.Combat.Tests.asmdef') ? json(proj, 'Assets/Tests/EditMode/Combat/Game.Combat.Tests.asmdef') : {};
check('시스템: 테스트 asmdef가 에디터 전용, nunit, 테스트 러너, 본 asmdef 참조', r.status === 0 && t.name === 'Game.Combat.Tests' && t.references.includes('Game.Combat') && t.references.includes('UnityEditor.TestRunner') && t.includePlatforms.join() === 'Editor' && t.overrideReferences === true && t.precompiledReferences.join() === 'nunit.framework.dll' && t.defineConstraints.join() === 'UNITY_INCLUDE_TESTS' && t.autoReferenced === false, r.stdout + r.stderr);
check('시스템: 스펙을 템플릿에서 LF로 복사', exists(proj, 'docs/systems/combat.md') && !fs.readFileSync(path.join(proj, 'docs/systems/combat.md'), 'utf8').includes('\r'));

// 표의 시스템 줄: 시스템 하나가 Assets/<시스템> 폴더 하나(코드, prefab, 데이터, Editor asmdef, 테스트 asmdef가 그 안)
r = run(proj, '--dir', 'Assets/Shop', '--asmdef', 'Game.Shop', '--refs', 'Game.Core', '--folders', 'Scripts,Prefabs,Data', '--editor', 'Editor', '--tests', 'Assets/Shop/Tests');
const shopTests = exists(proj, 'Assets/Shop/Tests/Game.Shop.Tests.asmdef') ? json(proj, 'Assets/Shop/Tests/Game.Shop.Tests.asmdef') : {};
check('시스템 폴더 하나: 본 asmdef, Editor asmdef, 테스트 asmdef, 하위 폴더가 Assets/Shop 안',
  r.status === 0 && json(proj, 'Assets/Shop/Game.Shop.asmdef').references.join() === 'Game.Core'
  && json(proj, 'Assets/Shop/Editor/Game.Shop.Editor.asmdef').includePlatforms.join() === 'Editor'
  && shopTests.references?.includes('Game.Shop') && ['Scripts', 'Prefabs', 'Data'].every((f) => exists(proj, `Assets/Shop/${f}/.gitkeep`)), r.stdout + r.stderr);

const noTf = path.join(tmp, 'notf');
write(noTf, 'ProjectSettings/x', '');
write(noTf, 'Assets/.keep', '');
write(noTf, 'Packages/manifest.json', JSON.stringify({ dependencies: {} }));
r = run(noTf, '--dir', 'Assets/Scripts/A', '--asmdef', 'G.A', '--tests', 'Assets/Tests/EditMode/A');
check('막음: 테스트 패키지 없이 테스트 asmdef', r.status === 1 && r.stderr.includes('com.unity.test-framework') && !exists(noTf, 'Assets/Scripts/A'), r.stderr);
r = run(noTf, '--dir', 'Assets/Scripts/A', '--asmdef', 'G.A', '--refs', 'Unity.InputSystem');
check('막음: 패키지 캐시가 없으면 에디터로 열라고 안내', r.status === 1 && r.stderr.includes('Library/PackageCache가 없다'), r.stderr);
check('막음: Unity 프로젝트가 아니면 거부', run(tmp, '--dir', 'Assets/A', '--asmdef', 'A').status === 1);

// 경로 탈출, 깨진 원본, BOM 붙은 manifest
r = run(proj, '--dir', 'Assets/../../outside', '--asmdef', 'Out.Side', '--dry-run');
check('막음: Assets/로 시작해도 풀면 밖인 경로', r.status === 1 && r.stderr.includes('Assets/ 아래 경로'), r.stdout + r.stderr);
r = run(proj, '--dir', 'Assets/POCs/Esc', '--asmdef', 'POC.Esc', '--tests', 'Assets/../Esc', '--spec', '../esc.md', '--spec-from', path.join(tmp, 'spec-template.md'), '--dry-run');
check('막음: 밖으로 나가는 --tests, --spec', r.status === 1 && r.stderr.includes('--tests는 Assets/ 아래') && r.stderr.includes('--spec은 프로젝트 안'), r.stderr);
write(proj, 'Assets/Settings/Broken.inputactions', '{ 깨짐');
r = run(proj, '--dir', 'Assets/POCs/Half', '--asmdef', 'POC.Half', '--folders', 'Scripts', '--inputactions-from', 'Assets/Settings/Broken.inputactions');
check('막음: 깨진 입력 에셋 원본은 쓰기 전에 막아 반쯤 만든 모듈이 남지 않음', r.status === 1 && r.stderr.includes('입력 에셋 원본을 읽지 못했다') && !exists(proj, 'Assets/POCs/Half'), r.stdout + r.stderr);
r = run(proj, '--dir', 'Assets/POCs/Name', '--asmdef', 'POC.Name', '--inputactions-from', 'Assets/Settings/Base.inputactions', '--inputactions', '../x.inputactions', '--dry-run');
check('막음: --inputactions는 모듈 밖으로 나갈 수 없음', r.status === 1 && r.stderr.includes('모듈 안 경로'), r.stderr);

// POC 모양: 하위 폴더 경로, Editor asmdef, 모듈 안 폴더에 입력 에셋 (Arrowhead P3에서 막힌 두 가지)
r = run(proj, '--dir', 'Assets/Arr', '--asmdef', 'Arr', '--refs', 'Unity.InputSystem', '--folders', 'Art,Scripts/Core', '--editor', 'Scripts/Editor', '--inputactions-from', 'Assets/Settings/Base.inputactions', '--inputactions', 'Input/Arr.inputactions');
const ed = exists(proj, 'Assets/Arr/Scripts/Editor/Arr.Editor.asmdef') ? json(proj, 'Assets/Arr/Scripts/Editor/Arr.Editor.asmdef') : {};
check('POC: 하위 폴더 경로(Scripts/Core)에 .gitkeep', r.status === 0 && exists(proj, 'Assets/Arr/Scripts/Core/.gitkeep'), r.stdout + r.stderr);
check('POC: --editor는 그 폴더에 Editor 전용 asmdef(본 asmdef 참조, 자동 참조 끔)', ed.name === 'Arr.Editor' && ed.rootNamespace === 'Arr.Editor' && ed.references.join() === 'Arr' && ed.includePlatforms.join() === 'Editor' && ed.autoReferenced === false, JSON.stringify(ed));
check('POC: --inputactions에 모듈 안 경로(Input/<이름>)', exists(proj, 'Assets/Arr/Input/Arr.inputactions') && json(proj, 'Assets/Arr/Input/Arr.inputactions').name === 'Arr' && !exists(proj, 'Assets/Arr/Arr.inputactions'));
r = run(proj, '--dir', 'Assets/Ed', '--asmdef', 'Ed', '--folders', 'Scripts/Editor', '--dry-run');
check('막음: --folders의 Editor 폴더(런타임 asmdef 아래에서는 특별 폴더가 아님)', r.status === 1 && r.stderr.includes('특별 폴더가 아니다') && r.stderr.includes('--editor Scripts/Editor'), r.stderr);
r = run(proj, '--dir', 'Assets/Esc2', '--asmdef', 'Esc2', '--folders', '../Out', '--editor', '../../Tools', '--dry-run');
check('막음: 모듈 밖으로 나가는 --folders, --editor', r.status === 1 && r.stderr.includes('--folders는 모듈 안 폴더') && r.stderr.includes('--editor는 모듈 안 폴더'), r.stderr);
r = run(proj, '--dir', 'Assets/Arr2', '--asmdef', 'Arr2', '--editor', 'Tools', '--dry-run');
check('Editor 폴더 이름은 자유(Editor asmdef가 정함)', r.status === 0 && r.stdout.includes('Assets/Arr2/Tools/Arr2.Editor.asmdef'), r.stdout + r.stderr);
write(proj, 'Assets/Other/Dup.Editor.asmdef', JSON.stringify({ name: 'Dup.Editor' }));
r = run(proj, '--dir', 'Assets/Dup', '--asmdef', 'Dup', '--editor', 'Editor', '--dry-run');
check('막음: 겹치는 Editor asmdef 이름', r.status === 1 && r.stderr.includes('asmdef 이름이 겹친다: Dup.Editor'), r.stderr);
const bom = path.join(tmp, 'bom');
write(bom, 'ProjectSettings/x', '');
write(bom, 'Assets/.keep', '');
write(bom, 'Packages/manifest.json', '﻿' + JSON.stringify({ dependencies: {} }));
r = run(bom, '--dir', 'Assets/Scripts/B', '--asmdef', 'G.B', '--dry-run');
check('BOM이 붙은 manifest.json도 읽음', r.status === 0, r.stdout + r.stderr);

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
process.exit(fail ? 1 : 0);
