#!/usr/bin/env node
// _harness 시험. 사용: node _harness/tests/run.mjs
// 임시 폴더(os.tmpdir)에서만 동작한다. 실제 설정 폴더와 플러그인 설치는 건드리지 않는다(apply는 --no-plugins).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 이 PC의 기본 상태(Python 기본 인코딩 cp949)로 돌린다. PYTHONUTF8이 켜져 있으면 한글 경로 결함이 가려진다.
delete process.env.PYTHONUTF8;
const HARNESS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE = path.join(HARNESS, 'packs', 'core');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-test-'));
let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${ok ? '' : ' :: ' + String(detail).slice(0, 400)}`);
}
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });
const py = (script, input, opts = {}) => run('python', [script], { input: JSON.stringify(input), ...opts });
const hookOut = (r) => { try { return JSON.parse(r.stdout).hookSpecificOutput || {}; } catch { return {}; } };
const write = (root, rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text, 'utf8'); };
function repo(name) {
  const root = path.join(tmp, name);
  fs.mkdirSync(root, { recursive: true });
  run('git', ['init', '-q'], { cwd: root });
  run('git', ['config', 'user.email', 't@t'], { cwd: root });
  run('git', ['config', 'user.name', 't'], { cwd: root });
  run('git', ['config', 'core.autocrlf', 'false'], { cwd: root });
  return root;
}

// 1. bash_guard (harness-core)
{
  const g = path.join(CORE, 'hooks', 'bash_guard.py');
  check('bash_guard: 7500자 넘는 명령 거부', hookOut(py(g, { tool_input: { command: 'echo ' + 'x'.repeat(8000) } })).permissionDecision === 'deny');
  const hd = hookOut(py(g, { tool_input: { command: "python - <<'EOF'\nprint('a\\\\b')\nEOF" } }));
  check('bash_guard: 백슬래시 있는 heredoc 스크립트에 알림', /백슬래시/.test(hd.additionalContext || ''));
  check('bash_guard: 백슬래시 없는 heredoc은 조용', py(g, { tool_input: { command: "python - <<'EOF'\nprint(1)\nEOF" } }).stdout.trim() === '');
  check('bash_guard: cat, grep은 경고하지 않음', py(g, { tool_input: { command: 'cat a.txt && grep -n x b.md' } }).stdout.trim() === '');
  // 훅 셋: JSON이 아닌 입력에도 트레이스백 없이 조용히 끝난다
  const bad = (script) => { const r = run('python', [script], { input: 'not json' }); return r.status === 0 && !r.stdout.trim() && !/Traceback/.test(r.stderr); };
  check('훅: JSON이 아닌 입력에 조용히 끝남(bash_guard, guard_source, korean_reply)',
    bad(g) && bad(path.join(HARNESS, 'user', 'hooks', 'guard_source.py')) && bad(path.join(HARNESS, 'user', 'hooks', 'korean_reply.py')));
}

// 2. guard_source (harness-user)
{
  const g = path.join(HARNESS, 'user', 'hooks', 'guard_source.py');
  const wiki = path.join(tmp, 'wiki');
  write(wiki, '_harness/.claude-plugin/marketplace.json', '{}');
  write(wiki, '_harness/packs/core/rules.md', 'x');
  const proj = path.join(tmp, 'proj-outside');
  fs.mkdirSync(proj, { recursive: true });
  const ask = (file, cwd) => hookOut(py(g, { cwd, tool_input: { file_path: path.join(wiki, file) } })).permissionDecision;
  check('guard_source: 프로젝트 세션이 _harness를 고치면 묻는다', ask('_harness/packs/core/rules.md', proj) === 'ask');
  check('guard_source: _skills도 묻는다', ask('_skills/poc/SKILL.md', proj) === 'ask');
  check('guard_source: dev-wiki 세션이면 묻지 않는다', ask('_harness/packs/core/rules.md', wiki) === undefined);
  check('guard_source: 위키 문서는 묻지 않는다', ask('언리얼/어떤 문서.md', proj) === undefined);
  check('guard_source: dev-wiki 밖 파일은 묻지 않는다',
    hookOut(py(g, { cwd: proj, tool_input: { file_path: path.join(proj, '_harness', 'x.md') } })).permissionDecision === undefined);
  // 한글 경로 git 저장소 세션: git 출력을 cp949로 읽다 죽으면 묻지 않고 통과됐다
  const korean = repo('한글 프로젝트');
  const kr = py(g, { cwd: korean, tool_input: { file_path: path.join(wiki, '_harness/packs/core/rules.md') } });
  check('guard_source: 한글 경로 프로젝트 세션도 묻는다', hookOut(kr).permissionDecision === 'ask', kr.stderr);
  check('guard_source: 없는 cwd면 묻는다', ask('_harness/packs/core/rules.md', path.join(tmp, '없는 폴더')) === 'ask');
}

// 2-1. korean_reply (harness-user)
{
  const k = path.join(HARNESS, 'user', 'hooks', 'korean_reply.py');
  const decide = (text) => { try { return JSON.parse(py(k, { last_assistant_message: text }).stdout).decision; } catch { return undefined; } };
  check('korean_reply: 영어 답은 돌려보낸다',
    decide('The rename is finished and every test passed, so the plugins are ready for the next session.') === 'block');
  check('korean_reply: 한국어 답은 통과', decide('이름 바꾸기를 마쳤고 시험이 모두 통과했다. 새 세션부터 적용된다.') === undefined);
  check('korean_reply: 식별자만 적은 답은 통과',
    decide('- harness-user:grilling\n- harness-user:harness-apply\n- harness-user:skill-make\n- korean_reply.py v0.1.1') === undefined);
}

// 2-2. wiki_candidates (harness-user Stop 훅): `wiki 후보:` 줄만 이 PC의 대기열에 모은다
{
  const w = path.join(HARNESS, 'user', 'hooks', 'wiki_candidates.py');
  const q = path.join(tmp, 'wiki-queue', 'q.jsonl');
  const env = { ...process.env, HARNESS_WIKI_QUEUE: q };
  const proj = repo('후보 프로젝트');
  const stop = (msg, cwd = proj, extra = {}) => py(w, { cwd, session_id: 's1', last_assistant_message: msg }, { env: { ...env, ...extra } });
  const rows = () => (fs.existsSync(q) ? fs.readFileSync(q, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const r0 = stop('작업을 마쳤다.\n\nwiki 후보: Unity 6 TextMesh는 OS 글꼴을 동적으로 못 쓴다\n- **wiki 후보**: 폴더 .meta add/add는 main 쪽을 고른다');
  const got = rows();
  check('wiki_candidates: 후보 줄 둘을 프로젝트 경로와 함께 모음(굵게 표시도)',
    r0.status === 0 && !r0.stdout.trim() && got.length === 2 && got[0].text.startsWith('Unity 6 TextMesh') && got[1].text === '폴더 .meta add/add는 main 쪽을 고른다'
    && path.resolve(got[0].project) === path.resolve(proj) && got[0].session === 's1', JSON.stringify(got) + r0.stderr);
  stop('다시: wiki 후보: Unity 6 TextMesh는 OS 글꼴을 동적으로 못 쓴다');
  stop('wiki 후보: Unity 6 TextMesh는 OS 글꼴을 동적으로 못 쓴다');
  stop('후보 없는 답이다.');
  check('wiki_candidates: 같은 프로젝트의 같은 글은 한 번, 줄 첫머리가 아니면 무시, 후보 없으면 그대로', rows().length === 2, JSON.stringify(rows()));
  const wiki = path.join(tmp, 'wiki-for-candidates');
  write(wiki, '_harness/.claude-plugin/marketplace.json', '{}');
  stop('wiki 후보: dev-wiki 세션의 후보', wiki);
  stop('wiki 후보: 끈 상태의 후보', proj, { HARNESS_WIKI_CANDIDATES: '0' });
  check('wiki_candidates: dev-wiki 세션과 끈 상태는 모으지 않음', rows().length === 2, JSON.stringify(rows()));
  const bad = run('python', [w], { input: 'not json', env });
  check('wiki_candidates: JSON이 아닌 입력에 조용히 끝남', bad.status === 0 && !bad.stdout.trim() && !/Traceback/.test(bad.stderr));
  const hooks = JSON.parse(fs.readFileSync(path.join(HARNESS, 'user', 'hooks', 'hooks.json'), 'utf8'));
  check('wiki_candidates: Stop 훅에 등록', JSON.stringify(hooks.hooks.Stop).includes('wiki_candidates.py'));
  const ins = fs.readFileSync(path.join(HARNESS, 'user', 'instructions.md'), 'utf8');
  check('전역 지시: 환류 줄은 대화 보고에만(저장소 파일에는 안 씀)', ins.includes('`wiki 후보: <한 줄>`') && ins.includes('커밋 메시지, PR, 저장소 문서에는 쓰지 않고'));
  const sources = JSON.parse(fs.readFileSync(path.join(HARNESS, 'packs', 'team', 'block.json'), 'utf8')).sources;
  check('전역 지시는 팀 블록 재료가 아님(팀원에게 안 닿음)',
    sources.length > 0 && sources.every((s) => ['core', 'unity'].includes(s.pack) && s.file !== 'instructions.md'), JSON.stringify(sources.map((s) => [s.pack, s.file])));
}

// 3. docs.py
{
  const docs = path.join(CORE, 'git', 'checks', 'docs.py');
  const root = repo('docs');
  const lines = (n, head = '# 긴 문서') => [head, ...Array.from({ length: n - 1 }, (_, i) => `줄 ${i}`)].join('\n');
  write(root, 'src/a.cs', 'line1\nline2\n');
  write(root, 'docs/retired.txt', '# 주석\n예지 | 필연\n');
  write(root, 'GLOSSARY.md', '# 용어\n\n**필연**:\n바꿀 수 없는 미래. 예언이라고 하지 않는다\n_Avoid_: 예언, prophecy\n');
  write(root, 'docs/systems/전투.md', [
    '# 전투', '[개요](../overview.md)', '`src/a.cs`와 `src/a.cs:2`는 있다', '`origin/main`은 경로가 아니다',
    '`docs/systems/<system>.md`는 자리표시', '본문 날짜 2026-11-08', 'prophecyless는 다른 낱말', '```', '`src/zzz.cs` 코드 블록 안', '```',
  ].join('\n'));
  write(root, 'docs/overview.md', [
    '# 개요', '[없는 글](없음.md)', '`src/b.cs` 없음', '`src/a.cs:9` 줄 밖', '예지를 쓴다',
    '## 보스 (2026-11-07 다시 만듦)', '예지 <!-- doc-check:ignore: 옛 이름을 설명하는 줄 -->', '예언을 쓴다', 'The Prophecy works',
    '예지 <!-- doc-check:ignore -->',
  ].join('\n'));
  write(root, 'docs/decisions.md', '<!-- doc: log -->\n# 결정\n## 2026-11-08 예지를 필연으로\n[없음](없음.md)\n');
  write(root, 'docs/archive/옛 개요.md', '# 옛 개요\n예지\n## 2026-11-05 무엇\n');
  write(root, 'docs/플레이테스트.md', '<!-- doc: log -->\n# 플레이테스트\n## 2026-11-08 예지 첫 판\n');
  write(root, 'docs/adr/README.md', '# 결정 기록\n```\n# <제목>\n- 날짜: 2026-01-01\n```\n');
  write(root, 'docs/adr/0001-first.md', '# 첫 결정\n## 2026-11-09 예지를 필연으로\n[없음](없음.md)\n');
  write(root, 'docs/adr/0001-dup.md', '# 겹침\n');
  write(root, 'docs/adr/Bad Name.md', '# 이름\n');
  write(root, 'docs/changes/2026-11-09-dash/proposal.md', '# 대시 (2026-11-09)\n예지\n[없음](없음.md)\n');
  write(root, 'docs/changes/archive/2026-10-01-old/proposal.md', '# 옛 변경\n[없음](없음.md)\n');
  write(root, 'AGENTS.md', lines(201, '# AGENTS.md'));
  write(root, 'src/combat/AGENTS.md', '# 전투 폴더 규칙\n[없음](없음.md)\n');
  write(root, 'src/ui/AGENTS.md', '# UI 폴더 규칙\n');
  write(root, 'src/ui/CLAUDE.md', '@AGENTS.md\n');
  write(root, 'docs/systems/큰.md', lines(501));
  write(root, 'docs/systems/중간.md', lines(301));
  const all = run('python', [docs, root]);
  const out = all.stdout;
  check('docs: 끊긴 링크', /\[링크\] docs\/overview.md:2/.test(out), out);
  check('docs: 없는 경로', /\[경로\] docs\/overview.md:3: src\/b.cs/.test(out), out);
  check('docs: 줄 밖 참조', /\[줄\] docs\/overview.md:4/.test(out), out);
  check('docs: 옛 형식 retired.txt의 버린 표현', /\[버린 표현\] docs\/overview.md:5: '예지' -> 필연/.test(out), out);
  check('docs: GLOSSARY _Avoid_ 한글 표현', /\[버린 표현\] docs\/overview.md:8: '예언' -> 필연/.test(out), out);
  check('docs: GLOSSARY _Avoid_ 영문 표현은 대소문자 무시', /\[버린 표현\] docs\/overview.md:9: 'prophecy'/.test(out), out);
  check('docs: 영문 표현은 낱말 단위(prophecyless는 통과)', !/docs\/systems\/전투.md:7/.test(out), out);
  check('docs: GLOSSARY.md 자신은 버린 표현을 보지 않음', !/\] GLOSSARY.md/.test(out), out);
  check('docs: 제목 날짜', /\[제목 날짜\] docs\/overview.md:6/.test(out), out);
  check('docs: 이유를 단 ignore 표시 줄은 건너뜀', !/docs\/overview.md:7/.test(out), out);
  check('docs: 이유 없는 ignore 표시는 알리고 그 줄도 검사함',
    /\[버린 표현\] docs\/overview.md:10/.test(out) && /\[무시 표시\] docs\/overview.md:10/.test(out), out);
  check('docs: 시스템 문서의 경로, 자리표시, origin/main, 코드 블록 안은 통과', !/^\[(?!알림)[^\]]+\] docs\/systems\/전투.md/m.test(out), out);
  check('docs: 기록 문서(decisions.md, archive/, 표시 문서, changes/archive)는 검사하지 않음',
    !/^\[[^\]]+\] docs\/(decisions.md|archive\/|플레이테스트.md|changes\/archive)/m.test(out), out);
  check('docs: ADR 내용은 검사하지 않음', !/^\[(링크|제목 날짜|버린 표현)\] docs\/adr/m.test(out), out);
  check('docs: ADR 번호 겹침', /\[ADR\] docs\/adr\/0001-(first|dup).md: 번호 0001/.test(out), out);
  check('docs: ADR 이름 형식', /\[ADR\] docs\/adr\/Bad Name.md/.test(out), out);
  check('docs: ADR README(형식 안내)의 코드 블록은 통과', !/docs\/adr\/README.md/.test(out), out);
  check('docs: 진행 중 문서는 링크만 막고 버린 표현과 제목 날짜는 안 봄',
    /\[링크\] docs\/changes\/2026-11-09-dash\/proposal.md:3/.test(out) && !/\[(버린 표현|제목 날짜)\] docs\/changes/.test(out), out);
  check('docs: 뿌리 AGENTS.md 200줄 넘으면 막음', /\[크기\] AGENTS.md: 201줄/.test(out), out);
  check('docs: 현재 상태 문서 500줄 넘으면 막음', /\[크기\] docs\/systems\/큰.md: 501줄/.test(out), out);
  check('docs: 300줄 넘으면 알림만', /\[알림\] docs\/systems\/중간.md: 301줄/.test(out) && !/\[크기\] docs\/systems\/중간.md/.test(out), out);
  check('docs: 폴더별 AGENTS.md도 현재 상태 문서', /\[링크\] src\/combat\/AGENTS.md:2/.test(out), out);
  check('docs: 폴더 AGENTS.md 옆에 CLAUDE.md(@AGENTS.md)가 없으면 막음', /\[폴더 규칙\] src\/combat\/AGENTS.md/.test(out), out);
  check('docs: CLAUDE.md가 있는 폴더 AGENTS.md는 통과', !/\[폴더 규칙\] src\/ui/.test(out), out);
  check('docs: 본문 날짜는 알림만', /\[알림\] docs\/systems\/전투.md: 본문에 날짜 1곳/.test(out), out);
  check('docs: 문제가 있으면 종료 코드 1', all.status === 1);

  run('git', ['add', 'docs/systems/전투.md', 'src/a.cs'], { cwd: root });
  const st = run('python', [docs, '--staged', root]);
  check('docs --staged: 한글 경로 문서도 보고, 커밋에 안 든 문서와 ADR 문제는 안 보고, 작업 트리에만 있는 링크 대상은 막음',
    st.status === 1 && /\[알림\] docs\/systems\/전투.md/.test(st.stdout) && /\[링크\] docs\/systems\/전투.md:2: \.\.\/overview.md는 작업 트리에만/.test(st.stdout)
    && !/docs\/overview.md:\d|\[ADR\]/.test(st.stdout), st.stdout);
  run('git', ['reset', '-q'], { cwd: root });

  // 문서 수준 light: 링크, 경로, 줄만 막고 나머지는 알림
  const lite = repo('docs-light');
  write(lite, 'AGENTS.md', '# AGENTS.md\n\n## 값\n\n| 항목 | 값 |\n|---|---|\n| 문서 수준 | light |\n');
  write(lite, 'GLOSSARY.md', '**필연**:\n정의\n_Avoid_: 예언\n');
  write(lite, 'docs/overview.md', ['# 개요', '## 보스 (2026-11-07)', '예언을 쓴다'].join('\n'));
  write(lite, 'docs/systems/큰.md', lines(501));
  write(lite, 'CLAUDE.md', '@AGENTS.md\n메모 한 줄\n');
  const l1 = run('python', [docs, lite]);
  check('docs light: 제목 날짜, 버린 표현, CLAUDE.md 내용은 알림으로 낮추고 크기는 막음', l1.status === 1 && /\[알림\] \[제목 날짜\]/.test(l1.stdout)
    && /\[알림\] \[버린 표현\]/.test(l1.stdout) && /\[알림\] \[CLAUDE.md\]/.test(l1.stdout) && /^\[크기\] docs\/systems\/큰.md/m.test(l1.stdout)
    && /문서 수준 light/.test(l1.stdout), l1.stdout);
  write(lite, 'docs/overview.md', '# 개요\n[없음](없음.md)\n');
  const l2 = run('python', [docs, lite]);
  check('docs light: 끊긴 링크는 막음', l2.status === 1 && /\[링크\] docs\/overview.md:2/.test(l2.stdout), l2.stdout);

  // 규칙 주입: 문서 수준에 맞는 규칙 파일을 붙인다
  const inject = path.join(CORE, 'hooks', 'inject.py');
  const ctx = (cwd) => hookOut(run('python', [inject, 'rules.md', 'docs-{docs}.md'],
    { input: JSON.stringify({ cwd }), env: { ...process.env, CLAUDE_PLUGIN_ROOT: CORE } })).additionalContext || '';
  check('inject: light 프로젝트는 rules.md + docs-light.md',
    /# 작업 규칙: harness-core/.test(ctx(lite)) && /문서 수준 light/.test(ctx(lite)) && !/문서 수준 standard\)/.test(ctx(lite)), ctx(lite));
  check('inject: 수준 값이 없으면 standard', /\(문서 수준 standard\)/.test(ctx(root)), ctx(root));

  // 수준 값 표기 흔들림
  const lv = repo('docs-level');
  write(lv, 'AGENTS.md', '# A\n\n## 값\n\n| 항목 | 값 |\n|---|---|\n| 문서수준 | `light` |\n');
  write(lv, 'docs/overview.md', '# 개요\n');
  check('docs: 수준 값의 백틱과 붙여 쓴 행 이름도 읽음', /문서 수준 light/.test(run('python', [docs, lv]).stdout));
  write(lv, 'AGENTS.md', '# A\n\n## 값\n\n| 항목 | 값 |\n|---|---|\n| 문서 수준 | lite |\n');
  const lvOut = run('python', [docs, lv]).stdout;
  check('docs: 모르는 수준 값은 standard로 보고 알림', /문서 수준 'lite'를 몰라/.test(lvOut) && /문서 수준 standard/.test(lvOut), lvOut);
  check('inject: 모르는 수준 값은 알리고 standard 규칙', /문서 수준 'lite'를 몰라/.test(ctx(lv)) && /\(문서 수준 standard\)/.test(ctx(lv)), ctx(lv));

  // 한글 경로 저장소: git 출력을 utf-8로 읽어야 수준을 찾는다
  const ko = repo('한글 프로젝트');
  write(ko, 'AGENTS.md', '# AGENTS.md\n\n## 값\n\n| 항목 | 값 |\n|---|---|\n| 문서 수준 | light |\n');
  fs.mkdirSync(path.join(ko, 'sub'), { recursive: true });
  check('inject: 한글 경로 저장소의 하위 폴더에서도 수준을 읽음', /문서 수준 light/.test(ctx(path.join(ko, 'sub'))), ctx(path.join(ko, 'sub')));

  // 두 검토에서 나온 거짓 양성과 거짓 음성
  const fp = repo('docs-fp');
  write(fp, 'AGENTS.md', '# AGENTS.md\n');
  write(fp, 'src/a.cs', '1\n2\n3\n');
  write(fp, 'src/dash/Dash.cs', 'x\n');
  write(fp, 'docs/옛 개요.md', '# 옛\n');
  write(fp, 'docs/changes/2026-11-09-dash/proposal.md', '# 대시\n');
  write(fp, 'GLOSSARY.md', '# 용어\n\n**돌진**:\n짧게 빠르게 움직임\n_Avoid_: 대시, dash\n\n**대시 쿨다운**:\n돌진 뒤 기다리는 시간\n\n**예언**:\n미래\n_Avoid_: prophecy.\n');
  write(fp, 'docs/systems/fp.md', [
    '# 거짓 양성', '범위 `src/a.cs:1-3`, 줄과 열 `src/a.cs:2:5`, GitHub식 `src/a.cs#L2`',
    '공백 링크 [옛](../옛%20개요.md), 뿌리 기준 [옛](/docs/옛%20개요.md)', '대시 쿨다운은 정의된 용어다', '코드 경로 `src/dash/Dash.cs`',
    '인라인 코드 안 링크 문법 `[x](없음.md)`', '> ```cs', '> var p = `src/zzz.cs`;', '> ```',
    '## 변경 `docs/changes/2026-11-09-dash/`', '````md', '```', '`src/none.cs`', '```', '````',
  ].join('\n'));
  write(fp, 'docs/systems/fn.md', ['# 거짓 음성', 'prophecy는 여전히 쓴다', '범위 밖 `src/a.cs:2-9`', '```', '열고 닫지 않은 울타리',
    '[없음](없음.md)', '## 보스 (2026-11-07)'].join('\n'));
  const f1 = run('python', [docs, fp]).stdout;
  check('docs: 줄 범위, 줄과 열, #L, %20 링크, 뿌리 기준 링크, 정식 용어 안의 버린 말, 인라인 코드, 인용 안 울타리, 중첩 울타리는 통과',
    !/^\[(?!알림)[^\]]+\] docs\/systems\/fp.md/m.test(f1), f1);
  check('docs: 끝 문장부호가 붙은 _Avoid_ 말도 잡음', /\[버린 표현\] docs\/systems\/fn.md:2: 'prophecy'/.test(f1), f1);
  check('docs: 줄 범위의 끝 줄이 파일 밖이면 막음', /\[줄\] docs\/systems\/fn.md:3: src\/a.cs:2-9/.test(f1), f1);
  check('docs: 닫히지 않은 울타리 뒤도 검사', /\[링크\] docs\/systems\/fn.md:6/.test(f1) && /\[제목 날짜\] docs\/systems\/fn.md:7/.test(f1), f1);

  // 크기, 기록 표시, BOM, CLAUDE.md, 진행 중과 기록 문서 알림
  const sz = repo('docs-size');
  write(sz, 'AGENTS.md', '# AGENTS.md\n');
  write(sz, 'CLAUDE.md', '@AGENTS.md\n\n# 메모\n- 빌드는 npm run build\n');
  write(sz, 'docs/playtest.md', '﻿<!-- doc: log -->\n# 플레이테스트\n## 2026-11-08 첫 판\n');
  write(sz, 'docs/overview.md', '<!-- doc: log -->\n' + lines(700, '# 개요'));
  write(sz, 'docs/systems/긴줄.md', '# 긴 줄\n' + 'x'.repeat(41000) + '\n');
  write(sz, 'src/big/AGENTS.md', lines(150, '# 큰 폴더') + '\n' + '나'.repeat(11500) + '\n');
  write(sz, 'src/big/CLAUDE.md', '@AGENTS.md\n');
  write(sz, 'src/wide/AGENTS.md', lines(201, '# 넓은 폴더'));
  write(sz, 'src/wide/CLAUDE.md', '@AGENTS.md\n');
  write(sz, 'docs/archive/AGENTS.md', '# 옛 폴더 규칙\n');
  write(sz, 'docs/changes/2026-11-09-big/proposal.md', lines(301, '# 큰 제안'));
  write(sz, 'docs/changes/2026-11-09-big/tasks.md', '# 할 일\n- [x] 하나\n- [x] 둘\n');
  write(sz, 'docs/adr/0001-long.md', lines(201, '# 긴 결정'));
  write(sz, 'docs/adr/images/diagram.md', '# 그림 설명\n');
  write(sz, 'docs/log.md', '<!-- doc: log -->\n' + lines(1001, '# 일지'));
  const s1 = run('python', [docs, sz]).stdout;
  check('docs: BOM 붙은 기록 표시 문서는 기록', !/playtest/.test(s1), s1);
  check('docs: 현재 상태 문서 자리의 기록 표시는 막고 그대로 검사', /\[기록 표시\] docs\/overview.md/.test(s1) && /\[크기\] docs\/overview.md: 701줄/.test(s1), s1);
  check('docs: 4만 자 넘는 현재 상태 문서는 막음', /\[크기\] docs\/systems\/긴줄.md: \d+자/.test(s1), s1);
  check('docs: 뿌리부터 폴더까지 AGENTS.md 합계 32 KiB 넘으면 막음', /\[크기\] src\/big\/AGENTS.md: 뿌리부터/.test(s1), s1);
  check('docs: 폴더 AGENTS.md도 200줄, 폴더용 안내', /\[크기\] src\/wide\/AGENTS.md: 201줄 \(한도 200\)\. 더 아래 폴더/.test(s1), s1);
  check('docs: 기록 폴더 안 AGENTS.md는 폴더 규칙을 보지 않음', !/docs\/archive\/AGENTS.md/.test(s1), s1);
  check('docs: 진행 중 문서 300줄, ADR 200줄, 기록 1000줄은 알림', /\[알림\] docs\/changes\/2026-11-09-big\/proposal.md: 301줄/.test(s1)
    && /\[알림\] docs\/adr\/0001-long.md: 201줄/.test(s1) && /\[알림\] docs\/log.md: 1002줄/.test(s1), s1);
  check('docs: tasks.md 할 일이 다 끝나면 archive 알림', /\[알림\] \[변경 끝남\] docs\/changes\/2026-11-09-big/.test(s1), s1);
  check('docs: ADR 하위 폴더 파일은 이름 규칙을 보지 않음', !/docs\/adr\/images/.test(s1), s1);
  check('docs: CLAUDE.md의 @ 줄 밖 내용은 standard에서 막음', /^\[CLAUDE.md\] CLAUDE.md: @ 줄 밖에 1줄/m.test(s1), s1);

  // --staged는 인덱스를 본다
  const sg = repo('docs-staged');
  const valueTable = (lvl) => `# AGENTS.md\n\n## 값\n\n| 항목 | 값 |\n|---|---|\n| 문서 수준 | ${lvl} |\n`;
  write(sg, 'AGENTS.md', valueTable('standard'));
  write(sg, 'src/Player.cs', 'x\n');
  write(sg, 'src/move/Move.cs', 'x\n');
  write(sg, 'docs/systems/move.md', '# 이동\n\n- 폴더: `src/move/`\n');
  write(sg, 'docs/overview.md', '# 개요\n[이동](systems/move.md)\n`src/Player.cs`\n');
  write(sg, 'docs/adr/0001-a.md', '# a\n');
  run('git', ['add', '-A'], { cwd: sg });
  run('git', ['commit', '-q', '-m', 'init'], { cwd: sg });
  const stg = () => run('python', [docs, '--staged', sg]);
  const clean = () => { run('git', ['reset', '-q', '--hard'], { cwd: sg }); run('git', ['clean', '-qfd'], { cwd: sg }); };
  write(sg, 'AGENTS.md', valueTable('light'));
  write(sg, 'docs/systems/move.md', '# 이동\n\n- 폴더: `src/move/`\n## 대시 (2026-11-09)\n');
  run('git', ['add', 'docs/systems/move.md'], { cwd: sg });
  const g1 = stg();
  check('docs --staged: 수준은 작업 트리가 아니라 인덱스의 AGENTS.md에서 읽음',
    g1.status === 1 && /\[제목 날짜\] docs\/systems\/move.md/.test(g1.stdout) && /문서 수준 standard/.test(g1.stdout), g1.stdout);
  clean();
  write(sg, 'docs/adr/0001-draft.md', '# 초안\n');
  write(sg, 'docs/systems/new.md', '# 새\n');
  write(sg, 'docs/overview.md', '# 개요\n[이동](systems/move.md)\n`src/Player.cs`\n[새](systems/new.md)\n');
  write(sg, 'docs/adr/0002-b.md', '# b\n');
  run('git', ['add', 'docs/overview.md', 'docs/adr/0002-b.md'], { cwd: sg });
  const g2 = stg();
  check('docs --staged: 스테이지 안 한 ADR 초안은 번호 겹침으로 막지 않음', !/0001-draft/.test(g2.stdout), g2.stdout);
  check('docs --staged: 링크 대상이 작업 트리에만 있으면 막음', g2.status === 1 && /\[링크\] docs\/overview.md:4: systems\/new.md는 작업 트리에만/.test(g2.stdout), g2.stdout);
  clean();
  run('git', ['rm', '-q', 'docs/systems/move.md'], { cwd: sg });
  run('git', ['mv', 'src/Player.cs', 'src/Hero.cs'], { cwd: sg });
  const g3 = stg();
  check('docs --staged: 링크 대상 문서를 지우거나 참조된 파일 이름을 바꾸면 다른 문서도 다시 봄',
    g3.status === 1 && /\[링크\] docs\/overview.md:2/.test(g3.stdout) && /\[경로\] docs\/overview.md:3: src\/Player.cs/.test(g3.stdout), g3.stdout);
  clean();
  write(sg, 'src/move/Move.cs', 'y\n');
  run('git', ['add', 'src/move/Move.cs'], { cwd: sg });
  const g4 = stg();
  check('docs --staged: 시스템 폴더 코드를 바꾼 커밋에 그 문서가 없으면 알림(막지 않음)',
    g4.status === 0 && /\[알림\] \[시스템 문서\] src\/move\/ 아래 1개 파일/.test(g4.stdout), g4.stdout);
  write(sg, 'docs/systems/move.md', '# 이동\n\n- 폴더: `src/move/`\n바뀐 동작\n');
  run('git', ['add', 'docs/systems/move.md'], { cwd: sg });
  const g4b = stg();
  check('docs --staged: 시스템 문서를 같이 고치면 알림 없음', g4b.status === 0 && !/시스템 문서/.test(g4b.stdout), g4b.stdout);
  clean();
  // Windows 디스크는 대소문자를 가리지 않아 그대로 통과하지만 Linux 클론에서는 끊긴다
  write(sg, 'docs/overview.md', '# 개요\n[이동](Systems/Move.md)\n`src/player.cs`\n');
  run('git', ['add', 'docs/overview.md'], { cwd: sg });
  const gc = stg();
  check('docs --staged: 링크와 경로의 대소문자가 git의 실제 이름과 다르면 막음',
    gc.status === 1 && /\[링크\] docs\/overview.md:2: Systems\/Move.md의 대소문자가 실제 이름 docs\/systems\/move.md/.test(gc.stdout)
      && /\[경로\] docs\/overview.md:3: src\/player.cs의 대소문자가 실제 이름 src\/Player.cs/.test(gc.stdout), gc.stdout);
  clean();
  write(sg, 'src/move/AGENTS.md', '# 이동 폴더\n');
  write(sg, 'src/move/CLAUDE.md', '@AGENTS.md\n');
  run('git', ['add', 'src/move/AGENTS.md'], { cwd: sg });
  const g5 = stg();
  check('docs --staged: 폴더 AGENTS.md 옆 CLAUDE.md가 작업 트리에만 있으면 막음',
    g5.status === 1 && /\[폴더 규칙\] src\/move\/AGENTS.md: 옆의 CLAUDE.md가 작업 트리에만/.test(g5.stdout), g5.stdout);
  clean();
  fs.writeFileSync(path.join(sg, 'docs', 'cp949.md'), Buffer.from([0x23, 0x20, 0xb0, 0xa1, 0x0a]));
  run('git', ['add', 'docs/cp949.md'], { cwd: sg });
  const g6 = stg();
  check('docs --staged: UTF-8이 아닌 문서도 죽지 않고 알림', g6.status === 0 && /\[알림\] \[인코딩\] docs\/cp949.md/.test(g6.stdout), g6.stdout + g6.stderr);
  clean();
}

// 3-1. harness-unity: 세션 시작 훅(규칙 + pipeline 패키지 알림), 매니페스트, unity-module 파일 시험
{
  const UNITY = path.join(HARNESS, 'packs', 'unity');
  const inj = path.join(UNITY, 'hooks', 'inject.py');
  const ctx = (cwd) => hookOut(py(inj, { cwd })).additionalContext || '';
  const u = repo('unity-inject');
  const manifest = (dir, v) => write(dir, 'Packages/manifest.json', JSON.stringify({ dependencies: v ? { 'com.unity.pipeline': v } : {} }));
  check('unity inject: Unity 프로젝트가 없으면 찾지 못했다고 알리고 규칙은 넣음',
    /찾지 못했다/.test(ctx(u)) && /# 작업 규칙: harness-unity/.test(ctx(u)), ctx(u));
  manifest(u, null);
  check('unity inject: pipeline 패키지가 없으면 install을 묻게 함', /패키지가 없다[\s\S]*unity pipeline install/.test(ctx(u)), ctx(u));
  manifest(u, '0.9.1-exp.1');
  check('unity inject: 0.10 아래면 save_path와 eval_file을 알림', /0\.9\.1-exp\.1: 0\.10 아래다[\s\S]*save_path[\s\S]*eval_file/.test(ctx(u)), ctx(u));
  manifest(u, '0.10.0-exp.1');
  const ok = ctx(u).split('\n\n')[0];
  check('unity inject: 0.10 이상이면 경로와 버전 한 줄', ok === `[harness-unity] Unity 프로젝트 ${path.resolve(u)}, com.unity.pipeline 0.10.0-exp.1.`, ok);
  write(u, 'AGENTS.md', '# A\n\n## 값\n\n| 항목 | 값 |\n|---|---|\n| Unity 프로젝트 | `Game` |\n');
  manifest(path.join(u, 'Game'), '0.10.0-exp.1');
  check('unity inject: "값" 표의 Unity 프로젝트 행(하위 폴더)을 따름', ctx(u).includes(`Unity 프로젝트 ${path.join(path.resolve(u), 'Game')},`), ctx(u));
  // 규칙의 <harness-unity>는 플러그인 경로로 바뀌고, 가리키는 파일이 실제로 있어야 한다(스킬 없이 이 경로로 부른다).
  const fakeRoot = path.join(tmp, 'unity-plugin-root');
  fs.cpSync(UNITY, fakeRoot, { recursive: true });
  const injected = hookOut(py(path.join(fakeRoot, 'hooks', 'inject.py'), { cwd: u }, { env: { ...process.env, CLAUDE_PLUGIN_ROOT: fakeRoot } })).additionalContext || '';
  const slashRoot = fakeRoot.replace(/\\/g, '/');
  check('unity inject: <harness-unity>를 설치본 경로로 바꿈',
    !injected.includes('<harness-unity>') && injected.includes(`${slashRoot}/agent-scripts/TestInput.cs`) && injected.includes(`${slashRoot}/agent-scripts/State.cs`), injected);
  const named = [...new Set([...fs.readFileSync(path.join(UNITY, 'rules.md'), 'utf8').matchAll(/<harness-unity>\/([^`\s)]+)/g)].map((m) => m[1]))];
  check('unity rules: <harness-unity>/ 경로가 모두 있는 파일', named.length >= 3 && named.every((rel) => fs.existsSync(path.join(UNITY, rel))), named.join(', '));
  for (const rel of ['.claude-plugin/plugin.json', 'hooks/hooks.json', 'plugins.json', 'agent-scripts/AgentCommands.asmdef']) {
    let parsed = false;
    try { JSON.parse(fs.readFileSync(path.join(UNITY, rel), 'utf8')); parsed = true; } catch { /* 실패 */ }
    check(`unity: ${rel}은 올바른 JSON`, parsed);
  }
  const market = JSON.parse(fs.readFileSync(path.join(HARNESS, '.claude-plugin', 'marketplace.json'), 'utf8'));
  check('unity: 마켓플레이스에 harness-unity', market.plugins.some((p) => p.name === 'harness-unity' && p.source === './packs/unity'));
  const mod = run('node', [path.join(UNITY, 'skills', 'unity-module', 'tests', 'run.js')]);
  check('unity-module: 파일 시험 통과', mod.status === 0, mod.stdout + mod.stderr);

  // runtime_build (harness-unity 커밋 전 검사): 이번 커밋에 더한 줄만, 이유 표시면 통과, Editor/Tests 밖만, 한글 경로
  const rb = path.join(UNITY, 'git', 'checks', 'runtime_build.py');
  const rr = repo('런타임 조립');
  const rg = (...a) => run('git', a, { cwd: rr });
  const A = 'Assets/게임/Scripts/A.cs';
  const head = 'class A {\n  void Old() { var o = new GameObject("Old"); }\n';
  write(rr, A, head + '}\n');
  rg('add', '-A'); rg('commit', '-q', '-m', 'init');
  const staged = (body, extra = {}) => {
    write(rr, A, head + body + '}\n');
    for (const [rel, text] of Object.entries(extra)) write(rr, rel, text);
    rg('add', '-A');
    const r = run('python', [rb, '--staged', rr], { cwd: rr });
    rg('reset', '-q', '--hard'); rg('clean', '-fdq');
    return r;
  };
  const r1 = staged('  void New() { gameObject.AddComponent<B>(); }\n');
  check('runtime_build: 새로 더한 AddComponent 줄을 막음(옛 줄은 안 봄, 한글 경로)',
    r1.status === 1 && r1.stdout.includes(`${A}:3: AddComponent`) && !r1.stdout.includes(`${A}:2`), r1.stdout + r1.stderr);
  const r2 = staged('  void New() { gameObject.AddComponent<B>(); } // harness:runtime-ok: 풀에서 꺼낸 오브젝트에 붙인다\n');
  check('runtime_build: 이유 표시가 있으면 통과', r2.status === 0 && !r2.stdout.trim(), r2.stdout + r2.stderr);
  const r3 = staged('  void New() { gameObject.AddComponent<B>(); } // harness:runtime-ok:\n');
  check('runtime_build: 이유 없는 표시는 막음', r3.status === 1 && /표시에 이유가 없다/.test(r3.stdout), r3.stdout);
  const r4 = staged('  // new GameObject("주석")\n  string s = "new GameObject(";\n', {
    'Assets/게임/Scripts/Editor/Tool.cs': 'class T { void M() { new GameObject("E").AddComponent<X>(); } }\n',
    'Assets/게임/Tests/T.cs': 'class U { void M() { new GameObject("T"); } }\n',
  });
  check('runtime_build: 주석, 문자열, Editor와 Tests 폴더는 보지 않음', r4.status === 0 && !r4.stdout.trim(), r4.stdout + r4.stderr);
  const r5 = staged('  Sprite S() { var t = new Texture2D(4, 4); return Sprite.Create(t, default, default); }\n');
  check('runtime_build: 코드로 그리는 그림(new Texture2D, Sprite.Create)도 막음',
    r5.status === 1 && /A\.cs:3: .*new Texture2D/.test(r5.stdout) && /A\.cs:3: .*Sprite\.Create/.test(r5.stdout), r5.stdout);
  const all = run('python', [rb, rr], { cwd: rr });
  check('runtime_build: --staged가 없으면 옛 줄도 알림만(막지 않음)', all.status === 0 && all.stdout.includes(`[알림] [런타임 조립] ${A}:2: new GameObject`), all.stdout + all.stderr);
  write(rr, '.git/MERGE_HEAD', rg('rev-parse', 'HEAD').stdout);
  const r6 = staged('  void New() { new GameObject("merge"); }\n');
  fs.rmSync(path.join(rr, '.git', 'MERGE_HEAD'), { force: true });
  check('runtime_build: merge 중에는 건너뜀(들어온 줄은 만든 커밋에서 검사함)', r6.status === 0, r6.stdout);
  const ur = fs.readFileSync(path.join(UNITY, 'rules.md'), 'utf8');
  check('unity rules: prefab과 씬에 두기, 이유 표시, 조정 지도 줄',
    ur.includes('`// harness:runtime-ok: 이유`') && ur.includes('prefab과 씬에 둔다') && ur.includes('`docs/tuning.md`(조정 지도)'));
  check('unity rules: 컴파일은 recompile로, 창 클릭은 정한 경우에만',
    ur.includes('컴파일은 `unity recompile`로 부른다') && ur.includes('사람에게 창 클릭을 부탁하는 것은'));
  // Arrowhead 콘솔 오류 두 개(빈 참조가 Awake와 OnDisable로 번짐, 편집 모드 확인만 해서 놓침)와 일반 Unity 주의점(Q176)
  const ur6 = ['`enabled = false`로 멈춘다', 'Play에 들어가 몇 프레임 뒤 오류 0', '저장된 파일에서 다시 읽어 본다', '`AssetDatabase.LoadAssetAtPath`로 다시 불러',
    '`GetComponent`와 LINQ를 부르지 않고', '`Time.deltaTime`', '`[SerializeReference]` 없는 인터페이스', 'Player 빌드를 한 번 한다'];
  check('unity rules: 빈 참조 멈춤, Play 오류 확인, 저장 파일 다시 읽기, 매 프레임 비용, 직렬화, Player 빌드', ur6.every((k) => ur.includes(k)), ur6.filter((k) => !ur.includes(k)).join(', '));
  check('unity rules: 0.10 아래 설명은 inject가 맡는다(규칙에 eval_file, save_path 없음)', !ur.includes('eval_file') && !ur.includes('save_path'));
}

// 3-2. harness-orca: 세션 시작 훅(값이 비면 한 줄), milestone-check 판정, 스크립트 시험, apply로 값 행 넣기
{
  const ORCA = path.join(HARNESS, 'packs', 'orca');
  const inj = path.join(ORCA, 'hooks', 'inject.py');
  const mcheck = path.join(ORCA, 'skills', 'milestone-start', 'milestone-check.mjs');
  for (const rel of ['.claude-plugin/plugin.json', 'hooks/hooks.json']) {
    let parsed = false;
    try { JSON.parse(fs.readFileSync(path.join(ORCA, rel), 'utf8')); parsed = true; } catch { /* 실패 */ }
    check(`orca: ${rel}은 올바른 JSON`, parsed);
  }
  const market = JSON.parse(fs.readFileSync(path.join(HARNESS, '.claude-plugin', 'marketplace.json'), 'utf8'));
  check('orca: 마켓플레이스에 harness-orca', market.plugins.some((p) => p.name === 'harness-orca' && p.source === './packs/orca'));
  const scripts = run('node', ['--test', path.join(ORCA, 'skills', 'orchestrate', 'test')]);
  check('orca: orchestrate 스크립트 시험 통과', scripts.status === 0 && /\bfail 0\b/.test(scripts.stdout), scripts.stdout.slice(-600) + scripts.stderr);
  const { PREFLIGHT } = await import(pathToFileURL(mcheck).href);
  const skill = fs.readFileSync(path.join(ORCA, 'skills', 'milestone-start', 'SKILL.md'), 'utf8');
  check('milestone-start: 사전 점검 키가 SKILL.md K4와 판정 스크립트에서 같음',
    PREFLIGHT.every((k) => skill.includes(`- \`${k}\`:`)) && (skill.match(/^ {3}- `[a-z-]+`:/gm) || []).length === PREFLIGHT.length, PREFLIGHT.join(','));

  const VALUES = [
    '| 문서 수준 | standard |', '| 확인 명령 | `npm test` |',
    '| coordinator | 계획과 판단 claude-opus-5-5 high, 실행 루프 claude-sonnet-5-5 medium |',
    '| worker 구현 | codex:gpt-6-sol:high > claude:claude-sonnet-5-5 |',
    '| worker 잡무 | 생략: 작은 프로젝트 |',
    '| worker 리뷰 | claude:claude-sonnet-5-5:medium |',
    '| 병렬 상한 | 2 |', '| 한도 기준 | codex 85/95, claude 85 |', '| 사람 승인 지점 | 설계 고정 |',
    '| 자동 머지 조건 | 확인 명령 통과, 수정 금지 안 건드림 |', '| 수정 금지 | `.claude/` |', '| 산출물 내용 검사 | 없음 |',
  ];
  const PROPOSAL = '# 첫 판 (M1)\n\n## 왜\n\n돌아가는 첫 판\n\n## 완료 기준\n\n| id | 기준 | 확인 |\n|---|---|---|\n'
    + '| C1 | 시작 화면에 제목이 보인다 | A |\n| C2 | 문구가 사실 메모와 맞다 | R |\n\n## 승인\n\n- 계약과 대기열 승인: 2026-11-09\n';
  const TASKS = [
    { id: 'm1-a', title: 'a', role: '구현', deps: [], scope: ['src/a/'], done: 'a', verify: 'npm test', forbid: '.claude/', criteria: ['C1'] },
    { id: 'm1-b', title: 'b', role: '구현', deps: [], scope: ['src/b/'], done: 'b', verify: 'npm test', forbid: '.claude/', criteria: ['C2'] },
  ];
  const PREFLIGHT_LOG = 'PASS orca\nPASS check\nPASS base\nPASS clean\nPASS tools\nPASS codex-rules\nPASS trial codex:gpt-6-sol, claude:claude-sonnet-5-5\nSKIP parallel 켜진 묶음에 병렬 규칙 없음\n';
  const M = 'docs/changes/2026-11-09-m1';
  // 통과하는 판을 만들고 한 곳만 바꿔 본다
  let n = 0;
  const milestone = (mut = {}) => {
    const k = repo(`orca-ms-${n++}`);
    const values = mut.values ? mut.values([...VALUES]) : VALUES;
    write(k, 'AGENTS.md', mut.agents ? mut.agents(values) : `# P\n\n## 값\n\n| 항목 | 값 |\n|---|---|\n${values.join('\n')}\n`);
    write(k, `${M}/proposal.md`, mut.proposal ? mut.proposal(PROPOSAL) : PROPOSAL);
    write(k, `${M}/tasks.md`, '- [ ] m1-a\n- [ ] m1-b\n');
    write(k, `${M}/queue.json`, JSON.stringify({ milestone: 'M1', tasks: mut.tasks ? mut.tasks(structuredClone(TASKS)) : TASKS }));
    write(k, `${M}/preflight.log`, mut.preflight ?? PREFLIGHT_LOG);
    const r = run('node', [mcheck, k, ...(mut.args || [])]);
    return { root: k, status: r.status, out: r.stdout + r.stderr };
  };
  const good = milestone();
  check('milestone-check: 채운 판은 오류 0으로 통과', good.status === 0 && /^milestone-check: 오류 0, 알림 0 \(docs\/changes\/2026-11-09-m1\)$/m.test(good.out), good.out);
  check('orca inject: 값이 다 채워졌으면 아무것도 넣지 않음', py(inj, { cwd: good.root }).stdout === '');
  // 설명 칸이 있는 3칸 표: 판정과 훅이 둘째 칸을 값으로 읽는다
  const table3 = (v) => `# P\n\n## 값\n\n| 항목 | 값 | 설명 |\n|---|---|---|\n${v.map((l) => `${l} 설명 |`).join('\n')}\n\n## 다른 절\n\n| worker 구현 | <다른 표> |\n`;
  const wide = milestone({ agents: table3 });
  check('milestone-check: 설명 칸이 있는 3칸 표도 둘째 칸을 값으로 읽음', wide.status === 0, wide.out);
  check('orca inject: 3칸 표도 다 채워졌으면 조용', py(inj, { cwd: wide.root }).stdout === '');
  const arrow = milestone({ proposal: (p) => p.replace('돌아가는 첫 판', '돌아가는 첫 판 (입력 <- 저장, `<T>` 코드, 1 < 2)') });
  check('milestone-check: 화살표, 코드, 비교의 <는 자리표시로 보지 않음', arrow.status === 0, arrow.out);
  const pre = milestone({ proposal: (p) => p.replace('2026-11-09', '<YYYY-MM-DD>'), args: ['--pre-approval'] });
  check('milestone-check --pre-approval: 승인 날짜 자리표시는 알림으로 낮춤', pre.status === 0 && /WARN {2}proposal\.md: 승인 날짜 없음/.test(pre.out), pre.out);
  const bad = [
    ['병렬 상한이 수가 아님', { values: (v) => v.map((l) => l.replace('| 병렬 상한 | 2 |', '| 병렬 상한 | 많이 |')) }, /"병렬 상한"은 수로 시작한다/],
    ['생략에 이유가 없음', { values: (v) => v.map((l) => l.replace('생략: 작은 프로젝트', '생략:')) }, /"worker 잡무" 생략에 이유가 없음/],
    ['선택 역할 행이 비었음', { values: (v) => v.map((l) => l.replace('생략: 작은 프로젝트', '<같은 형식>')) }, /"worker 잡무" 비었음/],
    ['effort만 있고 model이 없음', { values: (v) => v.map((l) => l.replace('claude:claude-sonnet-5-5:medium', 'claude::medium')) }, /"worker 리뷰"/],
    ['model 이름에 :가 있음', { values: (v) => v.map((l) => l.replace('claude:claude-sonnet-5-5:medium', 'opencode:zai:glm-5:high')) }, /칸이 많다/],
    ['한도 기준을 읽지 못함', { values: (v) => v.map((l) => l.replace('codex 85/95, claude 85', '넉넉하게')) }, /"한도 기준"을 읽지 못했다/],
    ['R 기준인데 리뷰 worker가 생략', { values: (v) => v.map((l) => l.replace('claude:claude-sonnet-5-5:medium', '생략: 없음')) }, /R 기준이 있는데/],
    ['승인 날짜 없음', { proposal: (p) => p.replace('2026-11-09', '<YYYY-MM-DD>') }, /승인 날짜 없음\(K5\)/],
    ['틀의 자리표시가 남음', { proposal: (p) => p.replace('돌아가는 첫 판', '<이 마일스톤으로 풀 문제>') }, /자리표시가 남았다: <이 마일스톤으로 풀 문제>/],
    ['deps가 돈다', { tasks: (t) => { t[0].deps = ['m1-b']; t[1].deps = ['m1-a']; return t; } }, /deps가 돈다/],
    ['scope가 배열이 아님', { tasks: (t) => { t[0].scope = 'src/a/'; return t; } }, /"scope"는 글의 배열이다/],
    ['생략한 역할로 task를 보냄', { tasks: (t) => { t[1].role = '잡무'; return t; } }, /"worker 잡무" 행이 없거나 생략이다/],
    ['사전 점검 FAIL', { preflight: PREFLIGHT_LOG.replace(/PASS trial .*/, 'FAIL trial worker_done 없음') }, /사전 점검: FAIL trial worker_done 없음/],
    ['사전 점검 항목이 빠짐', { preflight: PREFLIGHT_LOG.replace('PASS base\n', '') }, /preflight\.log: base 줄이 없다/],
    ['시험 task를 생략', { preflight: PREFLIGHT_LOG.replace(/PASS trial .*/, 'SKIP trial 지난 마일스톤과 같음') }, /trial는 생략하지 않는다/],
    ['생략 이유가 없음', { preflight: PREFLIGHT_LOG.replace(/SKIP parallel .*/, 'SKIP parallel') }, /SKIP parallel에 이유가 없음/],
  ];
  for (const [name, mut, re] of bad) {
    const r = milestone(mut);
    check(`milestone-check: ${name}이면 막음`, r.status === 1 && re.test(r.out), r.out);
  }
  const once = milestone({ values: (v) => v.map((l) => l.replace('claude:claude-sonnet-5-5:medium', 'claude::medium')) });
  check('milestone-check: 같은 오류는 한 번만', (once.out.match(/"worker 리뷰" effort는/g) || []).length === 1, once.out);
  const overlap = milestone({ tasks: (t) => { t[1].scope = ['src/']; return t; } });
  check('milestone-check: 같은 경로를 동시에 건드리면 알림(오류는 아님)', overlap.status === 0 && /WARN {2}queue m1-a \/ m1-b: src\/a\/을 같이 건드리는데/.test(overlap.out), overlap.out);
  const sibling = milestone({ tasks: (t) => { t[0].scope = ['src/a']; t[1].scope = ['src/ab']; return t; } });
  check('milestone-check: src/a와 src/ab는 겹치지 않음', sibling.status === 0 && !/WARN/.test(sibling.out), sibling.out);
  const slash = milestone({ tasks: (t) => { t[0].scope = ['src\\a\\']; t[1].scope = ['src/a/x.cs']; return t; } });
  check('milestone-check: 역슬래시 경로도 겹침을 봄', /WARN {2}queue m1-a \/ m1-b:/.test(slash.out), slash.out);
  const flagged = run('node', [mcheck, good.root, '--milestone']);
  const unknown = run('node', [mcheck, good.root, '--pre-aproval']);
  check('milestone-check: 값 없는 --milestone과 모르는 옵션은 종료 코드 2', flagged.status === 2 && unknown.status === 2 && /모르는 옵션/.test(unknown.stderr), flagged.stderr + unknown.stderr);

  // apply --packs core,orca: 오케스트레이션 행을 자리표시로 넣고, 훅이 한 줄로 알리고, 판정은 막는다
  const ap = repo('orca-apply');
  const ar = run('node', [path.join(HARNESS, 'apply.mjs'), ap, '--packs', 'core,orca', '--no-plugins']);
  const apAgents = fs.readFileSync(path.join(ap, 'AGENTS.md'), 'utf8');
  check('apply core,orca: 값 표에 오케스트레이션 행 10개(자리표시)',
    ar.status === 0 && ['coordinator', 'worker 구현', 'worker 잡무', 'worker 리뷰', '병렬 상한', '한도 기준', '사람 승인 지점', '자동 머지 조건', '수정 금지', '산출물 내용 검사']
      .every((r) => new RegExp(`^\\| ${r} \\| <`, 'm').test(apAgents)), ar.stdout + ar.stderr + apAgents);
  const note = hookOut(py(inj, { cwd: ap })).additionalContext || '';
  check('orca inject: 자리표시뿐이면 빈 행과 milestone-start를 한 줄로', /^\[harness-orca\] 오케스트레이션 값이 비었다\(coordinator, worker 구현, worker 잡무, worker 리뷰, .*산출물 내용 검사\)\. .*harness-orca:milestone-start/.test(note) && !note.includes('\n'), note);
  const apCheck = run('node', [mcheck, ap]);
  check('milestone-check: apply 직후에는 값이 비었다고 막음', apCheck.status === 1 && /"coordinator" 비었음/.test(apCheck.stdout) && /마일스톤 폴더가 없다/.test(apCheck.stdout), apCheck.stdout);
  const none = hookOut(py(inj, { cwd: repo('orca-none') })).additionalContext || '';
  check('orca inject: AGENTS.md가 없어도 죽지 않고 알림', /^\[harness-orca\] 오케스트레이션 값이 비었다\(coordinator/.test(none), none);
}

// 3-3. harness-poc: 세션 시작 훅(규칙), 매니페스트, 스킬 파일, "느슨하게" 절이 대신하는 줄
{
  const POC = path.join(HARNESS, 'packs', 'poc');
  const ctx = hookOut(py(path.join(POC, 'hooks', 'inject.py'), { cwd: tmp })).additionalContext || '';
  check('poc inject: 규칙을 넣음', /^# 작업 규칙: harness-poc/.test(ctx) && /## 느슨하게 \(core, unity 규칙 대신\)/.test(ctx), ctx.slice(0, 200));
  for (const rel of ['.claude-plugin/plugin.json', 'hooks/hooks.json']) {
    let parsed = false;
    try { JSON.parse(fs.readFileSync(path.join(POC, rel), 'utf8')); parsed = true; } catch { /* 실패 */ }
    check(`poc: ${rel}은 올바른 JSON`, parsed);
  }
  const market = JSON.parse(fs.readFileSync(path.join(HARNESS, '.claude-plugin', 'marketplace.json'), 'utf8'));
  check('poc: 마켓플레이스에 harness-poc', market.plugins.some((p) => p.name === 'harness-poc' && p.source === './packs/poc'));
  const skill = fs.readFileSync(path.join(POC, 'skills', 'poc', 'SKILL.md'), 'utf8');
  check('poc 스킬: frontmatter 이름과 참고 파일', /^---\nname: poc\n/.test(skill.replace(/\r\n/g, '\n')) && fs.existsSync(path.join(POC, 'skills', 'poc', 'design-methods.md'))
    && skill.includes('design-methods.md'), skill.slice(0, 200));
  // "느슨하게" 절은 대신하는 core와 unity 규칙 줄을 이름으로 가리킨다. 그 줄이 바뀌면 이 시험이 알린다
  const rules = fs.readFileSync(path.join(POC, 'rules.md'), 'utf8');
  const core = fs.readFileSync(path.join(HARNESS, 'packs', 'core', 'rules.md'), 'utf8');
  const unity = fs.readFileSync(path.join(HARNESS, 'packs', 'unity', 'rules.md'), 'utf8');
  const loose = rules.split('## 느슨하게')[1] || '';
  check('poc rules: 느슨하게 넷(테스트 작성, 끝낼 때 확인, 플레이 확인, 시스템 문서)',
    ['테스트 작성', '끝낼 때 확인', '플레이 확인', '시스템 문서'].every((k) => loose.includes(`- ${k}:`)), loose);
  check('poc rules: 느슨하게 해도 Play 오류 확인은 남김', loose.includes('Play 오류 확인은 그대로 한다'), loose);
  check('poc rules: 대신하는 줄이 core와 unity에 아직 있음',
    /버그를 고치면\(누가 찾았든\)/.test(core) && /새 테스트는 순수 규칙 코드/.test(core) && /동작을 바꾼 커밋에는 그 시스템 문서 수정을 같이/.test(core)
    && /끝낼 때 바꾼 시스템의 EditMode 테스트/.test(unity) && /사람이 봐야 하는 확인\(조작감, 연출\)이나 입력이 닿지 않는 확인은 섞는다/.test(unity));
  for (const rel of ['docs/overview.md', 'docs/game.md', 'docs/playtest.md']) check(`poc scaffold: ${rel}`, fs.existsSync(path.join(POC, 'scaffold', 'common', rel)));
  check('poc scaffold: 플레이테스트 문서는 기록 표시', fs.readFileSync(path.join(POC, 'scaffold', 'common', 'docs', 'playtest.md'), 'utf8').startsWith('<!-- doc: log -->'));
}

// 4. apply.mjs (--no-plugins) + 연결 파일로 실제 커밋
{
  const apply = path.join(HARNESS, 'apply.mjs');
  const root = repo('apply');
  write(root, '.gitattributes', '*.png binary\n');
  const r1 = run('node', [apply, root, '--profile', 'personal', '--no-plugins']);
  check('apply: 성공', r1.status === 0, r1.stderr || r1.stdout);
  for (const rel of ['AGENTS.md', 'CLAUDE.md', 'docs/overview.md', 'docs/systems/_template.md', 'docs/adr/README.md', 'docs/changes/README.md', '.githooks/pre-commit', '.githooks/pre-merge-commit', '.githooks/harness_checks.py']) {
    check(`apply: ${rel} 만듦`, fs.existsSync(path.join(root, rel)));
  }
  check('apply: 구조 지도와 할 일 문서는 처음에 만들지 않음(생기면 만든다)',
    !fs.existsSync(path.join(root, 'docs', 'architecture.md')) && !fs.existsSync(path.join(root, 'docs', 'tasks.md')));
  const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  check('apply: 옛 문서 틀(decisions.md, retired.txt)은 만들지 않음', !fs.existsSync(path.join(root, 'docs', 'decisions.md')) && !fs.existsSync(path.join(root, 'docs', 'retired.txt')));
  const fresh = run('python', [path.join(CORE, 'git', 'checks', 'docs.py'), root]);
  check('apply: 막 만든 문서 틀은 문서 점검을 통과', fresh.status === 0 && /문제 0개/.test(fresh.stdout), fresh.stdout);
  check('apply: "값" 표에 문서 수준 standard', /\| 문서 수준 \| standard \|/.test(agents), agents);
  check('apply: "값" 표에 core 행', /\| 확인 명령 \|/.test(agents) && /\| 커밋 \|/.test(agents) && agents.indexOf('| 커밋 |') < agents.indexOf('## 이 프로젝트의 규칙'), agents);
  const ga = fs.readFileSync(path.join(root, '.gitattributes'), 'utf8');
  check('apply: .gitattributes 기존 줄 유지, 없는 줄만 더함', ga.startsWith('*.png binary\n') && /# harness-core\n\* text=auto/.test(ga), ga);
  check('apply: core.hooksPath', run('git', ['config', '--get', 'core.hooksPath'], { cwd: root }).stdout.trim() === '.githooks');
  const ov = fs.readFileSync(path.join(root, 'docs', 'overview.md'), 'utf8');
  check('apply personal: 개요 "미정"에 core 구조 결정 셋',
    /## 미정[\s\S]*\n- 의존 방식: 직접 엮기[\s\S]*\n- 남는 데이터 형식:[\s\S]*\n- 외부 계약:/.test(ov) && ov.endsWith('\n') && /"미정"에 구조 결정 3개\)/.test(r1.stdout), ov + r1.stdout);
  const r2 = run('node', [apply, root, '--profile', 'personal', '--no-plugins']);
  check('apply: 두 번째는 바꾸는 것 없음(구조 결정 알림도 없음)', !/만듦|덮어씀|더함|^! 개요가 이미/m.test(r2.stdout), r2.stdout);

  // 프로필 없이 다시 돌리면 프로젝트에 켜진 harness 묶음을 따른다(마켓플레이스 순서). 켜진 것이 없으면 personal
  const inf = repo('apply-inferred');
  write(inf, '.claude/settings.json', JSON.stringify({ enabledPlugins: { 'harness-unity@harness': true, 'harness-core@harness': true, 'harness-user@harness': true, 'other@x': true } }));
  const infR = run('node', [apply, inf, '--no-plugins']);
  check('apply: 프로필이 없으면 켜진 묶음(core, unity)으로 적용',
    /^프로필을 주지 않아 켜진 묶음\(core, unity\)으로 적용한다$/m.test(infR.stdout) && /\| Unity 프로젝트 \|/.test(fs.readFileSync(path.join(inf, 'AGENTS.md'), 'utf8')), infR.stdout);
  const infP = run('node', [apply, inf, '--profile', 'personal', '--no-plugins']);
  check('apply: 켜진 묶음이 이번 목록에 없으면 알림', /^! harness-unity가 켜져 있지만 이번 묶음 목록에 없다/m.test(infP.stdout), infP.stdout);
  check('apply: 켜진 묶음도 프로필도 없으면 personal', /^프로필을 주지 않았고 켜진 묶음도 없어 personal로 적용한다$/m.test(run('node', [apply, repo('apply-none'), '--no-plugins']).stdout));

  // unity-game: 같은 이름(의존 방식)은 unity 것이 core 것을 대신하고, Unity 항목이 더해진다
  const game = repo('apply-game');
  run('node', [apply, game, '--profile', 'unity-game', '--no-plugins']);
  const gameOv = fs.readFileSync(path.join(game, 'docs', 'overview.md'), 'utf8');
  check('apply unity-game: 의존 방식은 unity 것, 씬 구성과 화면 기준, core의 나머지 둘',
    /\n- 의존 방식: 받는 방식\(Inspector/.test(gameOv) && !/직접 엮기/.test(gameOv) && (gameOv.match(/^- 의존 방식:/gm) || []).length === 1
    && /\n- 씬 구성:/.test(gameOv) && /\n- 화면 기준:/.test(gameOv) && /\n- 남는 데이터 형식:/.test(gameOv) && /\n- 외부 계약:/.test(gameOv), gameOv);
  const gameCheck = run('python', [path.join(CORE, 'git', 'checks', 'docs.py'), game]);
  check('apply unity-game: 구조 결정이 든 개요도 문서 점검을 통과', gameCheck.status === 0 && /문제 0개/.test(gameCheck.stdout), gameCheck.stdout);
  // 개요가 이미 있으면 넣지 않고, 문서 어디에도 안 보이는 이름만 알린다
  write(game, 'docs/overview.md', '# 개요\n\n## 미정\n\n- 씬 구성: 시작 씬 하나\n');
  write(game, 'docs/adr/0001-di.md', '# 1. 의존 방식은 VContainer\n');
  const gameAgain = run('node', [apply, game, '--profile', 'unity-game', '--no-plugins']);
  check('apply: 개요가 이미 있으면 안 보이는 이름만 알림(ADR과 개요에 있는 것은 뺌)',
    /^! 개요가 이미 있어 구조 결정 목록을 넣지 않았다\. 문서에 안 보이는 것: 남는 데이터 형식, 외부 계약, 어셈블리 나누기, 화면 기준\./m.test(gameAgain.stdout)
    && fs.readFileSync(path.join(game, 'docs', 'overview.md'), 'utf8') === '# 개요\n\n## 미정\n\n- 씬 구성: 시작 씬 하나\n', gameAgain.stdout);

  // 이미 있는 AGENTS.md는 덮어쓰지 않고 "값" 표만 더한다(다음 절의 표를 건드리지 않는다).
  const old = repo('apply-old');
  write(old, 'AGENTS.md', '# 옛 규칙\n\n## 코드\n\n| 이름 | 규칙 |\n|---|---|\n| a | b |\n');
  run('node', [apply, old, '--no-plugins']);
  const oldText = fs.readFileSync(path.join(old, 'AGENTS.md'), 'utf8');
  check('apply: 옛 AGENTS.md 유지, 끝에 "값" 절 더함', oldText.startsWith('# 옛 규칙') && /## 값\n\n\| 항목 \| 값 \|\n\|---\|---\|\n\| 문서 수준 \| standard \|\n\| 확인 명령/.test(oldText) && /\| a \| b \|\n\n## 값/.test(oldText), oldText);

  // POC 프로필(light): 구조 지도와 changes 없이, 수준 값 light. 나중에 --docs standard로 올린다.
  const poc = repo('apply-poc');
  const pocFirst = run('node', [apply, poc, '--profile', 'unity-poc', '--no-plugins']);
  const pocAgents = fs.readFileSync(path.join(poc, 'AGENTS.md'), 'utf8');
  check('apply poc: 문서 수준 light, 구조 지도와 changes 없음, ADR 안내는 있음',
    /\| 문서 수준 \| light \|/.test(pocAgents) && !fs.existsSync(path.join(poc, 'docs', 'architecture.md'))
    && !fs.existsSync(path.join(poc, 'docs', 'changes')) && fs.existsSync(path.join(poc, 'docs', 'adr', 'README.md')), pocAgents);
  check('apply poc: light 개요에는 구조 결정을 넣지 않음', !/^- 의존 방식:/m.test(fs.readFileSync(path.join(poc, 'docs', 'overview.md'), 'utf8')));
  const pocCheck = run('python', [path.join(CORE, 'git', 'checks', 'docs.py'), poc]);
  check('apply poc: 막 만든 light 틀도 문서 점검을 통과', pocCheck.status === 0, pocCheck.stdout);
  const pocOv = fs.readFileSync(path.join(poc, 'docs', 'overview.md'), 'utf8');
  check('apply poc: 개요는 poc 틀(주 질문, 가장 불확실한 가정, 보고 싶은 신호, 상태 줄)',
    /^상태: 승인 전/m.test(pocOv) && /## 주 질문/.test(pocOv) && /## 가장 불확실한 가정/.test(pocOv) && /## 보고 싶은 신호/.test(pocOv) && /## 완료 기준/.test(pocOv), pocOv);
  check('apply poc: 게임 설계와 플레이테스트 기록 틀, PocId 값 행',
    fs.existsSync(path.join(poc, 'docs', 'game.md')) && fs.existsSync(path.join(poc, 'docs', 'playtest.md')) && /\| PocId \|/.test(pocAgents), pocAgents);
  const again = run('node', [apply, poc, '--no-plugins']);
  check('apply poc: 다시 돌려도 표의 light를 따른다', /문서 수준 light/.test(again.stdout) && !/만듦/.test(again.stdout), again.stdout);
  const up = run('node', [apply, poc, '--no-plugins', '--docs', 'standard']);
  const upAgents = fs.readFileSync(path.join(poc, 'AGENTS.md'), 'utf8');
  check('apply poc -> standard: 표를 고치고 빠진 틀만 더하고 AGENTS 나머지는 알림',
    /\| 문서 수준 \| standard \|/.test(upAgents) && !/\| light \|/.test(upAgents)
    && fs.existsSync(path.join(poc, 'docs', 'changes', 'README.md'))
    && /^그대로 AGENTS.md/m.test(up.stdout) && /^! AGENTS.md 나머지/m.test(up.stdout), up.stdout + upAgents);
  // (프로필을 주지 않아 core 묶음만 본다)
  check('apply poc -> standard: 이미 있는 개요라 구조 결정 이름을 알림', /^! 개요가 이미 있어 구조 결정 목록을 넣지 않았다\. 문서에 안 보이는 것: 의존 방식, 남는 데이터 형식, 외부 계약\./m.test(up.stdout), up.stdout);
  const down = run('node', [apply, poc, '--no-plugins', '--docs', 'light']);
  check('apply standard -> light: 남은 틀을 알림', /^! standard에서 light로 내렸다/m.test(down.stdout), down.stdout);

  // poc 프로필은 unity 묶음을 쌓는다: .editorconfig, Unity .gitignore와 eol=lf, 값 행, pipeline 알림
  const prof = JSON.parse(fs.readFileSync(path.join(HARNESS, 'profiles.json'), 'utf8'));
  check('profiles: unity-game은 core+unity standard, unity-poc는 core+unity+poc light',
    JSON.stringify(prof['unity-game']) === JSON.stringify({ packs: ['core', 'unity'], docs: 'standard' }) && JSON.stringify(prof['unity-poc']) === JSON.stringify({ packs: ['core', 'unity', 'poc'], docs: 'light' }) && !('poc' in prof));
  check('apply poc(unity): .editorconfig 만듦', fs.existsSync(path.join(poc, '.editorconfig')));
  const pocIgnore = fs.readFileSync(path.join(poc, '.gitignore'), 'utf8');
  check('apply poc(unity): .gitignore에 Unity 줄과 Screenshots', /# harness-unity\n[\s\S]*\/\[Ll\]ibrary\/[\s\S]*\/\[Ss\]creenshots\//.test(pocIgnore), pocIgnore);
  const pocAttr = fs.readFileSync(path.join(poc, '.gitattributes'), 'utf8');
  check('apply poc(unity): .gitattributes에 core 줄 뒤 eol=lf', pocAttr.indexOf('# harness-core') < pocAttr.indexOf('# harness-unity\n* text=auto eol=lf'), pocAttr);
  const pocAgents2 = fs.readFileSync(path.join(poc, 'AGENTS.md'), 'utf8');
  check('apply poc(unity): "값" 표에 Unity 프로젝트와 확인 씬', /\| Unity 프로젝트 \| \. \|/.test(pocAgents2) && /\| 확인 씬 \|/.test(pocAgents2), pocAgents2);
  check('apply poc(unity): Unity 프로젝트가 없으면 알림', /^! \[harness-unity\] Unity 프로젝트를 찾지 못했다/m.test(pocFirst.stdout), pocFirst.stdout);
  const un = repo('apply-unity');
  write(un, 'Packages/manifest.json', JSON.stringify({ dependencies: { 'com.unity.pipeline': '0.9.1-exp.1' } }));
  write(un, 'Assets/Old.cs', 'class Old {}\r\n');
  run('git', ['add', '-A'], { cwd: un });
  run('git', ['commit', '-q', '-m', 'init'], { cwd: un });
  const un1 = run('node', [apply, un, '--packs', 'core,unity', '--no-plugins']);
  check('apply unity: 0.10 아래 pipeline을 알림', /^! \[harness-unity\] Unity 프로젝트 .*0\.9\.1-exp\.1: 0\.10 아래다/m.test(un1.stdout), un1.stdout);
  check('apply unity: eol=lf를 새로 넣을 때 CRLF로 커밋된 파일을 알림', /^! 이미 CRLF로 커밋된 파일이 1개/m.test(un1.stdout), un1.stdout);
  write(un, 'Packages/manifest.json', JSON.stringify({ dependencies: { 'com.unity.pipeline': '0.10.0-exp.1' } }));
  const un2 = run('node', [apply, un, '--packs', 'core,unity', '--no-plugins']);
  check('apply unity: 0.10 이상이면 ! 없이 한 줄, 다시 돌리면 줄 파일은 그대로',
    /^\[harness-unity\] Unity 프로젝트 .*, com\.unity\.pipeline 0\.10\.0-exp\.1\.$/m.test(un2.stdout) && !/더함|CRLF/.test(un2.stdout), un2.stdout);
  const noCore = run('node', [apply, un, '--packs', 'unity', '--no-plugins', '--dry-run']);
  check('apply: core 없이 묶음만 주면 막고 예를 보인다', noCore.status !== 0 && /core 묶음 없이 적용하지 않는다.*--packs core,unity/.test(noCore.stdout + noCore.stderr), noCore.stdout + noCore.stderr);

  // 프로필의 수준과 표가 다르면 표를 따르고 알린다
  const pf = repo('apply-profile');
  run('node', [apply, pf, '--profile', 'unity-poc', '--no-plugins']);
  const pf2 = run('node', [apply, pf, '--profile', 'personal', '--no-plugins']);
  check('apply: 프로필의 수준과 표의 수준이 다르면 표를 따르고 알림', /^! 프로필 personal의 문서 수준은 standard지만 표의 light/m.test(pf2.stdout), pf2.stdout);

  // "값" 절 모양이 달라도: ### 값, 3칸 표, 표 바로 뒤 글
  const v3 = repo('apply-values');
  write(v3, 'AGENTS.md', '# A\n\n### 값\n| 항목 | 값 | 설명 |\n|---|---|---|\n| 문서 수준 | light | POC라서 |\n바로 뒤 글\n');
  run('node', [apply, v3, '--no-plugins', '--docs', 'standard']);
  const v3Text = fs.readFileSync(path.join(v3, 'AGENTS.md'), 'utf8');
  check('apply: ### 값 절을 알아보고 새 절을 만들지 않음', (v3Text.match(/^#{2,3} 값/gm) || []).length === 1, v3Text);
  check('apply: 3칸 표의 수준 값만 바꾸고 설명 칸은 남김, 더한 행도 3칸',
    /\| 문서 수준 \| standard \| POC라서 \|/.test(v3Text) && /\| 확인 명령 \| [^\n]*\| \|\n/.test(v3Text), v3Text);
  check('apply: 표 바로 뒤 글 앞에 빈 줄을 넣음', /\|\n\n바로 뒤 글/.test(v3Text), v3Text);

  // 이미 있던 CLAUDE.md에 내용이 있으면 알린다
  const cm = repo('apply-claude');
  write(cm, 'CLAUDE.md', '# 옛 규칙\n- 빌드는 npm run build\n');
  const cm1 = run('node', [apply, cm, '--no-plugins']);
  check('apply: 이미 있던 CLAUDE.md의 내용과 빠진 @AGENTS.md를 알림',
    /^! CLAUDE.md에 @AGENTS.md 줄이 없다/m.test(cm1.stdout) && /^! CLAUDE.md에 @ 줄 밖의 내용이 1줄/m.test(cm1.stdout), cm1.stdout);

  // 연결 파일: 켜진 묶음의 검사를 설치 기록에서 찾아 돌린다. 가짜 설정 폴더에 core 원본을 설치본처럼 적는다.
  const home = path.join(tmp, 'claude-home');
  write(home, 'plugins/installed_plugins.json', JSON.stringify({ version: 2, plugins: {
    'harness-core@harness': [{ scope: 'project', projectPath: root, installPath: CORE, version: 'test' }] } }));
  write(root, '.claude/settings.json', JSON.stringify({ enabledPlugins: { 'harness-core@harness': true, 'other@market': true } }));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: home };
  run('git', ['add', '-A'], { cwd: root });
  const c1 = run('git', ['commit', '-q', '-m', 'chore: 적용'], { cwd: root, env });
  check('연결 파일: 문제없는 적용 커밋은 통과', c1.status === 0, c1.stdout + c1.stderr);
  write(root, 'docs/systems/이동.md', '# 이동\n## 대시 (2026-11-09 바꿈)\n');
  run('git', ['add', 'docs/systems/이동.md'], { cwd: root });
  const c2 = run('git', ['commit', '-q', '-m', 'docs: 이동'], { cwd: root, env });
  check('연결 파일: 제목 날짜 문서 커밋을 git 훅이 막음', c2.status !== 0 && /제목 날짜/.test(c2.stdout + c2.stderr), c2.stdout + c2.stderr);
  write(root, '.claude/settings.json', JSON.stringify({ enabledPlugins: { 'harness-none@harness': true } }));
  const c3 = run('python', [path.join(root, '.githooks', 'harness_checks.py')], { cwd: root, env });
  check('연결 파일: 이 PC에 없는 묶음은 알리고 통과', c3.status === 0 && /깔려 있지 않아/.test(c3.stderr), c3.stdout + c3.stderr);
  const c4 = run('python', [path.join(root, '.githooks', 'harness_checks.py'), '--all'], { cwd: root, env: { ...env } });
  check('연결 파일: 켠 묶음이 없으면 아무것도 안 함', c4.status === 0);

  // 한글 경로 저장소: 연결 파일이 git 뿌리를 찾고 검사를 돌린다(전에는 모든 커밋이 막혔다)
  const ko = repo('한글 적용');
  run('node', [apply, ko, '--profile', 'unity-poc', '--no-plugins']);
  write(home, 'plugins/installed_plugins.json', JSON.stringify({ version: 2, plugins: {
    'harness-core@harness': [{ scope: 'project', projectPath: ko, installPath: CORE, version: 'test' }] } }));
  write(ko, '.claude/settings.json', JSON.stringify({ enabledPlugins: { 'harness-core@harness': true } }));
  run('git', ['add', '-A'], { cwd: ko });
  const k1 = run('git', ['commit', '-q', '-m', 'chore: 적용'], { cwd: ko, env });
  check('연결 파일: 한글 경로 저장소에서도 문제없는 커밋은 통과', k1.status === 0, k1.stdout + k1.stderr);
  write(ko, 'docs/overview.md', '# 개요\n[없음](없음.md)\n');
  run('git', ['add', 'docs/overview.md'], { cwd: ko });
  const k2 = run('git', ['commit', '-q', '-m', 'docs: 개요'], { cwd: ko, env });
  check('연결 파일: 한글 경로 저장소에서 끊긴 링크를 막음', k2.status !== 0 && /\[링크\]/.test(k2.stdout + k2.stderr), k2.stdout + k2.stderr);

  // merge: 두 브랜치 커밋은 각각 통과해도 합친 결과에서 링크가 끊길 수 있다. 충돌 없는 merge에는 pre-commit이 돌지 않는다
  const mg = repo('merge');
  write(mg, 'docs/guide.md', '# 안내\n');
  run('node', [apply, mg, '--profile', 'unity-poc', '--no-plugins']);
  write(home, 'plugins/installed_plugins.json', JSON.stringify({ version: 2, plugins: {
    'harness-core@harness': [{ scope: 'project', projectPath: mg, installPath: CORE, version: 'test' }] } }));
  write(mg, '.claude/settings.json', JSON.stringify({ enabledPlugins: { 'harness-core@harness': true } }));
  const mgit = (...a) => run('git', a, { cwd: mg, env });
  mgit('add', '-A');
  mgit('commit', '-q', '-m', 'chore: 적용');
  mgit('checkout', '-q', '-b', 'side');
  mgit('rm', '-q', 'docs/guide.md');
  const m1 = mgit('commit', '-q', '-m', 'docs: 안내 지움');
  mgit('checkout', '-q', '-');
  write(mg, 'docs/notes.md', '# 메모\n[안내](guide.md)\n');
  mgit('add', 'docs/notes.md');
  const m2 = mgit('commit', '-q', '-m', 'docs: 메모');
  const m3 = mgit('merge', '-q', '--no-edit', 'side');
  check('연결 파일: 합친 결과에서 링크가 끊기는 merge를 막음(브랜치 커밋은 각각 통과)',
    m1.status === 0 && m2.status === 0 && m3.status !== 0 && /\[링크\] docs\/notes.md:2: guide.md 없음/.test(m3.stdout + m3.stderr), m1.stderr + m2.stderr + m3.stdout + m3.stderr);
  mgit('merge', '--abort');
  write(mg, 'docs/notes.md', '# 메모\n');
  mgit('add', 'docs/notes.md');
  mgit('commit', '-q', '-m', 'docs: 메모 링크 뺌');
  const m4 = mgit('merge', '-q', '--no-edit', 'side');
  check('연결 파일: 문제없는 merge는 통과', m4.status === 0 && fs.existsSync(path.join(mg, '.git', 'MERGE_HEAD')) === false, m4.stdout + m4.stderr);
}

// 4-2. harness-team: 저장소 블록 만들기, 팀 적용(사본, 설정 합치기, 값 행, 구조 결정), 사본 검사, pre-push, check_pr
{
  const TEAM = path.join(HARNESS, 'packs', 'team');
  const apply = path.join(HARNESS, 'apply.mjs');
  for (const rel of ['.claude-plugin/plugin.json', 'block.json', 'copies.json', 'merge/.claude/settings.json']) {
    let parsed = false;
    try { JSON.parse(fs.readFileSync(path.join(TEAM, rel), 'utf8')); parsed = true; } catch { /* 실패 */ }
    check(`team: ${rel}은 올바른 JSON`, parsed);
  }
  const market = JSON.parse(fs.readFileSync(path.join(HARNESS, '.claude-plugin', 'marketplace.json'), 'utf8'));
  const profiles = JSON.parse(fs.readFileSync(path.join(HARNESS, 'profiles.json'), 'utf8'));
  check('team: 마켓플레이스에 harness-team, 프로필 unity-team = core+unity+team standard',
    market.plugins.some((p) => p.name === 'harness-team' && p.source === './packs/team')
    && JSON.stringify(profiles['unity-team']) === JSON.stringify({ packs: ['core', 'unity', 'team'], docs: 'standard' }));
  const skill = fs.readFileSync(path.join(TEAM, 'skills', 'pr-review', 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
  check('team: pr-review 스킬 frontmatter와 검사 스크립트', /^---\nname: pr-review\n/.test(skill) && fs.existsSync(path.join(TEAM, 'skills', 'pr-review', 'check_pr.py')));
  // merge-setup 드라이버는 같은 인스턴스 값 충돌을 git 충돌 없이 커밋한다(Q171). 충돌은 resolve, explain, UnityYAMLMerge -r/-l로 푼다
  check('team: pr-review는 merge-setup을 쓰지 않고 resolve와 UnityYAMLMerge로 푼다',
    skill.includes('`unity vcs merge-setup`은 쓰지 않는다') && !skill.includes('merge-setup --check')
    && ['unity vcs resolve', 'tool-declined', 'unity vcs explain', '--force --fallback none', '`-r`(PR 쪽)'].every((k) => skill.includes(k)));

  // 블록: block.json의 빼기와 고치기가 원본에서 꼭 한 번씩 맞는다(원본 줄이 바뀌면 여기서 알린다)
  const { build, upsert } = await import(pathToFileURL(path.join(TEAM, 'agents-block.mjs')).href);
  const b = build({ dirOf: (p) => path.join(HARNESS, 'packs', p) });
  check('team 블록: 빼기, 절 빼기, 고치기가 원본에서 한 번씩 맞음', b.problems.length === 0, b.problems.join(' / '));
  const personal = ['grilling', '## effort', '### effort', 'push는 요청할 때만', '<harness-unity>', '병렬로 돌릴 때', '보고에는 셋을', '(사용자 확인)', '입력 시험:', 'unity-module', '처음부터 두지 않는다', '`docs/tasks.md`(생기면)'];
  check('team 블록: 개인 층 줄이 없음', personal.every((k) => !b.text.includes(k)), personal.filter((k) => b.text.includes(k)).join(', '));
  check('team 블록: 저장소 층 줄과 팀 줄이 있음',
    ['### 팀 저장소', '`<시스템>/<작업>`', '`.githooks/pre-push`', '--affected --since origin/main', 'unity vcs hooks install', '`unity vcs merge-setup`은 쓰지 않는다', 'PR 관리자에게 넘긴다',
      '확인이 실패해도 통과시키는 것이 목표가 아니다', '"값" 표의 커밋 방식을 따른다.', '### 문서 구조', '처음부터 둔다', 'LoadPrefabContents', '### Unity 기본', '### C#', '`git status`로 고치려던 파일만',
      'git config core.hooksPath', '시스템마다 `Assets/<시스템>/` 폴더 하나', '`Resources`', '배치와 씬 고유 설정', '팀에 알렸는지', '디버그 명령', '`Assets/<시스템>/Scenes/`',
      '`folderAsset: yes`', '`git checkout --theirs -- <파일>`', '폴더를 신뢰해야', '`// harness:runtime-ok: 이유`', '`docs/tuning.md`(조정 지도)',
      'Play에 들어가 몇 프레임 뒤 오류 0', '`AssetDatabase.LoadAssetAtPath`로 다시 불러', '`enabled = false`로 멈춘다',
      '있는 파일은 바뀐 부분만 고친다(Edit, apply_patch)']
      .every((k) => b.text.includes(k)) && !/^# /m.test(b.text) && !/^## (?!공통 규칙)/m.test(b.text), b.text.slice(0, 300));
  check('team 블록: 줄 수와 크기(AGENTS.md 200줄, 32 KiB 안에 여유)', b.text.split('\n').length <= 140 && Buffer.byteLength(b.text) <= 20 * 1024,
    `${b.text.split('\n').length}줄 ${Buffer.byteLength(b.text)}바이트`);
  const bad = build({ dirOf: (p) => (p === 'core' ? path.join(HARNESS, 'packs', 'core') : null) });
  check('team 블록: 묶음이 없으면 알림', bad.problems.some((x) => /harness-unity rules\.md: 이번 적용에 그 묶음이나 파일이 없어/.test(x)));
  const u1 = upsert('# A\n\n본문\n', 'team', 'X');
  const u2 = upsert(u1.replace('X', '손으로 고침'), 'team', 'Y');
  check('team 블록: 없으면 끝에 더하고, 있으면 표식 사이만 바꾸고, 표식이 하나뿐이면 건드리지 않음',
    u1 === '# A\n\n본문\n\n<!-- harness-team:start -->\nX\n<!-- harness-team:end -->\n' && u2 === u1.replace('X', 'Y')
    && upsert('a\n<!-- harness-team:start -->\nb\n', 'team', 'Z') === null, JSON.stringify([u1, u2]));

  // 팀 적용
  const tr = repo('team');
  const t1 = run('node', [apply, tr, '--profile', 'unity-team', '--no-plugins']);
  check('team apply: 성공', t1.status === 0, t1.stderr || t1.stdout);
  for (const rel of ['AGENTS.md', 'docs/architecture.md', 'docs/game.md', 'docs/SETUP.md', 'docs/changes/README.md', '.github/pull_request_template.md',
    '.githooks/pre-push', '.githooks/pre-commit', '.githooks/harness-core/git/checks/docs.py', '.githooks/harness-core/lib/project.py',
    '.githooks/harness-unity/git/checks/runtime_build.py', '.codex/rules/harness-team.rules']) {
    check(`team apply: ${rel} 만듦`, fs.existsSync(path.join(tr, rel)));
  }
  const setup = fs.readFileSync(path.join(tr, 'docs', 'SETUP.md'), 'utf8');
  check('team apply: SETUP은 훅 연결, unity setup all, 에이전트로 폴더 신뢰 세 줄', /core\.hooksPath \.githooks/.test(setup) && setup.includes('unity setup all') && /^3\. .*신뢰한다/m.test(setup), setup);
  check('team apply: local 범위 안내, 할 일 문서는 안 만듦', /^팀 저장소\(team 묶음\): 플러그인은 이 PC에만 local 범위로/m.test(t1.stdout) && !fs.existsSync(path.join(tr, 'docs', 'tasks.md')), t1.stdout);
  check('team apply: 사본은 core 원본과 같음',
    fs.readFileSync(path.join(tr, '.githooks/harness-core/git/checks/docs.py'), 'utf8') === fs.readFileSync(path.join(CORE, 'git', 'checks', 'docs.py'), 'utf8').replace(/\r\n/g, '\n'));
  const ta = fs.readFileSync(path.join(tr, 'AGENTS.md'), 'utf8');
  check('team apply: AGENTS.md는 팀 틀, 블록 하나, 200줄 아래',
    /^여럿이 GitHub PR로 머지하는 팀 저장소다/m.test(ta) && ta.split('<!-- harness-team:start -->').length === 2 && ta.trimEnd().endsWith('<!-- harness-team:end -->')
    && ta.trimEnd().split('\n').length <= 170, `${ta.trimEnd().split('\n').length}줄`);
  // 같은 말을 여러 번 쓰면 줄 수만 늘고 따르는 정도는 안 오른다(Q176). 틀, 블록 머리, team, core가 한 번씩만 말한다
  const once = (s) => ta.split(s).length - 1;
  check('team apply: 같은 규칙은 한 번만(--no-verify, 손으로 고치지 않음, 어느 쪽을 따르나, 200줄)',
    once('--no-verify') === 1 && once('손으로 고치지') === 1 && once('"이 프로젝트의 규칙"을 따른다') === 1 && once('200줄') === 1,
    ['--no-verify', '손으로 고치지', '"이 프로젝트의 규칙"을 따른다', '200줄'].map((s) => `${s} ${once(s)}`).join(', '));
  check('team apply: "커밋" 행은 team 것 하나(core 행을 대신함)',
    (ta.match(/^\| 커밋 \|/gm) || []).length === 1 && /^\| 커밋 \| 작업 브랜치/m.test(ta), ta.slice(0, 1500));
  const tov = fs.readFileSync(path.join(tr, 'docs', 'overview.md'), 'utf8');
  check('team apply: 개요는 팀 틀, "미정"에서 어셈블리 나누기는 빠짐(정함), 나머지 구조 결정은 들어감',
    /할 일과 진행 상황은 팀이 쓰는 곳에 둔다/.test(tov) && !/어셈블리 나누기/.test(tov) && /\n- 씬 구성:/.test(tov) && /\n- 외부 계약:/.test(tov), tov);
  const game = repo('team-vs-game');
  run('node', [apply, game, '--profile', 'unity-game', '--no-plugins']);
  check('unity-game: 개요 "미정"에 어셈블리 나누기', /\n- 어셈블리 나누기: 게임 코드 런타임 asmdef 하나/.test(fs.readFileSync(path.join(game, 'docs', 'overview.md'), 'utf8')));
  const tchk = run('python', [path.join(tr, '.githooks', 'harness_checks.py'), '--all'], { cwd: tr });
  check('team apply: 막 만든 팀 틀은 저장소 사본 문서 검사를 통과(블록 안 경로는 건너뜀)', tchk.status === 0 && /문제 0개/.test(tchk.stdout), tchk.stdout + tchk.stderr);
  // 이미 있는 설정은 두고 없는 값만 더한다
  write(tr, '.claude/settings.json', JSON.stringify({ permissions: { allow: ['Bash(git status)', 'Bash(unity test *)'], deny: ['Bash(rm *)'] }, env: { A: '1' } }, null, 2));
  write(tr, 'AGENTS.md', ta.replace('### 팀 저장소', '### 손으로 고친 제목').replace('- 없음. 공통 규칙과', '- 팀 규칙 하나.\n- 없음. 공통 규칙과'));
  const t2 = run('node', [apply, tr, '--profile', 'unity-team', '--no-plugins']);
  const st = JSON.parse(fs.readFileSync(path.join(tr, '.claude', 'settings.json'), 'utf8'));
  check('team apply: settings.json의 남의 값은 두고 승인 생략 중 없는 것만 더함',
    st.env.A === '1' && st.permissions.deny[0] === 'Bash(rm *)' && st.permissions.allow[0] === 'Bash(git status)'
    && st.permissions.allow.filter((x) => x === 'Bash(unity test *)').length === 1 && st.permissions.allow.includes('PowerShell(unity command console *)')
    && /\.claude\/settings\.json에 7개 더함/.test(t2.stdout), t2.stdout + JSON.stringify(st));
  const ta2 = fs.readFileSync(path.join(tr, 'AGENTS.md'), 'utf8');
  check('team apply: 다시 적용하면 블록 안은 되돌리고 블록 밖 규칙은 둠',
    ta2.includes('### 팀 저장소') && !ta2.includes('손으로 고친 제목') && ta2.includes('- 팀 규칙 하나.') && /AGENTS\.md harness-team 블록 고침/.test(t2.stdout), t2.stdout);
  const t3 = run('node', [apply, tr, '--profile', 'unity-team', '--no-plugins']);
  check('team apply: 세 번째는 바꾸는 것 없음', !/만듦|덮어씀|더함|고침/.test(t3.stdout), t3.stdout);
  check('team apply: 끝 안내에 pre-push 실행 비트와 SETUP', /--chmod=\+x \.githooks\/pre-commit \.githooks\/pre-merge-commit \.githooks\/pre-push /.test(t3.stdout) && /docs\/SETUP\.md/.test(t3.stdout), t3.stdout);

  // 사본 검사: 플러그인 없는 팀원도 막히고, 내 PC(플러그인 켬)에서는 같은 묶음의 플러그인 검사를 건너뛴다
  run('git', ['add', '-A'], { cwd: tr });
  const tc1 = run('git', ['commit', '-q', '-m', 'chore: 시작'], { cwd: tr });
  check('team: 플러그인 없이도 문제없는 커밋은 통과', tc1.status === 0, tc1.stdout + tc1.stderr);
  write(tr, 'docs/systems/이동.md', '# 이동\n[없음](없음.md)\n');
  run('git', ['add', 'docs/systems/이동.md'], { cwd: tr });
  const tc2 = run('git', ['commit', '-q', '-m', 'docs: 이동'], { cwd: tr });
  check('team: 플러그인 없는 팀원의 끊긴 링크 커밋을 사본 검사가 막음', tc2.status !== 0 && /\[링크\]/.test(tc2.stdout + tc2.stderr), tc2.stdout + tc2.stderr);
  run('git', ['reset', '-q', 'HEAD', 'docs/systems/이동.md'], { cwd: tr });
  fs.rmSync(path.join(tr, 'docs', 'systems', '이동.md'));
  const fake = path.join(tmp, 'fake-core');
  write(fake, 'git/checks/docs.py', 'print("FAKE-PLUGIN-CHECK")\n');
  const thome = path.join(tmp, 'team-home');
  write(thome, 'plugins/installed_plugins.json', JSON.stringify({ version: 2, plugins: {
    'harness-core@harness': [{ scope: 'local', projectPath: tr, installPath: fake, version: 'test' }] } }));
  write(tr, '.claude/settings.local.json', JSON.stringify({ enabledPlugins: { 'harness-core@harness': true } }));
  const tenv = { ...process.env, CLAUDE_CONFIG_DIR: thome };
  const tc3 = run('python', [path.join(tr, '.githooks', 'harness_checks.py'), '--all'], { cwd: tr, env: tenv });
  check('team: 저장소 사본이 있으면 같은 묶음의 플러그인 검사는 건너뜀', tc3.status === 0 && /문제 0개/.test(tc3.stdout) && !/FAKE-PLUGIN-CHECK/.test(tc3.stdout), tc3.stdout + tc3.stderr);
  fs.rmSync(path.join(tr, '.githooks', 'harness-core'), { recursive: true });
  const tc4 = run('python', [path.join(tr, '.githooks', 'harness_checks.py'), '--all'], { cwd: tr, env: tenv });
  check('team: 사본이 없으면 플러그인 검사를 돌림', /FAKE-PLUGIN-CHECK/.test(tc4.stdout), tc4.stdout + tc4.stderr);
  run('node', [apply, tr, '--profile', 'unity-team', '--no-plugins']);

  // pre-push: 원격에 main이 없을 때의 첫 push만 통과, 그 뒤 main push와 main 지우기는 막고 브랜치 push는 통과
  const remote = path.join(tmp, 'team-remote.git');
  run('git', ['init', '-q', '--bare', remote]);
  run('git', ['remote', 'add', 'origin', remote], { cwd: tr });
  run('git', ['branch', '-M', 'main'], { cwd: tr });
  const pp1 = run('git', ['push', '-q', 'origin', 'main'], { cwd: tr });
  write(tr, 'docs/game.md', fs.readFileSync(path.join(tr, 'docs', 'game.md'), 'utf8') + '\n- 메모\n');
  run('git', ['commit', '-q', '-am', 'docs: 메모'], { cwd: tr });
  const pp2 = run('git', ['push', '-q', 'origin', 'main'], { cwd: tr });
  run('git', ['checkout', '-q', '-b', 'combat/dash'], { cwd: tr });
  const pp3 = run('git', ['push', '-q', 'origin', 'combat/dash'], { cwd: tr });
  const pp4 = run('git', ['push', '-q', 'origin', ':main'], { cwd: tr });
  check('team pre-push: 첫 main push 통과, 그 뒤 main push 막음, 브랜치 push 통과, main 지우기 막음',
    pp1.status === 0 && pp2.status !== 0 && /main에 직접 push할 수 없다/.test(pp2.stderr) && pp3.status === 0 && pp4.status !== 0,
    [pp1, pp2, pp3, pp4].map((x) => `${x.status}:${x.stderr}`).join(' | '));

  // docs.py: harness 블록 안의 경로는 건너뛰고, 밖과 닫히지 않은 블록은 본다
  const bk = repo('docs-block');
  write(bk, 'docs/overview.md', '# 개요\n');
  write(bk, 'AGENTS.md', '# A\n\n<!-- harness-team:start -->\n- 옛 문서는 `docs/archive/`로\n<!-- harness-team:end -->\n');
  run('git', ['add', '-A'], { cwd: bk });
  const bk1 = run('python', [path.join(CORE, 'git', 'checks', 'docs.py'), bk]);
  write(bk, 'AGENTS.md', '# A\n\n- 옛 문서는 `docs/archive/`로\n');
  const bk2 = run('python', [path.join(CORE, 'git', 'checks', 'docs.py'), bk]);
  write(bk, 'AGENTS.md', '# A\n\n<!-- harness-team:start -->\n- 옛 문서는 `docs/archive/`로\n');
  const bk3 = run('python', [path.join(CORE, 'git', 'checks', 'docs.py'), bk]);
  check('docs.py: harness 블록 안 경로는 건너뜀, 블록 밖과 닫히지 않은 블록은 막음',
    bk1.status === 0 && bk2.status !== 0 && /docs\/archive 없음/.test(bk2.stdout) && bk3.status !== 0, bk1.stdout + bk2.stdout + bk3.stdout);

  // check_pr: .meta 짝, 인스턴스 값 중복, GUID 중복, asmdef 참조 변화
  const cp = repo('check-pr');
  const cpg = (...a) => run('git', a, { cwd: cp });
  write(cp, 'Assets/A.asmdef', JSON.stringify({ name: 'A', references: ['Unity.InputSystem'] }));
  write(cp, 'Assets/A.asmdef.meta', 'guid: 11111111111111111111111111111111\n');
  cpg('add', '-A'); cpg('commit', '-q', '-m', 'base'); cpg('branch', '-M', 'main');
  cpg('checkout', '-q', '-b', 'pr');
  write(cp, 'Assets/A.asmdef', JSON.stringify({ name: 'A', references: ['Unity.InputSystem', 'B'] }));
  write(cp, 'Assets/New.cs', 'class New {}\n');
  write(cp, 'Assets/Copy.png.meta', 'guid: 11111111111111111111111111111111\n');
  write(cp, 'Assets/Copy.png', 'x');
  const inst = '--- !u!1001 &1\nPrefabInstance:\n  m_Modification:\n    m_Modifications:\n'
    + '    - target: {fileID: 5, guid: abc, type: 3}\n      propertyPath: m_Speed\n      value: 3\n      objectReference: {fileID: 0}\n'
    + '    - target: {fileID: 5, guid: abc, type: 3}\n      propertyPath: m_Speed\n      value: 8\n      objectReference: {fileID: 0}\n';
  write(cp, 'Assets/Scene.unity', inst);
  write(cp, 'Assets/Scene.unity.meta', 'guid: 22222222222222222222222222222222\n');
  write(cp, '.gitattributes', '# *.prefab merge=unityyamlmerge\n*.unity merge=unityyamlmerge\n');
  cpg('add', '-A'); cpg('commit', '-q', '-m', 'pr');
  const cr = run('python', [path.join(TEAM, 'skills', 'pr-review', 'check_pr.py'), 'main', 'pr'], { cwd: cp });
  check('check_pr: .meta 없는 파일, 같은 인스턴스 값 둘, 겹친 GUID, merge 드라이버 줄(주석 줄은 빼고), asmdef 참조 +B',
    cr.status === 1 && /\.meta가 같이 A되지 않음: Assets\/New\.cs/.test(cr.stdout) && /m_Speed 값이 2개 \(3, 8\)/.test(cr.stdout)
    && /GUID 11111111111111111111111111111111: /.test(cr.stdout) && /## merge 드라이버 줄: 1건\r?\n-\x20\.gitattributes 2: \*\.unity merge=unityyamlmerge/.test(cr.stdout)
    && /Assets\/A\.asmdef: \+B/.test(cr.stdout), cr.stdout + cr.stderr);
  const crBase = run('python', [path.join(TEAM, 'skills', 'pr-review', 'check_pr.py'), 'main', 'main'], { cwd: cp });
  check('check_pr: 바뀐 것이 없으면 문제 없음(.gitattributes가 없어도)', crBase.status === 0 && /## merge 드라이버 줄: 문제 없음/.test(crBase.stdout), crBase.stdout + crBase.stderr);

  // check_pr: PR 없이 main에 들어온 커밋(처음 PR merge 뒤, 본 자리 뒤만), 본 자리가 main에 없으면 강제 push
  const mp = repo('check-main');
  const mg = (...a) => run('git', a, { cwd: mp });
  const checkPr = (cwd) => run('python', [path.join(TEAM, 'skills', 'pr-review', 'check_pr.py'), 'main', 'pr'], { cwd });
  write(mp, 'a.txt', '1\n'); mg('add', '-A'); mg('commit', '-q', '-m', 'chore: 처음 세팅'); mg('branch', '-M', 'main');
  write(mp, 'b.txt', '1\n'); mg('add', '-A'); mg('commit', '-q', '-m', 'feat: 걷는 뼈대');
  mg('checkout', '-q', '-b', 'f'); write(mp, 'c.txt', '1\n'); mg('add', '-A'); mg('commit', '-q', '-m', 'feat: c');
  mg('checkout', '-q', 'main'); mg('merge', '-q', '--no-ff', 'f', '-m', 'Merge pull request #1 from team/f');
  write(mp, 'd.txt', '1\n'); mg('add', '-A'); mg('commit', '-q', '-m', 'fix: 직접 올림');
  mg('checkout', '-q', '-b', 'pr');
  const cm1 = checkPr(mp);
  check('check_pr: 처음 PR merge 뒤 PR 없이 들어온 커밋만(처음 세팅과 뼈대는 뺌)',
    cm1.status === 1 && /## PR 없이 main에 들어온 커밋: 1건/.test(cm1.stdout) && /fix: 직접 올림/.test(cm1.stdout) && !/걷는 뼈대|처음 세팅/.test(cm1.stdout), cm1.stdout + cm1.stderr);
  mg('update-ref', 'refs/harness/main-seen', 'main');
  const cm2 = checkPr(mp);
  check('check_pr: 본 자리(refs/harness/main-seen) 앞은 다시 보이지 않음', cm2.status === 0 && /## PR 없이 main에 들어온 커밋: 문제 없음/.test(cm2.stdout), cm2.stdout + cm2.stderr);
  mg('branch', '-f', 'main', 'main~1');
  const cm3 = checkPr(mp);
  check('check_pr: 본 자리가 main에 없으면 강제 push로 알림', cm3.status === 1 && /main 기록이 바뀌었다/.test(cm3.stdout), cm3.stdout + cm3.stderr);
}

// 4-1. apply --new: 새 폴더 만들기, git init -b main, unity 묶음은 가짜 unity CLI로(projects create, 에디터 고르기, collab-proxy 빼기)
{
  const apply = path.join(HARNESS, 'apply.mjs');
  const fakeCli = path.join(tmp, 'fake-unity.mjs');
  const argsLog = path.join(tmp, 'fake-unity-args.jsonl');
  write(tmp, 'fake-unity.mjs', `import fs from 'node:fs';
import path from 'node:path';
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argsLog)}, JSON.stringify(a) + '\\n');
if (a[0] === 'editors') {
  console.log(JSON.stringify({ success: true, data: { items: [
    { version: '7000.0.0a16' }, { version: '6000.7.0b8', location: 'C:/U/b8' }, { version: '6000.3.28f1' },
    { version: '6000.3.9f1', location: 'C:/U/9' }, { version: '6000.3.27f1', location: 'C:/U/27' }, { version: '6000.0.55f1', location: 'C:/U/55' }] } }));
} else if (a[0] === 'projects' && a[1] === 'create') {
  const dir = path.join(a[a.indexOf('--path') + 1], a[2]);
  const w = (rel, t) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), t); };
  const deps = { 'com.unity.collab-proxy': '2.13.6', 'com.unity.inputsystem': '1.20.1', 'com.unity.pipeline': '0.10.0-exp.1' };
  w('Packages/manifest.json', JSON.stringify({ dependencies: deps }, null, 2) + '\\n');
  w('Packages/packages-lock.json', JSON.stringify({ dependencies: { 'com.unity.collab-proxy': { version: '2.13.6', depth: 0 }, 'com.unity.inputsystem': { version: '1.20.1', depth: 0 } } }, null, 2) + '\\n');
  w('ProjectSettings/ProjectVersion.txt', 'm_EditorVersion: ' + a[a.indexOf('--editor-version') + 1] + '\\n');
  w('Assets/Scenes/SampleScene.unity', '%YAML 1.1\\n');
  w('ProjectSettings/URPProjectSettings.asset', 'MonoBehaviour:\\n  m_LastMaterialVersion: ' + (a.includes('6000.0.55f1') ? 10 : 9) + '\\n');
  w('Library/cache.bin', 'x');
  console.log(dir);
} else process.exit(3);
`);
  const env = { ...process.env, HARNESS_UNITY_CLI: fakeCli };
  const calls = () => (fs.existsSync(argsLog) ? fs.readFileSync(argsLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

  const plain = path.join(tmp, 'new-plain');
  const rp = run('node', [apply, plain, '--new', '--profile', 'personal', '--no-plugins'], { env });
  check('apply --new personal: 폴더, git main, 틀', rp.status === 0 && fs.existsSync(path.join(plain, 'AGENTS.md'))
    && run('git', ['symbolic-ref', 'HEAD'], { cwd: plain }).stdout.trim() === 'refs/heads/main' && !calls().length, rp.stdout + rp.stderr);

  const g = path.join(tmp, 'NewPoc');
  const rg = run('node', [apply, g, '--new', '--profile', 'unity-poc', '--no-plugins'], { env });
  const create = calls().find((c) => c[1] === 'create');
  const manifest = JSON.parse(fs.readFileSync(path.join(g, 'Packages', 'manifest.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(g, 'Packages', 'packages-lock.json'), 'utf8'));
  check('apply --new unity-poc: 설치된 가장 높은 정식 에디터로 projects create(2d, 클라우드 없음)',
    rg.status === 0 && create && create[2] === 'NewPoc' && create[create.indexOf('--editor-version') + 1] === '6000.3.27f1'
    && create[create.indexOf('--template') + 1] === '2d' && create.includes('--no-cloud') && create.includes('--non-interactive'), rg.stdout + rg.stderr + JSON.stringify(calls()));
  check('apply --new unity-poc: collab-proxy를 manifest와 lock에서 뺌, 나머지는 그대로',
    !('com.unity.collab-proxy' in manifest.dependencies) && manifest.dependencies['com.unity.inputsystem'] === '1.20.1'
    && !('com.unity.collab-proxy' in lock.dependencies) && 'com.unity.inputsystem' in lock.dependencies && /^패키지 뺌: manifest\.json\(com\.unity\.collab-proxy\), packages-lock\.json/m.test(rg.stdout), rg.stdout);
  check('apply --new: URP 재질 버전이 낮으면(9) 설정 파일을 지우고 알림',
    !fs.existsSync(path.join(g, 'ProjectSettings', 'URPProjectSettings.asset')) && /^URPProjectSettings\.asset 지움/m.test(rg.stdout), rg.stdout);
  check('apply --new unity-poc: git main, poc 틀, Unity .gitignore, pipeline 알림은 정상 줄',
    run('git', ['symbolic-ref', 'HEAD'], { cwd: g }).stdout.trim() === 'refs/heads/main' && fs.existsSync(path.join(g, 'docs', 'game.md'))
    && /\/\[Ll\]ibrary\//.test(fs.readFileSync(path.join(g, '.gitignore'), 'utf8'))
    && /^\[harness-unity\] Unity 프로젝트 .*com\.unity\.pipeline 0\.10\.0-exp\.1\.$/m.test(rg.stdout), rg.stdout);
  run('git', ['config', 'user.email', 't@t'], { cwd: g });
  run('git', ['config', 'user.name', 't'], { cwd: g });
  run('git', ['add', '-A'], { cwd: g });
  const first = run('git', ['commit', '-q', '-m', 'chore: NewPoc 프로젝트 생성과 하네스 적용'], { cwd: g });
  const tracked = run('git', ['ls-files'], { cwd: g }).stdout;
  check('apply --new unity-poc: 첫 커밋이 커밋 전 검사를 통과하고 Library는 빠짐', first.status === 0 && tracked.includes('Packages/manifest.json') && !tracked.includes('Library/'), first.stdout + first.stderr);

  const before = calls().length;
  const pinned = path.join(tmp, 'NewPinned');
  run('node', [apply, pinned, '--new', '--profile', 'unity-poc', '--unity', '6000.0.55f1', '--no-plugins'], { env });
  const after = calls().slice(before);
  check('apply --new: URP 재질 버전 10은 그대로', fs.existsSync(path.join(pinned, 'ProjectSettings', 'URPProjectSettings.asset')));
  check('apply --new --unity: 준 버전을 쓰고 에디터 목록은 묻지 않음', after.length === 1 && after[0][after[0].indexOf('--editor-version') + 1] === '6000.0.55f1', JSON.stringify(after));

  const busy = repo('new-busy');
  write(busy, 'a.txt', 'x');
  check('apply --new: 비어 있지 않은 폴더는 막음', run('node', [apply, busy, '--new', '--no-plugins'], { env }).status === 2);
  check('apply --new: 개인 모드와 같이 쓰지 않음', run('node', [apply, path.join(tmp, 'new-personal'), '--new', '--personal', '--no-plugins'], { env }).status === 2);
  const dry = run('node', [apply, path.join(tmp, 'new-dry'), '--new', '--profile', 'unity-poc', '--dry-run', '--no-plugins'], { env });
  check('apply --new --dry-run: 만들 것만 보이고 폴더를 만들지 않음', dry.status === 0 && /unity\/new-project\.mjs/.test(dry.stdout) && !fs.existsSync(path.join(tmp, 'new-dry')), dry.stdout);

  const { pickEditor } = await import(pathToFileURL(path.join(HARNESS, 'packs', 'unity', 'new-project.mjs')).href);
  check('unity new-project: 정식(f)이고 설치된 것 중 숫자로 가장 높은 버전',
    pickEditor([{ version: '6000.3.9f1', location: 'x' }, { version: '6000.3.27f1', location: 'x' }, { version: '6000.4.0b2', location: 'x' }, { version: '6000.9.0f1' }]) === '6000.3.27f1'
    && pickEditor([{ version: '7000.0.0a16', location: 'x' }]) === null);
}

// 갱신 확인(harness-user update_check.py, session_start.py)과 하루 한 번 문서 전체 검사(harness-core inject.py)
{
  const home = path.join(tmp, 'uc-home');
  const UC = path.join(HARNESS, 'user', 'hooks', 'update_check.py');
  const SS = path.join(HARNESS, 'user', 'hooks', 'session_start.py');
  const fileUrl = (p) => 'file:///' + p.replace(/\\/g, '/').replace(/^\/+/, '');
  const gitIn = (cwd, ...a) => run('git', a, { cwd });
  // harness 원본: 설치본보다 버전이 높다(다른 PC에서 pull 한 뒤)
  const hsrc = path.join(tmp, 'uc-harness');
  write(hsrc, '.claude-plugin/marketplace.json', JSON.stringify({ name: 'harness', plugins: [{ name: 'harness-core', source: './packs/core' }] }));
  write(hsrc, 'packs/core/.claude-plugin/plugin.json', JSON.stringify({ name: 'harness-core', version: '0.2.0' }));
  // git 마켓플레이스: tool은 새 버전, same은 그대로
  const mk = repo('uc-market');
  write(mk, '.claude-plugin/marketplace.json', JSON.stringify({ name: 'mk', plugins: [{ name: 'tool', source: './plugins/tool' }, { name: 'same', source: './plugins/same', version: '2.0.0' }] }));
  write(mk, 'plugins/tool/.claude-plugin/plugin.json', JSON.stringify({ name: 'tool', version: '1.1.0' }));
  gitIn(mk, 'add', '-A'); gitIn(mk, 'commit', '-q', '-m', 'm');
  // npx skills 원본: a는 lock 뒤에 바뀌고 b는 그대로
  const sk = repo('uc-skills');
  write(sk, 'skills/a/SKILL.md', '# a\n옛 줄\n'); write(sk, 'skills/b/SKILL.md', '# b\n');
  gitIn(sk, 'add', '-A'); gitIn(sk, 'commit', '-q', '-m', '1');
  const treeA = gitIn(sk, 'rev-parse', 'HEAD:skills/a').stdout.trim();
  const treeB = gitIn(sk, 'rev-parse', 'HEAD:skills/b').stdout.trim();
  write(sk, 'skills/a/SKILL.md', '# a\n새 줄\n'); gitIn(sk, 'commit', '-q', '-am', '2');
  write(home, '.claude/plugins/known_marketplaces.json', JSON.stringify({
    harness: { source: { source: 'directory', path: hsrc } }, mk: { source: { source: 'git', url: fileUrl(mk) } },
  }));
  write(home, '.claude/plugins/installed_plugins.json', JSON.stringify({ version: 2, plugins: {
    'harness-core@harness': [{ scope: 'project', projectPath: 'C:/p', version: '0.1.0' }],
    'tool@mk': [{ scope: 'user', version: '1.0.0' }], 'same@mk': [{ scope: 'user', version: '2.0.0' }],
  } }));
  const ent = (tree, p) => ({ source: 'me/skills', sourceType: 'github', sourceUrl: fileUrl(sk), skillPath: p, skillFolderHash: tree });
  write(home, '.agents/.skill-lock.json', JSON.stringify({ version: 3, skills: {
    a: ent(treeA, 'skills/a/SKILL.md'), b: ent(treeB, 'skills/b/SKILL.md'),
    'orca-cli': { ...ent('0'.repeat(40), 'skills/a/SKILL.md'), source: 'stablyai/orca' },
  } }));
  write(home, '.agents/skills/a/SKILL.md', '# a\n옛 줄\n');
  write(tmp, 'uc-fake/orca.mjs', `console.log(JSON.stringify({ plan: { skills: [
    { name: 'orca-cli', digest: 'abcdef1234', ops: [{ kind: 'keep' }] }, { name: 'orchestration', digest: '99887766aa', ops: [{ kind: 'update' }] }] } }));`);
  write(tmp, 'uc-fake/unity.mjs', `console.log(JSON.stringify({ success: true, data: { currentVersion: '1.0.0-beta.14', latestVersion: '1.0.0-beta.17' } }));`);
  const env = { ...process.env, USERPROFILE: home, HOME: home,
    HARNESS_UPDATE_CMD_ORCA: JSON.stringify(['node', path.join(tmp, 'uc-fake', 'orca.mjs')]),
    HARNESS_UPDATE_CMD_UNITY: JSON.stringify(['node', path.join(tmp, 'uc-fake', 'unity.mjs')]) };
  const r = run('python', [UC, '--now', '--json'], { env });
  let res = {};
  try { res = JSON.parse(r.stdout); } catch { /* 실패 */ }
  const byKind = Object.fromEntries((res.items || []).map((i) => [i.kind + ':' + i.name, i]));
  check('update_check: harness 원본이 설치본보다 새것', byKind['harness:harness-core@harness']?.latest === '0.2.0' && byKind['harness:harness-core@harness']?.where?.[0]?.project === 'C:/p', r.stdout + r.stderr);
  check('update_check: git 마켓플레이스 플러그인 새 버전(같은 버전은 조용)', byKind['plugin:tool@mk']?.latest === '1.1.0' && !byKind['plugin:same@mk'], JSON.stringify(res));
  check('update_check: npx skills 폴더 트리 해시가 바뀐 것만, Orca 출처는 뺌', byKind['skill:a']?.update?.[0] === 'DISABLE_TELEMETRY=1 npx -y skills add me/skills -g -a codex -s a -y' && !byKind['skill:b'] && !byKind['skill:orca-cli'], JSON.stringify(res));
  check('update_check: Orca는 keep이 아닌 것만, Unity CLI 버전', byKind['orca:orchestration'] && !byKind['orca:orca-cli'] && byKind['unity:unity CLI']?.latest === '1.0.0-beta.17', JSON.stringify(res));
  check('update_check: 모두 5개, 오류 없음, 결과를 저장', res.items?.length === 5 && res.errors?.length === 0 && fs.existsSync(path.join(home, '.claude', 'harness-update.json')), JSON.stringify(res.errors));
  const df = run('python', [UC, '--diff', 'a'], { env });
  check('update_check --diff: 설치본과 새 원본 SKILL.md 차이', /^-옛 줄$/m.test(df.stdout) && /^\+새 줄$/m.test(df.stdout), df.stdout + df.stderr);
  // 세션 시작: 저장된 결과로 한 줄, 압축 뒤에는 안 냄, 끄면 안 냄
  const ss = (source, extra = {}) => { try { return JSON.parse(run('python', [SS], { input: JSON.stringify({ source }), env: { ...env, ...extra } }).stdout); } catch { return {}; } };
  const s1 = ss('startup');
  check('session_start: 갱신이 있으면 사용자에게 한 줄, 전역 지시는 그대로', /^\[harness\] 갱신 5개: .* 외 2\. harness-update로/.test(s1.systemMessage || '') && /# 개인 전역 지시|## 언어/.test(s1.hookSpecificOutput?.additionalContext || ''), JSON.stringify(s1).slice(0, 300));
  check('session_start: 압축 뒤(compact)와 HARNESS_UPDATE_CHECK=0이면 알림 없음', !ss('compact').systemMessage && !ss('startup', { HARNESS_UPDATE_CHECK: '0' }).systemMessage);
  const dm = run('python', [UC, '--dismiss', 'unity:unity CLI'], { env });
  const again = run('python', [UC, '--now'], { env });
  check('update_check --dismiss: 그 버전 알림만 끄고 다시 확인해도 유지', /알림 끔: unity:unity CLI 1\.0\.0-beta\.17/.test(dm.stdout)
    && /^\[harness\] 갱신 4개/.test(ss('startup').systemMessage || '') && /\[unity:unity CLI\] .*\(알림 끔\)/.test(again.stdout), dm.stdout + again.stdout);
  write(tmp, 'uc-fake/unity.mjs', `console.log(JSON.stringify({ success: true, data: { currentVersion: '1.0.0-beta.14', latestVersion: '1.0.0-beta.18' } }));`);
  run('python', [UC, '--now'], { env });
  check('update_check --dismiss: 다음 버전이 나오면 다시 알림', /^\[harness\] 갱신 5개/.test(ss('startup').systemMessage || ''));
  // 하루가 지났으면 뒤에서 확인을 띄운다(세션 시작은 기다리지 않는다)
  const cacheFile = path.join(home, '.claude', 'harness-update.json');
  fs.writeFileSync(cacheFile, JSON.stringify({ checked_at: '2020-01-01T00:00:00+00:00', items: [] }));
  const t0 = Date.now();
  ss('startup');
  const quick = Date.now() - t0 < 5000;
  let fresh = false;
  for (let i = 0; i < 60 && !fresh; i++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    try { fresh = JSON.parse(fs.readFileSync(cacheFile, 'utf8')).checked_at > '2021'; } catch { /* 쓰는 중 */ }
  }
  check('session_start: 오래된 결과면 뒤에서 다시 확인(기다리지 않음), 끝나면 잠금을 지움', quick && fresh && !fs.existsSync(path.join(home, '.claude', 'harness-update.lock')));
  const lk = run('python', ['-c', `import sys; sys.path.insert(0, r"${path.dirname(UC)}"); import update_check as u; print(u.take_lock(), u.take_lock())`], { env });
  fs.rmSync(path.join(home, '.claude', 'harness-update.lock'), { force: true });
  check('update_check: 잠금은 하나만 잡힌다(같이 시작한 세션 둘이 둘 다 띄우지 않음)', lk.stdout.trim() === 'True False', lk.stdout + lk.stderr);
  // 개인 모드 worktree: main에서 local로 켠 묶음이 새 worktree에 없으면 한 줄(켜는 명령과 함께), 있으면 조용
  const wm = repo('wt-main');
  write(wm, 'a.txt', 'a\n'); gitIn(wm, 'add', '-A'); gitIn(wm, 'commit', '-q', '-m', 'a');
  write(wm, '.claude/settings.local.json', JSON.stringify({ enabledPlugins: { 'harness-unity@harness': true, 'harness-core@harness': true, 'harness-user@harness': true, 'harness-orca@harness': false } }));
  const side = path.join(tmp, 'wt-side');
  gitIn(wm, 'worktree', 'add', '-q', side, '-b', 'side');
  const wt = (cwd) => { try { return JSON.parse(run('python', [SS], { input: JSON.stringify({ source: 'startup', cwd }), env: { ...env, HARNESS_UPDATE_CHECK: '0' } }).stdout).systemMessage || ''; } catch { return ''; } };
  const wtMsg = wt(side);
  check('session_start: 새 worktree에 local 묶음이 없으면 알리고 apply --personal 명령을 보임',
    /^\[harness\] 이 worktree에는 main worktree\(.*\)에서 local로 켠 묶음\(harness-core, harness-unity\)이 꺼져 있다/.test(wtMsg)
    && wtMsg.includes(path.join(hsrc, 'apply.mjs')) && / --personal --packs core,unity 뒤 새 세션$/.test(wtMsg), wtMsg);
  write(side, '.claude/settings.local.json', JSON.stringify({ enabledPlugins: { 'harness-unity@harness': false } }));
  const offMsg = wt(side);
  check('session_start: worktree에 끔으로 적은 묶음은 알리지 않고 켜는 명령에서도 뺌',
    /\(harness-core\)이 꺼져 있다/.test(offMsg) && / --personal --packs core 뒤 새 세션$/.test(offMsg), offMsg);
  write(side, '.claude/settings.local.json', JSON.stringify({ enabledPlugins: { 'harness-core@harness': true, 'harness-unity@harness': true } }));
  check('session_start: main worktree, 이미 켠 worktree, git 밖에서는 조용', !wt(wm) && !wt(side) && !wt(tmp), wt(wm) + wt(side) + wt(tmp));

  // 깨진 마켓플레이스 하나가 다른 마켓플레이스 확인을 멈추지 않고, lock의 낯선 출처는 명령으로 만들지 않는다
  const home2 = path.join(tmp, 'uc-home2');
  const broken = repo('uc-broken');
  write(broken, '.claude-plugin/marketplace.json', '{ 깨짐');
  gitIn(broken, 'add', '-A'); gitIn(broken, 'commit', '-q', '-m', 'b');
  write(home2, '.claude/plugins/known_marketplaces.json', JSON.stringify({
    broken: { source: { source: 'git', url: fileUrl(broken) } }, mk: { source: { source: 'git', url: fileUrl(mk) } },
  }));
  write(home2, '.claude/plugins/installed_plugins.json', JSON.stringify({ version: 2, plugins: {
    'x@broken': [{ scope: 'user', version: '1.0.0' }], 'tool@mk': [{ scope: 'user', version: '1.0.0' }],
  } }));
  write(home2, '.agents/.skill-lock.json', JSON.stringify({ version: 3, skills: { a: { ...ent(treeA, 'skills/a/SKILL.md'), source: 'me/skills;echo hi' } } }));
  const r2 = run('python', [UC, '--now', '--json'], { env: { ...env, USERPROFILE: home2, HOME: home2 } });
  let res2 = {};
  try { res2 = JSON.parse(r2.stdout); } catch { /* 실패 */ }
  const by2 = Object.fromEntries((res2.items || []).map((i) => [i.kind + ':' + i.name, i]));
  check('update_check: 깨진 마켓플레이스는 오류 한 줄, 다른 마켓플레이스 갱신은 그대로',
    by2['plugin:tool@mk']?.latest === '1.1.0' && (res2.errors || []).some((e) => /broken: marketplace\.json을 읽지 못했다/.test(e)), r2.stdout + r2.stderr);
  check('update_check: lock의 출처 모양이 낯설면 갱신 명령을 만들지 않음', by2['skill:a'] && by2['skill:a'].update.length === 0 && /낯설어/.test(by2['skill:a'].note || ''), JSON.stringify(by2['skill:a']));

  // harness-core: 하루 한 번 문서 전체 검사
  const dc = repo('doc-check');
  write(dc, '.githooks/harness_checks.py', 'print("[harness-core] 문서 수준 standard, 현재 상태 문서 1개, 진행 중 문서 0개, 문제 2개")\n');
  const inject = path.join(CORE, 'hooks', 'inject.py');
  const ij = (source, extra = {}) => { try { return JSON.parse(run('python', [inject, 'rules.md'], { input: JSON.stringify({ cwd: dc, source }), env: { ...process.env, CLAUDE_PLUGIN_ROOT: CORE, ...extra } }).stdout); } catch { return {}; } };
  check('inject: 압축 뒤에는 문서 전체 검사를 안 함', !ij('compact').systemMessage);
  const d1 = ij('startup');
  check('inject: 하루 첫 세션에 문서 전체 검사, 문제가 있으면 한 줄', /^\[harness\] 문서 전체 검사: 문제 2개\. 보기: python \.githooks\/harness_checks\.py --all/.test(d1.systemMessage || '') && /# 작업 규칙: harness-core/.test(d1.hookSpecificOutput?.additionalContext || ''), JSON.stringify(d1).slice(0, 300));
  check('inject: 같은 날 두 번째 세션은 조용', !ij('startup').systemMessage);
  fs.writeFileSync(path.join(dc, '.git', 'harness-doc-check'), '2020-01-01');
  write(dc, '.githooks/harness_checks.py', 'print("[harness-core] 문제 0개")\n');
  check('inject: 문제가 없으면 알림 없음, 연결 파일이 없는 프로젝트는 돌리지 않음', !ij('startup').systemMessage && !hookOut(run('python', [inject, 'rules.md'], { input: JSON.stringify({ cwd: tmp, source: 'startup' }), env: { ...process.env, CLAUDE_PLUGIN_ROOT: CORE } })).systemMessage);
  fs.writeFileSync(path.join(dc, '.git', 'harness-doc-check'), '2020-01-01');
  write(dc, '.githooks/harness_checks.py', 'import sys\nsys.exit(3)\n');
  check('inject: 검사가 문제 수 없이 실패하면 그렇다고 한 줄', /^\[harness\] 문서 전체 검사가 실패했다\(종료 코드 3\)/.test(ij('startup').systemMessage || ''));
}

// 평가 스크립트(eval/run.py): 만든 대화 기록, eval 기록, git으로 센다
{
  const ev = repo('eval');
  const g = (...a) => run('git', a, { cwd: ev });
  write(ev, 'ProjectSettings/ProjectVersion.txt', 'm_EditorVersion: 6000.3.27f1\n');
  write(ev, 'docs/overview.md', '# 개요\n\n## 미정\n\n- 의존 방식: 직접 엮기. 정할 때: 모듈이 둘이 될 때\n');
  g('add', '-A'); g('commit', '-q', '-m', 'chore: 처음');
  write(ev, 'docs/overview.md', '# 개요\n\n## 미정\n');
  write(ev, 'docs/tasks.md', '# 할 일\n\n- [ ] 점프 손맛 (사용자 확인)\n');
  write(ev, 'Assets/Tests/JumpTests.cs', 'class JumpTests {}\n');
  g('add', '-A'); g('commit', '-q', '-m', 'fix(player): 점프');
  // 문구만 고친 구조 결정은 닫은 것이 아니고, Latest.cs는 테스트 파일이 아니다
  write(ev, 'docs/overview.md', '# 개요\n\n## 미정\n\n- 씬 구성: 하나. 정할 때: 두 번째 씬 전\n- 화면 기준: 정할 때: 첫 아트 전\n');
  g('commit', '-q', '-am', 'docs: 미정 둘');
  write(ev, 'docs/overview.md', '# 개요\n\n## 미정\n\n- 씬 구성: 하나 또는 여럿. 정할 때: 두 번째 씬 전\n- 화면 기준: 정할 때: 첫 아트 전\n');
  g('commit', '-q', '-am', 'docs: 문구');
  write(ev, 'Assets/Latest.cs', 'class Latest {}\n');
  g('add', '-A'); g('commit', '-q', '-m', 'fix(ui): 최신');
  write(ev, 'tools/check.sh', 'unity command console get --level error\n'); // 커밋된 래퍼는 디스크에서 읽는다
  write(ev, 'Library/Pipeline/eval-usage.jsonl', [
    { time: '2026-11-10T00:00:30Z', command: 'script eval', success: false, classification: 'statements', fingerprints: [] },
    { time: '2026-11-10T00:01:00Z', command: 'script eval', success: true, classification: 'expression', fingerprints: ['System.Reflection.BindingFlags.NonPublic', 'UnityEngine.Object.FindAnyObjectByType'] },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n깨진 줄\n');
  const at = (s) => new Date(Date.UTC(2026, 10, 10, 0, 0, s)).toISOString();
  let n = 0;
  const line = (s, type, extra) => JSON.stringify({ type, uuid: `u${n++}`, sessionId: 'sess0001', timestamp: at(s), ...extra });
  const user = (s, text) => line(s, 'user', { message: { role: 'user', content: text } });
  const text = (s, t) => line(s, 'assistant', { message: { role: 'assistant', content: [{ type: 'text', text: t }] } });
  const use = (s, id, name, input) => line(s, 'assistant', { effort: 'xhigh', message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name, input }] } });
  const res = (s, id, t, err = false) => line(s, 'user', { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: t, is_error: err }] } });
  const wiki = path.join(path.dirname(HARNESS), 'ai-workflow', 'x.md');
  const lines = [
    user(0, '점프를 만들어줘'),
    use(10, 't1', 'Edit', { file_path: path.join(ev, 'Assets', 'Player.cs') }), res(11, 't1', 'ok'),
    use(20, 't2', 'Bash', { command: 'unity command editor.playmode start --project-path . ; sleep 5; unity command capture game_view' }), res(50, 't2', 'ok'),
    use(60, 't3', 'Bash', { command: 'unity command console get --level error' }), res(61, 't3', '{"errorCount": 2}'),
    use(70, 't4', 'Bash', { command: 'git commit -m "feat: 점프"' }), res(72, 't4', 'ok'),
    text(80, '점프를 고쳤습니다.'),
    user(200, '점프가 안 돼요'),
    text(210, '테스트 통과했습니다.'),
    line(300, 'system', { subtype: 'compact_boundary' }),
    user(400, '다시 봐줘'),
    use(410, 't5', 'Bash', { command: 'unity command console get --level error' }), res(411, 't5', '{"errorCount": 0}'),
    use(420, 't6', 'Write', { file_path: wiki }), res(421, 't6', 'ok'),
    use(430, 't7', 'Bash', { command: 'unity test run --mode EditMode' }), res(440, 't7', 'Exit code 1\nTests failed: 1', true),
    use(450, 't8', 'Edit', { file_path: path.join(ev, 'Assets', 'Tests', 'JumpTests.cs') }), res(451, 't8', 'ok'),
    use(455, 't8b', 'Bash', { command: 'git commit -m "test: 점프"' }), res(456, 't8b', 'ok'),
    text(460, '"미정"의 의존 방식부터 정할까요?'),
    text(465, '반영했습니다.'),
    user(470, '<command-name>/review</command-name>\n<command-args>왜 안 돼?</command-args>'), // 슬래시 명령은 턴만 나눈다
    // 세션 안에서 만든 래퍼(프로젝트 밖)는 코드 수정이 아니고, 부르면 그 내용(캡처)으로 센다
    use(500, 't9', 'Write', { file_path: path.join(tmp, 'scratch', 'cap.sh'), content: 'unity command capture game_view --output-path x.png\n' }), res(501, 't9', 'ok'),
    use(510, 't10', 'Bash', { command: `bash "${path.join(tmp, 'scratch', 'cap.sh').replace(/\\/g, '/')}"` }), res(512, 't10', 'ok'),
    use(520, 't11', 'Bash', { command: 'git commit -m "docs: 메모"' }), res(521, 't11', 'ok'),
    // 막힌 명령의 sleep은 세지 않는다
    use(530, 't12', 'Bash', { command: 'sleep 30; unity command console get --level error' }), res(531, 't12', '<tool_use_error>Blocked: sleep 30 followed by unity</tool_use_error>', true),
    use(540, 't13', 'Bash', { command: 'bash tools/check.sh' }), res(541, 't13', '{"errorCount": 0}'),
    use(545, 't13b', 'Bash', { command: 'git add tools/check.sh' }), res(546, 't13b', 'ok'), // 실행이 아니다
    use(550, 't14', 'Bash', { command: 'bash gone.sh' }), res(551, 't14', 'ok'), // 내용을 모르는 래퍼
    // unity로 에셋만 바꾼 커밋은 따로 센다(어떤 확인이든 봤는지). 코드를 고치고 플레이와 캡처로만 본 커밋도 따로 센다
    use(560, 't15', 'Bash', { command: 'unity component set_field --path X --field y --value 1' }), res(561, 't15', 'ok'),
    use(570, 't16', 'Bash', { command: 'unity command editor.playmode start; unity command capture game_view' }), res(575, 't16', 'ok'),
    use(580, 't17', 'Bash', { command: 'git commit -m "feat: 값"' }), res(581, 't17', 'ok'),
    use(590, 't18', 'Edit', { file_path: path.join(ev, 'Assets', 'Enemy.cs'), new_string: 'x = 1;' }), res(591, 't18', 'ok'),
    use(600, 't19', 'Bash', { command: 'unity command capture game_view --output-path y.png' }), res(601, 't19', 'ok'),
    use(610, 't20', 'Bash', { command: 'git commit -m "feat: 적"' }), res(611, 't20', 'ok'),
    use(620, 't21', 'Bash', { command: 'unity command scene save' }), res(621, 't21', 'ok'),
    use(630, 't22', 'Bash', { command: 'git commit -m "chore: 씬"' }), res(631, 't22', 'ok'),
    // 있는 파일을 Write로 통째 다시 쓴 것만 센다(새 파일, 실패한 Write는 빼고)
    use(640, 't23', 'Write', { file_path: path.join(ev, 'Assets', 'Player.cs'), content: 'class Player {}\n' }), res(641, 't23', 'The file Player.cs has been updated successfully.'),
    use(650, 't24', 'Write', { file_path: path.join(ev, 'Assets', 'New.cs'), content: 'class New {}\n' }), res(651, 't24', 'File created successfully at: New.cs'),
    use(660, 't25', 'Write', { file_path: path.join(ev, 'Assets', 'Enemy.cs'), content: 'x' }), res(661, 't25', 'File has not been read yet.', true),
  ];
  lines.push(lines[1]); // 이어 간 세션이 다시 담은 줄(같은 uuid)은 한 번만 센다
  lines.push(JSON.stringify({ type: 'assistant', uuid: 'side', isSidechain: true, sessionId: 'sess0001', timestamp: at(15), message: { content: [{ type: 'tool_use', id: 'sx', name: 'Bash', input: { command: 'sleep 99' } }] } }));
  write(tmp, 'eval-transcripts/sess0001.jsonl', lines.join('\n') + '\n');
  const r = run('python', [path.join(HARNESS, 'eval', 'run.py'), ev, '--transcripts', path.join(tmp, 'eval-transcripts'), '--json']);
  let j = {};
  try { j = JSON.parse(r.stdout); } catch { /* 실패 */ }
  const v = j.verify || {};
  check('eval: 확인 호출과 sleep(막힌 것은 뺌), 플레이 진입, 캡처(래퍼 안 포함), 수정 없이 같은 확인 반복(하위 에이전트와 겹친 줄은 뺌)',
    v.calls === 9 && v.sleep_count === 1 && v.sleep_seconds === 5 && v.play_starts === 2 && v.captures === 4 && v.repeated_reads === 1, r.stdout + r.stderr);
  check('eval: 래퍼 실행(대화에서 쓴 것, 디스크의 것, 모르는 것), git add는 실행이 아님', v.wrapper_calls === 3 && v.wrapper_unknown === 1, JSON.stringify(v));
  const c = j.commits_in_transcript || {};
  check('eval: 코드를 고친 뒤 커밋(프로젝트 밖 임시 파일은 뺌), 컴파일/콘솔/테스트 없이, 그중 플레이로만, 마지막 확인이 오류, 에셋만 고친 커밋과 그중 확인 없이',
    c.after_code_edit === 3 && c.with_errors === 1 && c.no_compile_check === 2 && c.play_check_only === 1 && c.no_compile_check_share === 0.667
    && c.after_asset_only === 2 && c.asset_unchecked === 1, JSON.stringify(c));
  const fe = j.tools?.file_edits || {};
  check('eval: 프로젝트 파일 Edit 수와 새 글 양, 있는 파일을 Write로 통째 다시 쓴 수와 글자, 비율(새 파일과 실패한 Write는 뺌)',
    fe.edit === 3 && fe.edit_chars === 6 && fe.rewrite === 1 && fe.rewrite_chars === 16 && fe.rewrite_share === 0.25 && fe.rewrites?.['Player.cs'] === 1, JSON.stringify(fe));
  check('eval: 압축, dev-wiki 원본 수정, 실패한 도구 호출과 종류', j.context?.compactions === 1 && j.dev_wiki?.edits === 1 && j.tools?.failures_by_tool?.Bash === 2
    && j.tools?.failures_by_kind?.command === 1 && j.tools?.failures_by_kind?.blocked === 1, JSON.stringify([j.context, j.dev_wiki, j.tools?.failures_by_tool, j.tools?.failures_by_kind]));
  const cl = j.agents?.by_agent_effort?.['claude:claude-opus-5-5:xhigh'];
  check('eval: Claude 호출은 줄의 model과 effort로 agent:model:effort를 붙임', cl?.calls === j.tools?.calls && cl?.sessions === 1 && j.codex === null
    && j.agents?.sessions?.[0]?.id === 'sess0001', JSON.stringify(j.agents?.by_agent_effort));
  const e = j.eval_usage || {};
  check('eval: eval 기록(수, 여러 문장 비율, 실패, 리플렉션, Find류, 읽지 못한 줄)', e.total === 2 && e.statements_share === 0.5 && e.failures === 1 && e.reflection_nonpublic === 1 && e.find_objects === 1 && e.unparsed === 1, JSON.stringify(e));
  const gm = j.git || {};
  check('eval: git(fix 중 테스트 파일, 새 테스트 파일, Latest.cs는 아님, (사용자 확인) 더함, 문구만 고친 구조 결정은 닫지 않음)',
    gm.fix === 2 && gm.fix_with_tests === 1 && gm.fix_adding_tests === 1 && gm.fix_share === 0.4 && gm.user_check_added === 1 && gm.decisions_closed === 1, JSON.stringify(gm));
  const cd = j.candidates || {};
  check('eval 후보: 끝났다고 한 뒤 문제(슬래시 명령은 뺌, 걸린 말 표시), 확인 없이 통과했다는 말, 미정, 확인 실패 뒤 테스트 수정',
    cd.leaked_bugs?.length === 1 && /\[고쳤 -> 안 돼\]/.test(cd.leaked_bugs[0]) && cd.claims_without_check?.length === 1 && cd.undecided_mentions?.length === 1 && cd.criteria_edit_after_fail?.length === 1, JSON.stringify(cd));
  check('eval: 도구 시간당 수치, 판정 칸은 비어 있음', j.per_hour?.captures > 0 && j.judged?.leaked_bugs === null, JSON.stringify([j.per_hour, j.judged]));
  // 창 밖에서 쓴 래퍼도 창 안의 호출에서 내용으로 센다
  const ws = run('python', [path.join(HARNESS, 'eval', 'run.py'), ev, '--transcripts', path.join(tmp, 'eval-transcripts'), '--since', at(505), '--json']);
  let wj = {};
  try { wj = JSON.parse(ws.stdout); } catch { /* 실패 */ }
  check('eval: 창 밖(--since 앞)에서 쓴 래퍼도 내용으로 센다', wj.verify?.captures === 3 && wj.verify?.wrapper_unknown === 1, ws.stdout.slice(0, 300) + ws.stderr);
  const out = path.join(tmp, 'eval-base.json');
  run('python', [path.join(HARNESS, 'eval', 'run.py'), ev, '--transcripts', path.join(tmp, 'eval-transcripts'), '--out', out]);
  const base = JSON.parse(fs.readFileSync(out, 'utf8'));
  base.judged.leaked_bugs = 1;
  fs.writeFileSync(out, JSON.stringify(base));
  run('python', [path.join(HARNESS, 'eval', 'run.py'), ev, '--transcripts', path.join(tmp, 'eval-transcripts'), '--out', out]);
  const kept = JSON.parse(fs.readFileSync(out, 'utf8')).judged?.leaked_bugs === 1;
  const cmp = run('python', [path.join(HARNESS, 'eval', 'run.py'), ev, '--transcripts', path.join(tmp, 'eval-transcripts'), '--compare', out]);
  check('eval: 다시 돌려도 --out의 판정은 남고, 비교 표에는 비율과 판정만',
    kept && /^# 평가: eval/m.test(cmp.stdout) && /\| 확인 시간 비율 \| [\d.]+ \| [\d.]+ \| 낮게/.test(cmp.stdout) && /\| 판정: 새어 나간 버그 \| 1 \| - \|/.test(cmp.stdout) && !/후보 leaked_bugs/.test(cmp.stdout), cmp.stdout + cmp.stderr);
}

// 평가 스크립트: Codex 기록(exec 안의 apply_patch와 exec_command, 셀을 기다린 wait의 결과, sleep)과 agent:model:effort 열
{
  const cx = repo('eval-codex');
  write(cx, 'AGENTS.md', '# P\n\n## 값\n\n| 항목 | 값 |\n|---|---|\n| 확인 명령 | `npm test` |\n');
  run('git', ['add', '-A'], { cwd: cx }); run('git', ['commit', '-q', '-m', 'chore: 처음'], { cwd: cx });
  const head = run('git', ['rev-parse', 'HEAD'], { cwd: cx }).stdout.trim();
  const at = (s) => new Date(Date.UTC(2026, 10, 10, 1, 0, s)).toISOString();
  const rec = (s, type, payload) => JSON.stringify({ timestamp: at(s), type, payload });
  const item = (s, payload) => rec(s, 'response_item', payload);
  const msg = (s, role, text) => item(s, { type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] });
  const exec = (s, id, input) => item(s, { type: 'custom_tool_call', name: 'exec', call_id: id, input });
  const out = (s, id, text, type = 'custom_tool_call_output') => item(s, { type, call_id: id, output: [{ type: 'input_text', text }] });
  const sleep = (s, id) => item(s, { type: 'function_call', name: 'sleep', call_id: id, arguments: '{"duration_ms":20000}' });
  const session = [
    rec(0, 'session_meta', { id: 'cx01', cwd: cx }),
    rec(1, 'turn_context', { model: 'gpt-6-sol', effort: 'high', cwd: cx }),
    msg(2, 'user', '# AGENTS.md instructions for x'), msg(3, 'user', '<environment_context>x</environment_context>'),
    msg(4, 'user', '점프를 고쳐줘'),
    exec(10, 'c1', 'text(await tools.apply_patch("*** Begin Patch\\n*** Update File: src/jump.js\\n@@\\n-a\\n+b\\n*** End Patch"));'),
    out(11, 'c1', 'Script completed\nWall time 0.1 seconds\nOutput:\n'),
    exec(20, 'c2', 'text(await tools.exec_command({cmd:"npm test"}));'),
    out(21, 'c2', 'Script running with cell ID 3\nWall time 31.0 seconds\nOutput:\n'),
    item(60, { type: 'function_call', name: 'wait', call_id: 'w1', arguments: '{"cell_id":"3","yield_time_ms":30000}' }),
    out(80, 'w1', 'Script completed\nOutput:\n{"exit_code":1,"output":"1 failing"}', 'function_call_output'),
    sleep(90, 's1'),
    out(110, 's1', 'Wall time: 20.0 seconds\nSleep completed.', 'function_call_output'),
    rec(111, 'turn_context', { model: 'gpt-6-sol', effort: 'medium', cwd: cx }),
    exec(120, 'c3', 'text(await tools.exec_command({cmd:"git commit -am \\"fix: 점프\\""}));'),
    out(121, 'c3', 'Script completed\nOutput:\n{"exit_code":0}'),
    msg(130, 'assistant', '고쳤습니다.'),
    // 한 메시지에 AGENTS 안내, 환경 정보, 사용자 글이 같이 온다
    item(140, { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for x' },
      { type: 'input_text', text: '<environment_context>x</environment_context>' }, { type: 'input_text', text: '아직 버그가 있다' }] }),
    // patch만 한 exec가 실패: 실패로 세고, 코드 수정으로는 세지 않는다. patch 본문의 git commit 글자는 커밋이 아니다
    exec(150, 'c4', 'text(await tools.apply_patch("*** Begin Patch\\n*** Update File: src/a.js\\n+git commit -m x\\n*** Update File: src/b.js\\n+b\\n*** End Patch"));'),
    out(151, 'c4', 'Script failed\nError: patch did not apply'),
    sleep(160, 's2'),
    out(180, 's2', 'Sleep completed.', 'function_call_output'),
    // 출력에 섞인 파일 내용의 "exit_code"는 결과가 아니다. 음수 종료 코드는 실패다
    exec(190, 'c6', 'text(await tools.exec_command({cmd:"cat log.json"}));'),
    out(191, 'c6', 'Script completed\nOutput:\n{"exit_code":0,"output":"..."}\n  "exit_code": 1,\n'),
    exec(200, 'c7', "text(await tools.exec_command({cmd:'npm run x'}));"),
    out(201, 'c7', 'Script completed\nOutput:\n{"exit_code":-1}'),
    exec(210, 'c5', 'const cmd = "git commit -am again"; text(await tools.exec_command({cmd}));'),
    out(211, 'c5', 'Script completed\nOutput:\n{"exit_code":0}'),
  ];
  write(tmp, 'eval-codex-sessions/2026/11/10/rollout-a.jsonl', session.join('\n') + '\n');
  write(tmp, 'eval-codex-sessions/2026/11/10/rollout-b.jsonl', [rec(0, 'session_meta', { id: 'cx02', cwd: path.join(tmp, 'other') }), msg(1, 'user', '다른 프로젝트')].join('\n') + '\n');
  // 지운 worktree: cwd가 지금 없고 시작 커밋이 이 저장소에 있으면 이 프로젝트, 모르는 커밋이면 아니다
  write(tmp, 'eval-codex-sessions/2026/11/10/rollout-c.jsonl', [rec(0, 'session_meta', { id: 'cx03', cwd: path.join(tmp, 'gone-worktree'), git: { commit_hash: head, branch: 'w' } }), msg(1, 'user', '지운 worktree')].join('\n') + '\n');
  write(tmp, 'eval-codex-sessions/2026/11/10/rollout-d.jsonl', [rec(0, 'session_meta', { id: 'cx04', cwd: path.join(tmp, 'gone-other'), git: { commit_hash: '0123456789abcdef0123456789abcdef01234567' } }), msg(1, 'user', '다른 저장소')].join('\n') + '\n');
  fs.mkdirSync(path.join(tmp, 'eval-codex-empty'), { recursive: true });
  const cr = run('python', [path.join(HARNESS, 'eval', 'run.py'), cx, '--transcripts', path.join(tmp, 'eval-codex-empty'), '--codex', path.join(tmp, 'eval-codex-sessions'), '--json']);
  let cj = {};
  try { cj = JSON.parse(cr.stdout); } catch { /* 실패 */ }
  const x = cj.codex || {};
  check('eval codex: 이 저장소 cwd의 세션과 지운 worktree의 세션(시작 커밋으로)만 읽음',
    cj.sources?.codex_sessions === 2 && cj.sources?.codex_files === 2 && cj.sources?.codex_recovered === 1, cr.stdout.slice(0, 300) + cr.stderr);
  check('eval codex: Claude 지표와 섞지 않고 codex에 따로 셈', cj.tools?.calls === 0 && x.tools?.calls === 10, JSON.stringify(cj.tools) + JSON.stringify(x.tools));
  check('eval codex: apply_patch는 코드 수정, 확인 명령과 sleep은 확인, cmd 글자의 git commit만 커밋(patch 본문은 아님)',
    x.tools?.calls_by_category?.code === 3 && x.tools?.calls_by_category?.verify === 3 && x.tools?.calls_by_category?.commit === 2
    && x.tools?.calls_by_category?.shell === 2 && x.verify?.sleep_seconds === 40 && x.commits_in_transcript?.after_code_edit === 1
    && x.commits_in_transcript?.no_compile_check === 0, JSON.stringify(x.tools) + JSON.stringify(x.verify));
  check('eval codex: 셀을 기다린 wait의 exit_code 1과 음수 종료 코드는 실패, 파일 내용 속 exit_code는 아님, 실패한 patch만 한 exec도 실패',
    x.tools?.failures_by_tool?.Bash === 2 && x.tools?.failures_by_tool?.Edit === 1 && x.tools?.failures_by_kind?.command === 3, JSON.stringify(x.tools));
  check('eval codex: 같은 길이의 sleep 도구는 같은 확인 반복으로 세지 않음', x.verify?.repeated_reads === 0, JSON.stringify(x.verify));
  const leaked = x.candidates?.leaked_bugs || [];
  check('eval codex: 여러 조각으로 온 사용자 메시지에서 사용자 글만 읽음(끝났다고 한 뒤 문제)',
    leaked.length === 1 && /아직 버그가 있다/.test(leaked[0]) && !/AGENTS\.md|environment_context/.test(leaked[0]), JSON.stringify(x.candidates));
  const be = cj.agents?.by_agent_effort || {};
  const hi = be['codex:gpt-6-sol:high'], md = be['codex:gpt-6-sol:medium'];
  check('eval: agent:model:effort마다 세션, 호출, 확인 호출, 실패(턴마다 바뀐 effort를 따름)',
    hi?.calls === 3 && hi?.verify_calls === 2 && hi?.failures === 1 && hi?.sessions === 1 && md?.calls === 7 && md?.verify_calls === 1 && md?.failures === 2,
    JSON.stringify(be));
  check('eval: 세션마다 호출과 agent 목록(대화 글은 넣지 않음)', cj.agents?.sessions?.length === 1 && cj.agents.sessions[0].calls === 10
    && cj.agents.sessions[0].who[0] === 'codex:gpt-6-sol:medium' && !JSON.stringify(cj.agents).includes('점프'), JSON.stringify(cj.agents?.sessions));
  const ct = run('python', [path.join(HARNESS, 'eval', 'run.py'), cx, '--transcripts', path.join(tmp, 'eval-codex-empty'), '--codex', path.join(tmp, 'eval-codex-sessions')]);
  check('eval: 보고에 세션 중 Codex 수, 에이전트와 effort 줄, Codex 줄과 후보',
    /세션 2개\(그중 Codex 2, 지운 worktree에서 커밋으로 찾음 1\)/.test(ct.stdout)
    && /^- 에이전트와 effort\(세션\/호출\/분\/확인 호출\/실패\): codex:gpt-6-sol:medium 1\/7\//m.test(ct.stdout)
    && /^- Codex\(위 줄들과 따로 셈/m.test(ct.stdout) && /^### Codex: 끝났다고 한 뒤 사용자가 문제를 말함: 1$/m.test(ct.stdout), ct.stdout + ct.stderr);
}

// 훅 하나가 넣는 글은 10,000자에서 끊기고, 넘으면 앞 2,000자 미리보기만 간다(Claude Code hooks 문서, Q177).
// 프로젝트마다 붙는 줄(Unity 상태, 설치 경로, 문서 수준 경고)의 몫을 남겨 원본은 9,000자 아래로 둔다
{
  const rd = (...p) => fs.readFileSync(path.join(HARNESS, ...p), 'utf8').trim().replace(/\r\n/g, '\n');
  const core = rd('packs', 'core', 'rules.md').length + 2;
  const sizes = {
    'core(standard)': core + rd('packs', 'core', 'docs-standard.md').length,
    'core(light)': core + rd('packs', 'core', 'docs-light.md').length,
    unity: rd('packs', 'unity', 'rules.md').length,
    poc: rd('packs', 'poc', 'rules.md').length,
    user: rd('user', 'instructions.md').length,
  };
  check('주입: 훅 하나가 넣는 글은 9,000자 아래(10,000자에서 끊겨 미리보기만 간다)', Object.values(sizes).every((n) => n < 9000), JSON.stringify(sizes));

  // 통과 지문: plugin.json(release가 버전을 바꾼다)과 __pycache__는 빼고, 다른 파일이 바뀌면 달라진다
  const { sourcesHash } = await import(pathToFileURL(path.join(HARNESS, 'lib', 'stamp.mjs')).href);
  const sd = path.join(tmp, 'stamp-src', 'pack');
  write(sd, 'rules.md', '규칙\n');
  const h1 = sourcesHash([sd]);
  write(sd, '.claude-plugin/plugin.json', '{"version": "9.9.9"}\n');
  write(sd, 'hooks/__pycache__/x.pyc', 'bin');
  const h2 = sourcesHash([sd]);
  write(sd, 'rules.md', '규칙 바뀜\n');
  check('통과 지문: plugin.json과 __pycache__는 빼고, 원본이 바뀌면 달라짐', h1 === h2 && sourcesHash([sd]) !== h1);
}

if (!process.env.KEEP) fs.rmSync(tmp, { recursive: true, force: true }); else console.log(tmp);
console.log(`\n${pass} passed, ${fail} failed`);
if (!fail) {
  const { writeStamp } = await import(pathToFileURL(path.join(HARNESS, 'lib', 'stamp.mjs')).href);
  writeStamp(); // release.mjs가 이 지문과 지금 원본을 비교한다
}
process.exit(fail ? 1 : 0);
