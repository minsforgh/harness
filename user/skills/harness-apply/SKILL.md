---
name: harness-apply
description: 프로젝트에 하네스 묶음(harness-core 등)을 적용하거나 갱신하고, 새 프로젝트를 만든다(`--new`, Unity면 공식 CLI로 Unity 프로젝트까지). 묶음 플러그인을 프로젝트 범위로 켜고, AGENTS.md 머리와 "값" 표, 문서 틀(개요, 시스템, 결정, 진행 중 변경), 커밋 전 검사 연결을 넣는다. 새 프로젝트를 시작할 때, "새 POC", "POC 만들자"(unity-poc 프로필로 만든 뒤 그 폴더 세션에서 harness-poc:poc가 이어 받는다), "팀 저장소 만들자"(unity-team, 내가 PR 관리자), "하네스 적용", "harness-apply", "묶음 깔아줘", 묶음을 더하거나 뺄 때, dev-flow를 깐 옛 프로젝트를 옮길 때 쓴다.
---

# harness-apply

묶음의 규칙, 스킬, 훅, 커밋 전 검사는 플러그인 안에 있고 프로젝트에 복사하지 않는다. 프로젝트에 들어가는 것은 플러그인을 켠 기록(`.claude/settings.json`), 처음 파일(그 뒤로는 프로젝트 것), 검사를 찾아 부르는 연결 파일(`.githooks/`)뿐이다. 설계: dev-wiki `ai-workflow/harness-design.md`.

## 고르기

- **프로필**: dev-wiki `_harness/profiles.json`. 프로필은 묶음 목록과 문서 수준이다. `personal`(core, standard)은 엔진을 쓰지 않는 오래 갈 개인 프로젝트, `unity-game`(core+unity, standard)은 오래 갈 개인 Unity 게임, `unity-poc`(core+unity+poc, light)는 짧게 끝낼 Unity 게임 POC(poc 묶음이 POC 규칙, 느슨한 확인, poc 스킬을 준다), `unity-team`(core+unity+team, standard)은 내가 PR 관리자인 Unity 팀 저장소(아래 "팀 저장소"). 엔진을 쓰는 프로필은 엔진 이름이 앞에 붙는다. 다른 묶음은 만들어지면 프로필에 들어간다. 사용자가 묶음을 직접 말하면 `--packs core,...`로 준다.
- **orca 묶음**: 멀티 에이전트 오케스트레이션으로 개발할 프로젝트에만 프로필 위에 더한다(`--packs core,unity,orca`). 한 번 맡기기나 worktree를 따로 파서 병렬로 시키는 정도는 공식 `orca-cli` 스킬로 충분하므로 켜지 않는다. 켠 뒤 오케스트레이션 값 행은 비워 두고 `harness-orca:milestone-start`에서 채운다.
- **문서 수준**: standard는 개요, 시스템 문서, ADR, 진행 중 큰 변경(`docs/changes/`)까지 두고, 구조 지도(`docs/architecture.md`)는 시스템이 둘이 되면 만든다. light는 개요, 시스템 문서, ADR(생기면)만 두고 검사도 끊긴 링크와 경로, 크기만 막는다. 두 수준 모두 할 일은 `docs/tasks.md`(생기면). 프로필과 다르게 하려면 `--docs <수준>`. POC가 제작으로 넘어가면 `--docs standard`로 다시 돌린다(표를 고치고 빠진 틀만 더한다. AGENTS.md "먼저 읽을 것"은 새 틀에 맞춰 손으로 고친다). standard에서 light로 내릴 때 구조 지도와 `docs/changes/`를 더 쓰지 않으면 `docs/archive/`로 옮긴다.
- **모드**: 커밋한 사람이 나뿐이면(`git shortlog -sne --all`) 저장소 모드. 내가 PR 관리자인 팀 저장소면 `--profile unity-team`. 남이 관리하는 저장소면 `--personal`(플러그인만 local 범위로 켜고 공용 파일은 건드리지 않는다).

## 새 프로젝트 (`--new`)

프로젝트 폴더가 아직 없을 때. 이름과 위치는 사용자에게 받는다(POC면 기획 문서의 IdeaId, 위치는 아이디어 목록(`<아이디어 폴더>/목록.md`)의 넘김 장소. 없으면 `<작업 폴더>/<IdeaId>`).

```
node <dev-wiki>/_harness/apply.mjs <없는 폴더> --new --profile unity-poc [--unity <에디터 버전>] [--unity-template 2d|3d]
```

- 폴더를 만들고 `git init -b main`을 한 뒤 아래 "순서" 3번부터와 같다. unity 묶음이 들면 공식 `unity projects create`로 Unity 프로젝트를 먼저 만든다(몇 분 걸리므로 백그라운드로 돌린다. Unity Hub에 등록된다). 에디터는 `--unity`가 없으면 설치된 가장 높은 정식(f) 버전이다.
- 끝나면 "순서" 4번(채우기)과 7번(커밋)을 한다. 커밋 메시지는 `chore: <이름> 프로젝트 생성과 하네스 적용`이고 이것이 첫 커밋이다(Orca worktree는 커밋 하나 이상을 전제로 한다).
- 묶음 규칙과 스킬은 그 폴더에서 연 새 세션부터 보인다. POC면 그 세션에서 `harness-poc:poc`로 이어 간다고 알린다.
- 첫 세션: POC가 아니면 그 폴더의 새 세션에서 개요(`docs/overview.md`)의 한 줄, 목표, 범위, 완료 기준을 사용자와 채우고, "미정"의 구조 결정 중 지금 정할 것을 묻는다(되돌리기 어려운 것은 grilling). 정한 것은 그 줄을 지우고 결론을 AGENTS.md "이 프로젝트의 규칙"이나 해당 문서에, ADR 조건에 맞으면 ADR로도 쓴다. 나머지는 "미정"에 두고 기대는 일을 시작할 때 묻는다. 이 단계를 보고의 남은 일에 적는다. POC는 `harness-poc:poc`가 이 일을 한다.

## 팀 저장소 (`unity-team`)

내가 PR 관리자이고 팀원은 각자 Claude Code나 Codex를 쓰는 저장소다. 팀원은 플러그인을 깔지 않는다.

- 플러그인(core, unity, team, 공식 unity)은 이 PC에만 local 범위로 켠다(`.claude/settings.local.json`, git에 안 올라감). 저장소 `.claude/settings.json`에는 Unity 확인 명령 승인 생략만 들어간다(`.codex/rules/harness-team.rules`도 같다).
- 팀원 결과물에 닿는 규칙은 AGENTS.md의 `<!-- harness-team:start -->` ~ `end` 블록으로 들어간다. core와 unity 규칙에서 저장소 층 줄을 뽑고 팀 줄(브랜치 `<시스템>/<작업>`, main은 PR로만, PR 세 칸, `--affected` 테스트, 충돌 처리)을 더한 것이다. 다시 적용할 때마다 덮어쓰므로 블록 밖 "이 프로젝트의 규칙"에 프로젝트 규칙을 쓴다. 묶음 규칙을 release한 뒤에는 다시 적용해 블록을 맞추고 PR로 올린다.
- 검사: `.githooks/pre-push`가 main 직접 push를 막는다(원격에 main이 없을 때의 첫 push만 통과). 문서 검사는 `.githooks/harness-core/` 사본이 누구에게나 돈다.
- 틀: 처음부터 `docs/architecture.md`(의존 방향, 씬 목록, 진입점, 두는 위치)와 `docs/game.md`, `docs/SETUP.md`(클론한 뒤 세 줄: 훅 연결, `unity setup all`, 에이전트로 폴더 신뢰), PR 템플릿. `docs/tasks.md`는 두지 않는다(할 일은 팀이 쓰는 곳).
- 걷는 뼈대: 팀원이 나눠서 코드를 짜기 전에, 첫 세션에서 사용자(필요하면 한두 명과)와 핵심 루프 하나가 실제 게임 씬에서 처음부터 끝까지 도는 상태를 main에 올린다(아트는 임시). 시스템을 처음부터 사람 수로 나누지 않는다. 맞물리는 방식(입력, 진행 흐름, 씬 구조)이 정해지기 전에 나누면 각자 짐작으로 만들고 합치는 일이 따로 생긴다(BreathForge: 사람별 테스트 씬 13개, 실제 씬은 뒤늦게).
  - 들어갈 것: 공용 폴더(`Assets/` 바로 아래 아트, 사운드, 게임 씬 폴더. 빈 폴더는 `.gitkeep`)와 Unity가 만든 그 `.meta`, 빌드 첫 씬과 본 씬, 처음 시스템 폴더(`harness-unity:unity-module`의 시스템 줄), `docs/architecture.md`의 씬 목록, 진입점, 두는 위치(공용 폴더 이름).
  - 커밋 전에 에디터가 새 폴더를 가져온 뒤 `git status`로 폴더마다 `.meta`가 있는지 본다. `.meta` 없이 올라가면 팀원 에디터마다 다른 GUID를 만들어 폴더 `.meta`가 add/add로 충돌한다.
  - 그동안 다른 팀원은 막히지 않는 일(아트 방향, 사운드, 레벨 스케치, 기획 세부, 버릴 시험작)을 한다. 뼈대가 main에 오르면 클론과 `docs/SETUP.md`를 알리고, 그 뒤로 기능 단위로 나눠 뼈대에 꽂는다.
- 첫 커밋과 뼈대는 main에 그대로 하고 원격이 비어 있을 때 한 번에 push한다(뼈대를 같이 만들면 첫 커밋만 push하고 뼈대는 PR로). 그 뒤로는 브랜치와 PR이다. PR 관리 일은 `harness-team:pr-review`.

## 순서

1. 프로젝트가 git 저장소인지 본다. 아니면 사용자에게 묻고 `git init` 한다. 폴더가 아직 없으면 위 "새 프로젝트"로 한다.
2. 미리 본다.

   ```
   node <dev-wiki>/_harness/apply.mjs <프로젝트> --profile personal --dry-run
   ```

   `!`로 시작하는 줄은 스크립트가 건드리지 않은 것이다(이미 다른 `core.hooksPath` 등). 합칠 방법을 정해 보고한다.
3. 같은 명령에서 `--dry-run`을 빼고 돌린다.
4. 채운다. 프로젝트 문서에서 알 수 있으면 묻지 않는다.
   - `AGENTS.md` 한 줄 소개.
   - "값" 표의 확인 명령: 이 프로젝트에서 실제로 돌려서 통과하는 명령으로 쓴다(테스트, 빌드, 린트 등). 없으면 "없음".
   - 이미 있는 문서는 역할(목표와 범위, 할 일, 구조 지도, 시스템, 결정)에 맞춰 "먼저 읽을 것"에 연결한다. 새로 만든 틀과 같은 역할의 문서가 이미 있으면 새 틀을 지우고 그 문서를 가리킨다.
   - unity 묶음: "값" 표의 `Unity 프로젝트`는 Unity 프로젝트 폴더(저장소 루트면 `.`, 하위 폴더면 상대 경로), `확인 씬`은 플레이로 확인할 때 여는 씬 경로다. 하위 폴더면 apply가 `.gitignore`의 `/` 패턴이 저장소 루트 기준이라고 알린다. 그 줄을 하위 폴더 경로로 고친다.
   - unity 묶음: apply가 `com.unity.pipeline`이 없거나 0.10 아래라고 알리면(`!`) 그대로 보고한다. `unity pipeline install`이나 `upgrade`는 사용자가 정한다. CRLF로 커밋된 파일이 있다고 알리면 `git add --renormalize .`를 따로 한 커밋으로 하자고 제안만 한다(파일이 많이 바뀐다).
   - standard: 새로 만든 개요의 "미정"에는 apply가 묶음의 구조 결정 목록(의존 방식 등, 묶음 폴더의 `decisions.md`)을 넣는다. 개요가 이미 있으면 apply가 `!`로 문서에 안 보이는 이름을 알린다. 그중 이미 정한 것(코드나 문서에서 보이는 것)은 빼고 나머지만 "미정"에 더한다. 그리고 지금 정할지 묻는다. 정하면 grilling으로, 미루면 그대로 둔다(그 항목에 기대는 일을 시작할 때 묻는다).
   - 이미 있던 `CLAUDE.md`에 내용이 있으면(apply가 `!`로 알린다) AGENTS.md로 옮기고 `@AGENTS.md`만 남긴다. Codex는 CLAUDE.md를 읽지 않고, standard는 커밋 전 검사가 막는다.
5. 옛 구조(dev-flow)에서 옮길 때만:
   - `AGENTS.md`(또는 `CLAUDE.local.md`)의 `<!-- dev-flow:start -->` ~ `<!-- dev-flow:end -->` 절을 지운다. 묶음 규칙이 대신한다. "작업 흐름 값" 표에서 남길 값은 "값" 표로 옮기고 표를 지운다(Unity 프로젝트의 확인 씬은 `확인 씬` 행으로, 확인 방식과 콘솔 검사 행은 옮기지 않는다).
   - `.githooks/`의 옛 `check_docs.py`, `check_code.py`를 지운다. 검사는 플러그인이 한다. `forbidden.txt`는 그 안에 적은 파일이 `.gitignore`나 `.git/info/exclude`에 있는지 보고 지운다(없으면 옮기고 지운다).
   - `.claude/hooks/`의 dev-flow 사본(`bash_guard.py`)과 `.claude/settings.local.json`의 그 등록을 지운다.
   - 수백 줄짜리 개요가 있으면 나누는 안만 제안한다: 시스템마다 `docs/systems/<system>.md`, 되돌리기 어려운 결정은 `docs/adr/NNNN-<slug>.md`, 버린 표현은 GLOSSARY.md `_Avoid_`, 할 일과 진행 상황은 `docs/tasks.md`, 옛 전체본은 `docs/archive/`. 사용자가 승인하면 나눈다.
   - 옛 `docs/decisions.md`와 `docs/retired.txt`는 그대로 둬도 검사가 기록 문서와 버린 표현으로 읽는다. 옮기는 것은 사용자가 원할 때만 한다.
6. 점검한다: `python .githooks/harness_checks.py --all`. 나온 줄은 이번에 고치지 않고 보고한다(그 문서를 나중에 커밋할 때 검사가 막으므로 그때 고친다).
7. 만든 파일과 바꾼 파일을 한 커밋으로 넣는다(`chore(harness): <묶음> 적용`). 훅은 apply 끝 안내의 `git add --chmod=+x ...`으로 넣는다(pre-merge-commit은 충돌 없는 merge 커밋에 같은 검사를 돌린다. Windows는 실행 비트를 기록하지 않아 다른 OS 클론에서 훅이 조용히 무시된다). `core.hooksPath`는 클론마다 설정이라 다른 클론에서는 `git config core.hooksPath .githooks`를 한 번 한다.
8. 보고: 켠 묶음과 버전, 만든 파일, 건드리지 않은 것(`!` 줄), "미정"에 남은 구조 결정, 남은 일. 플러그인 규칙은 새 세션부터 들어간다고 알린다.

## 묶음을 고친 뒤

묶음 원본을 고치고 `release.mjs`로 올리면 플러그인을 켠 모든 프로젝트가 다음 세션부터 새 규칙과 검사를 쓴다. 다시 적용할 일은 연결 파일(`managed/`)이나 "값" 표 행이 바뀌었을 때뿐이다. 그때 이 스킬로 다시 돌린다. 프로필을 주지 않으면 프로젝트에 켜진 harness 묶음을 따른다. 묶음을 더하거나 뺄 때만 프로필이나 `--packs`를 준다.
