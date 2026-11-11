---
name: harness-update
description: 하네스와 외부 도구의 갱신을 확인하고, 바뀐 점과 우리 규칙, 스킬에 미치는 영향을 보여 준 뒤 사용자가 고른 것만 갱신한다. 대상은 harness 묶음(dev-wiki 원본과 설치본), Claude 플러그인, npx skills, Orca 스킬, Unity CLI. 세션 시작에 "[harness] 갱신 N개" 알림이 떴을 때, "업데이트 확인", "harness-update", 다른 PC에서 dev-wiki를 pull한 뒤에 쓴다.
---

# harness-update

확인은 `update_check.py`가 하고 아무것도 바꾸지 않는다. 이 스킬은 그 결과로 바뀐 점과 영향을 찾고, 사용자가 고른 것만 갱신한다. 고르지 않은 것은 갱신하지 않는다. 설계: dev-wiki `ai-workflow/harness-design.md` 4절 "외부 갱신".

`<dev-wiki>`는 `claude plugin marketplace list --json`에서 `harness`의 `path`가 가리키는 `_harness`의 부모 폴더다. 확인 스크립트는 `<dev-wiki>/_harness/user/hooks/update_check.py`(아래 `UC`).

## 순서

1. 지금 확인한다: `python UC --now`. 줄마다 `[키] 이름 현재 -> 새 버전 (설치 범위)`와 갱신 명령이 나온다. `!` 줄(받기 실패 등)은 그대로 보고한다.
2. 항목마다 바뀐 점을 모은다. 찾지 못하면 "변경 기록 없음"이라고 쓴다.
   - `harness:`: 설치 버전을 올린 커밋(`git -C <dev-wiki> log -S"\"version\": \"<설치 버전>\"" --format=%h -- _harness/<묶음 폴더>/.claude-plugin/plugin.json`) 뒤의 `git -C <dev-wiki> log --format="%h %s" <그 커밋>.. -- _harness/<묶음 폴더>`
   - `plugin:`: 플러그인 저장소의 CHANGELOG나 릴리스 노트. 확인 스크립트가 받아 둔 캐시는 `~/.claude/harness-update/repos/market-<마켓>.git`(`git show FETCH_HEAD:<플러그인 경로>/CHANGELOG.md`)
   - `skill:`: `python UC --diff <이름>`. `grilling`이 바뀌었으면 개인 복사본(`<dev-wiki>/_harness/user/skills/grilling/SKILL.md`, 바꾼 점은 그 머리에 적혀 있다)에 옮길지 따로 묻는다
   - `orca:`: `orca skills get <이름> --full`과 `~/.agents/skills/<이름>/SKILL.md`의 차이
   - `unity:`: `unity self-update --changelog`
3. 영향을 찾는다. 바뀐 점에 나온 명령, 옵션, 스킬 이름 중 없어지거나 바뀐 것을 우리 쪽에서 grep한다: `<dev-wiki>/_harness/packs/*/rules.md`, `<dev-wiki>/_harness/**/SKILL.md`, `<dev-wiki>/_harness/packs/unity/agent-scripts/`, `<dev-wiki>/ai-workflow/harness-design.md` 5절. 쓰는 곳을 파일:줄로 보고한다. 고치는 것은 dev-wiki 세션에서 한다(프로젝트 세션이면 보고만).
4. 고르게 한다: AskUserQuestion(multiSelect)으로 항목마다 갱신할지 묻는다. 선택지 설명에 바뀐 점 한 줄과 영향 수를 쓴다.
5. 고른 것만 갱신한다.
   - `harness:`, `plugin:`: 마켓마다 `claude plugin marketplace update <마켓>` 한 번, 그 뒤 설치 범위마다 `claude plugin update <id> --scope <범위>`(project, local 범위는 그 프로젝트 폴더에서 돌린다)
   - `skill:`: 확인 결과의 명령(`DISABLE_TELEMETRY=1 npx -y skills add <출처> -g -a codex -s <이름> -y`). 공유 폴더 `~/.agents/skills`만 고쳐 쓰고, `~/.claude/skills`의 링크(junction)가 그곳을 가리킨다. `-a claude-code`와 `npx skills update`는 쓰지 않는다: `~/.claude/skills`에 복사본을 만들고 grilling 원본을 그곳에 깔아 harness-user:grilling과 겹친다. 새로 더한 스킬이면 링크를 `New-Item -ItemType Junction`으로 만든다(grilling은 만들지 않는다)
   - `orca:`: `orca skills update --skill <이름>`
   - `unity:`: `unity self-update -y`
6. 고르지 않은 것은 `python UC --dismiss <키>...`로 그 버전 알림만 끈다(다음 버전이 나오면 다시 알린다).
7. 다시 확인하고(`python UC --now`) 보고한다: 갱신한 것과 버전, 영향을 받는 곳(파일:줄), 남은 것과 실패. 플러그인과 스킬은 새 세션부터 쓰인다고 알린다.

## 프로젝트 안에서 부르면

- unity 묶음을 켠 프로젝트: `unity pipeline list-versions`로 `com.unity.pipeline` 최신 버전을 보고 프로젝트 버전(`Packages/manifest.json`)과 다르면 알린다. 올리기(`unity pipeline upgrade`)는 사용자가 정한다.
- harness-core를 켠 프로젝트: `python .githooks/harness_checks.py --all` 결과의 문제 수를 보고한다. 고치지 않는다.

## 알림

- harness-user 세션 시작 훅이 하루 한 번 뒤에서 확인해 `~/.claude/harness-update.json`에 남기고, 갱신이 있으면 새 세션마다 한 줄로 알린다. 갱신하거나 `--dismiss`하면 사라진다. `HARNESS_UPDATE_CHECK=0`이면 끈다.
- harness-core 세션 시작 훅은 하루 한 번 프로젝트 문서 전체 검사를 돌려 문제가 있으면 한 줄로 알린다. `HARNESS_DOC_CHECK=0`이면 끈다.
