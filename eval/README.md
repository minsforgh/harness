# eval

하네스가 효과가 있는지 기록으로 잰다(harness-design 원칙 5, 7절). 에이전트 보고는 근거로 쓰지 않는다. 프로젝트 하나의 Claude와 Codex 대화 기록, Unity `Library/Pipeline/eval-usage.jsonl`, git을 읽기만 한다.

## 돌리기

```
python <dev-wiki>/_harness/eval/run.py <프로젝트> [--since 2026-11-07T23:50] [--until 2026-11-08T21:11]
python <dev-wiki>/_harness/eval/run.py <프로젝트> --compare <dev-wiki>/_harness/eval/baseline/maxwelldemon.json \
       --out <dev-wiki>/_harness/eval/results/<프로젝트>-<날짜>.json
```

- 시각은 로컬 시각. 결과의 `window`에는 UTC(`since_utc`, `until_utc`)도 남는다(다른 시간대 PC에서 다시 셀 때). 하네스를 중간에 적용한 프로젝트는 `--since`를 적용 커밋 시각으로 준다(`git log --grep "chore(harness)" --reverse --format=%cI | head -1`)
- 부르는 곳: 손으로, 그리고 vault `project-wrapup`(프로젝트 끝, 하겠다고 고를 때만). 묶음(프로필)의 훅이나 스킬은 부르지 않는다
- `--json`은 결과 전체를 출력, `--out`은 파일로 저장(그 파일에 이미 적힌 `judged`는 남긴다), `--transcripts <폴더>`는 대화 기록 폴더를, `--codex <폴더>`는 Codex sessions 폴더를 직접 준다(시험용. `--transcripts`만 주면 Codex는 보지 않는다)
- Codex 기록: `~/.codex`, Orca의 Codex 홈(`<APPDATA>/orca/codex-runtime-home/home`), `CODEX_HOME`의 `sessions/`. `session_meta`의 cwd가 이 저장소나 지금 있는 worktree 안인 세션을 읽는다. cwd가 지금 없으면(지운 worktree) `session_meta.git`의 시작 커밋이 이 저장소에 있고, 원격 주소가 적혀 있으면 같을 때만 읽는다(`sources.codex_recovered`). Claude 기록은 지운 worktree의 것이 빠진다
- Codex는 도구 호출이 `exec`(JS 코드) 하나에 들어 있다. `exec` 하나를 명령 하나로 보고, 분류에는 `exec_command`의 `cmd` 글자만 쓴다(글자가 없으면 patch 본문을 뺀 코드. patch 안의 `git commit` 같은 글자로 커밋이나 확인이 되지 않게). `apply_patch`가 고친 파일은 파일마다 수정 하나다. patch만 한 `exec`가 실패하면 실패로 세고 코드 수정으로는 세지 않는다. `sleep` 도구는 sleep으로 세되 같은 확인 반복으로는 세지 않는다. 오래 걸려 셀로 돌아온 `exec`의 결과는 그 셀을 기다린 `wait` 출력으로 본다. 실패는 `Script failed`, `aborted by user`, 또는 줄 맨 앞에서 여는 JSON의 `exit_code`가 0이 아닌 것(음수 포함. 출력에 섞인 파일 내용 속 `exit_code`는 보지 않는다)
- **Claude와 Codex는 따로 센다.** 위쪽 지표(도구 시간, 확인, 커밋, 후보)는 Claude 세션만이라 기준선과 같은 뜻이다. Codex는 결과의 `codex`에 같은 지표를 따로 둔다. Codex worker는 Claude와 병렬로 돌아 도구 시간이 겹치므로 둘을 더하지 않는다. 사용자 메시지는 조각(`input_text`)마다 보고 AGENTS 안내와 환경 정보 조각만 뺀다

## 비교하는 법

- **같은 국면끼리 비교한다.** 구현 초반(feat 위주, 플레이 확인 적음)과 마감(fix와 플레이테스트)은 확인 방식과 fix 비율이 국면만으로 다르다. 기준선은 POC 마감 국면이다
- **기준선은 "하네스 없음"이 아니다.** MaxwellDemon 창에는 옛 하네스(dev-flow v1: AGENTS.md 작업 흐름 값, 보고 첫 줄의 확인 방식, 옛 bash_guard의 sleep 막기)가 있었다. 비교는 "새 하네스와 옛 하네스"다. 세션 2개, 하루라 한 번의 비교로 효과라고 말하지 않는다
- 창 길이에 비례하는 수(호출, sleep, 플레이 진입, 캡처, 압축)는 도구 시간당(`per_hour`)으로 비교한다
- 비용 지표는 결과 지표와 짝으로 본다. 확인 시간이 줄었어도 판정한 새어 나간 버그가 늘었으면 나아진 것이 아니다
- 비교 표에는 비율, 시간당 수, 사람의 판정(`judged`)만 올린다. 후보 수는 헛짚음이 섞여 올리지 않는다
- `wrapper_unknown`이 0이 아니면 확인 수치를 덜 믿는다(내용을 모르는 래퍼 안의 플레이, 캡처, sleep은 세지 못했다)

## 세는 것

기계 지표는 같은 기록과 파일이면 다시 돌려도 같다(디스크에서 읽은 래퍼는 지금 내용이다).

| 묶음 | 지표 | 세는 법 | 좋은 쪽 |
|---|---|---|---|
| 확인 비용 | 확인 분과 비율, 호출, sleep, 플레이 진입, 캡처 | 도구 호출마다 다음 일까지의 간격(300초 상한, 사용자를 기다린 간격은 뺌). 확인 = unity 플레이, 캡처, 콘솔, 컴파일, 테스트, 읽기, 입력 명령이나 sleep이나 AGENTS.md "확인 명령". 권한 거부나 훅에 막혀 돌지 않은 명령의 sleep과 플레이는 세지 않는다. `Start-Sleep -Milliseconds`도 센다 | 비율은 낮게(새어 나간 버그와 짝), 시간당 sleep, 플레이, 캡처는 낮게 |
| | eval만 부른 호출, eval을 섞은 확인 | `script eval/run`만 부른 호출은 확인과 따로(`script_minutes`). 한 호출에 eval과 확인 명령을 섞으면 확인으로 세고 `eval_mixed`로도 센다 | 참고 |
| | 수정 없이 같은 확인 반복 | 같은 명령을 다시 돌렸는데 그 사이에 코드, 문서, 에셋 수정이 없었던 수 | 낮게 |
| | 래퍼 | 명령이 실행한 스크립트(`bash x.sh`, `./x.sh`, `python x.py` 등. `git add x.sh`, `cat x.sh`는 실행이 아니다). 대화 기록 전체(창 밖 포함)에서 그 호출 전에 Write로 쓴 마지막 내용, 없으면 디스크의 셸 스크립트를 읽는다. 끝내 모르면 `wrapper_unknown` | `wrapper_unknown` 0 |
| 커밋 | 코드를 고친 뒤 커밋, 그중 컴파일/콘솔/테스트 없이, 그중 플레이와 캡처와 읽기로만 본 것, 마지막 확인이 오류 | 대화 기록의 `git commit`. 프로젝트(worktree 포함) 안 파일을 고친 뒤의 커밋만. 마지막 확인 결과(글 전체)에 오류 수가 있으면 "오류" | 비율 낮게 |
| | 에셋만 고친 뒤 커밋, 그중 아무 확인 없이 | unity 명령으로 씬, 프리팹, 에셋만 바꾼 뒤의 커밋. 컴파일은 상관없고 어떤 확인이든 봤는지 | 비율 낮게 |
| 컨텍스트 | 압축 수 | `compact_boundary` | 시간당 낮게 |
| 파일 고치기 | 프로젝트 파일 Edit 수와 새 글 양, 있는 파일을 Write로 통째 다시 쓴 수와 글자(`tools.file_edits`) | Write 결과가 "File created"가 아니면 있는 파일. 새 파일과 실패한 Write는 뺌. Codex의 apply_patch는 Edit로 셈 | 통째 비율 낮게 |
| dev-wiki 원본 | 프로젝트 세션이 dev-wiki를 고친 수, 커밋 수 | 링크(junction)를 거친 수정도 원본으로 | 낮게 |
| 에이전트와 effort | `agent:model:effort`마다 세션, 호출, 분, 확인 호출, 실패(`agents.by_agent_effort`, 값 표 worker 후보와 같은 형식)와 세션마다 호출, 분, agent 목록(`agents.sessions`, 대화 글은 넣지 않음). Claude와 Codex를 합친 유일한 열 | Claude는 줄마다 `effort`와 `message.model`, Codex는 그 턴의 `turn_context` | 비교하지 않는다. effort를 바꾼 효과는 `agents.sessions`에서 같은 일을 한 세션끼리 골라 결과 지표와 짝으로 본다 |
| 도구 실패 | 도구마다, 종류마다(`command` 명령 실패, `tool_use` 도구 절차, `permission` 권한 거부, `blocked` 막힘, `user_rejected` 사용자가 거절) | `is_error`가 붙은 결과의 글 | `command`, `tool_use` 낮게. `blocked`는 훅이 일한 것이라 참고 |
| eval 사용 | 수, 여러 문장 비율, 실패 비율, 리플렉션 NonPublic, Find류, 읽지 못한 줄 | eval-usage.jsonl | 비율 낮게 |
| git | 커밋 종류, fix 비율, fix 중 테스트 파일을 함께 바꾼 수와 새 테스트 파일을 더한 수 | `git log --name-status` | fix 비율은 참고(국면), 테스트는 높게 |
| 하네스 운용 | `(사용자 확인)` 더함과 지움, 닫은 구조 결정 | tasks.md 차이, 개요 "미정"에서 커밋마다 지운 `정할 때:` 줄에서 다시 넣은 줄을 뺀 수 | 하네스가 들인 관례라 기준선에는 없다. 비교하지 않고 쓰이는지만 본다 |

## 후보 (판정은 사람이 한다)

판단이 필요한 것은 근거 위치(시각, 세션 앞 8자, 걸린 말, 글 앞부분)와 함께 후보만 뽑는다. 글자 맞추기라 헛짚는 것이 섞인다. 사람이 보고 맞는 것의 수를 결과 파일 `judged`(`leaked_bugs`, `claims_without_check`)에 적으면 비교 표에 그 수가 올라간다.

| 후보 | 뽑는 법 | 보는 것 |
|---|---|---|
| 끝났다고 한 뒤 사용자가 문제를 말함 | 완료류 말 바로 다음 사용자 글에 문제류 말(슬래시 명령은 사람 말로 보지 않는다) | 새어 나간 버그인지(설계 질문이면 헛짚음), 그 뒤 회귀 확인을 더했는지 |
| 확인했다고 했는데 그 턴에 확인 호출 없음 | 턴 마지막 글에 확인류 말, 그 턴에 확인이나 eval 호출 없음 | 말과 실제의 차이인지(코드를 읽어 답한 것, 지난 턴의 확인을 말한 것은 헛짚음) |
| "미정"을 말함 | 에이전트 글에 "미정" | 구조 결정에 기대는 일 전에 물었는지(Q104) |
| 확인 실패 뒤 테스트 파일을 고침 | 확인이 실패한 턴에 테스트 경로 수정 | 기준을 바꿔 통과시켰는지(Q101) |

## 한계

- 셸로 만든 래퍼(`cat > x.sh`)는 디스크에 남아 있을 때만 내용을 본다. 파이썬 도구는 디스크에서 읽지 않는다(글 안의 unity 낱말이 섞인다)
- 래퍼 안의 반복(`while ... sleep 2`)은 한 번으로 센다
- 시간은 "다음 일까지의 간격"이라 도구 결과를 읽고 다음 글을 쓰는 모델 시간도 그 도구 쪽에 붙는다
- 새어 나간 버그 후보는 완료 말 바로 다음 사용자 글만 본다. 몇 턴 뒤나 다음 세션에서 말한 버그는 놓친다
- 하위 에이전트(sidechain)는 뺀다. 같은 줄을 다시 담은 이어 간 세션은 uuid로 한 번만 센다
- `eval-usage.jsonl`은 `Library/` 안이라 지우면 다시 셀 수 없다
- 스크립트를 고치면 기준선도 같은 버전으로 다시 센다

## 파일

- `run.py`: 평가 스크립트. 시험은 `tests/run.mjs`의 eval 항목(만든 대화 기록, eval 기록, git)
- `baseline/maxwelldemon.json`: 기준선(MaxwellDemon 2026-11-07 23:50 ~ 11-08 21:11, 옛 하네스 dev-flow v1, POC 마감 국면). 수치 요약은 harness-design 7절. 공개 저장소에는 넣지 않았다(대화 글 조각과 로컬 경로가 들어 있다). 비교 기준 수치는 README "개선 사이클"에 옮겼다
- `results/`: 프로젝트마다 결과(`<프로젝트>-<날짜>.json`). 대화 글 앞부분이 들어 있다. 공개 저장소에는 넣지 않는다
