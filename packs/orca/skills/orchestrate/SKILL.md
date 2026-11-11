---
name: orchestrate
description: harness-orca를 켠 프로젝트에서 Orca 공식 orchestration 위에서 여러 worker에게 일을 나눠 맡기고, 결과를 검증해 머지한다. "orchestrate", "오케스트레이션으로", "worker에게 맡겨", 마일스톤 진행이나 재개에 쓴다. worktree를 따로 파서 다른 일을 한 번 맡기는 것(감독하지 않는 넘기기)은 orca-cli로 하고 이 스킬을 쓰지 않는다. 오케스트레이션 값이 비었거나 새 마일스톤을 열 때는 milestone-start부터 한다.
---

# orchestrate (harness-orca)

명령과 절차는 Orca 공식 `orchestration` 스킬이 원본이다. 이 스킬은 공식이 정하지 않은 정책과 공식으로 안 되는 것을 메우는 스크립트만 둔다. 공식과 부딪치면 공식을 따르고, 이 스킬의 고칠 점으로 보고한다. `<이 폴더>`는 이 스킬의 폴더다.

## 시작

1. `orca skills get orchestration`을 읽는다(필요한 참조만 `--reference`). 명령과 플래그는 기억으로 쓰지 않는다. Orca가 갱신되면 공식이 따라 바뀐다.
2. `AGENTS.md` "값" 표의 오케스트레이션 행을 읽는다: coordinator, `worker <역할>`, 병렬 상한, 한도 기준, 사람 승인 지점, 자동 머지 조건, 수정 금지, 산출물 내용 검사. 비었거나 `<`로 시작하는 행이 있으면 멈추고 milestone-start부터 한다. 묶음 기본값으로 메우지 않는다.
3. 진행 중인 마일스톤은 `docs/changes/` 아래 `queue.json`이 있는 폴더다(proposal의 기준 표, tasks.md). 처음 시작할 때는 `node <이 폴더>/../milestone-start/milestone-check.mjs <저장소>`를 플래그 없이 돌려 오류 0을 본다(승인 날짜까지). 오류가 있으면 milestone-start로 돌아간다. 시작한 뒤 task 상태의 원본은 Orca task 목록이다. `queue.json`은 시작 전에 검사한 계획 사본이라 고치지 않는다.
4. 세션의 모델과 effort가 "coordinator" 값과 다르면 한 줄로 바꾸자고 권한다(계획과 판단, 실행 루프가 다를 수 있다).

## 나누기

- task는 worktree 하나에서 끝나는 크기로 쪼갠다. 같은 파일이나 같은 시스템을 건드리는 task는 deps로 순서를 정한다(같은 시스템 문서를 두 브랜치가 고치면 합칠 때 부딪친다). 한 시스템은 한 번에 worker 하나만 고친다.
- task의 Ownership에는 고칠 코드와 함께 그 시스템의 문서를 넣는다. 현재 상태 문서는 동작을 바꾼 커밋마다 고친다(core).
- 한 번에 시작할 수 있는 task가 병렬 상한만큼 되게 쪼갠다. 파일 경계가 겹치면 그 경계를 먼저 나누는 구조 task를 앞에 둔다. lanternkeep에서 대기열을 미리 만든 것만으로는 동시 worker가 약 1.5개 그대로였고, 파일을 나누자 2.0~2.4개로 올랐다.
- task마다 마일스톤 기준(C1, C2 ...) 중 무엇에 기여하는지 적는다. 기여하지 않는 일은 만들지 않고 tasks.md에 남긴다.

## task 명세

공식의 다섯 칸(Target, Change, Constraints, Ownership, Observable acceptance)에 다음을 넣는다.

- **먼저 읽을 것**: Codex worker면 `node <이 폴더>/rule-files.mjs`가 낸 규칙 파일 경로와 `<harness-묶음>` 폴더 값. Codex는 하네스 주입을 받지 못한다. Claude worker는 프로젝트 플러그인으로 받는다.
- **확인**: "값" 표 확인 명령 중 바꾼 범위의 것. 전체 확인은 coordinator가 머지 전에 한다(병렬 worker가 전체 테스트를 같이 돌리면 서로 느려지고 시간이 넘친다).
- **수정 금지**: "값" 표의 수정 금지와 이 task 범위 밖.
- **기본 조건**: 아래는 프로젝트와 무관하게 넣는다. deskpet, AoGD, lanternkeep에서 자동 확인을 통과한 결함에서 나왔다.
  - 완료 기준이 "화면에 보인다"면 저장된 값이 아니라 그려진 것(보임, 위치, 크기, 정렬)을 단언한다.
  - 외부 프로그램이나 데이터의 가짜는 실제 출력 한 건을 떠서 실제 모양과 규모를 따른다.
  - 사용자 데이터를 다루면 실제 데이터 사본으로 도는 확인을 하나 둔다.
  - 문구나 표 같은 데이터를 만들거나 고치는 task는 사람이 읽을 전후 표를 낸다.
  - 설치나 링크 경로로 도는 도구는 그 경로로 돌려 본다.
  - 원인 조사 task는 "재현 조건, 증거, 배제한 가설을 남김"으로 끝난다. 원인 확정을 완료 조건으로 두지 않는다.
  - 여러 곳이 쓰는 함수나 형식을 바꾸면 그것을 쓰는 테스트를 저장소 전체에서 찾아 돌리고, 범위 밖이 깨지면 고치지 말고 보고한다.
  - 저장 형식의 의미(순서, 기본값)를 바꾸면 이미 저장된 옛 데이터가 새 규칙에서 어떻게 읽히는지 적는다.
  - 확인 명령과 커밋은 `&&`로 잇는다(`;`면 실패한 채 커밋된다).

## worker 고르기

- `node <이 폴더>/route-worker.mjs --role <역할> --json`으로 정한다. 후보와 한도 기준은 "값" 표에서 읽고, 앞 후보의 한도가 기준을 넘었으면 다음 후보를 낸다. 결과의 agent, model, effort를 그대로 넘긴다(model이 null이면 넘기지 않아 그 agent의 기본값을 쓴다).
- `waitUntil`이 있으면 `node <이 폴더>/wait-reset.mjs --until <waitUntil>`을 백그라운드로 띄우고 깬 뒤 시작한다. agent가 null이면(모든 후보가 한도) 사용자에게 묻는다.
- 이미 도는 worker는 바꾸지 않는다. 한도로 멈춘 worker는 공식 복구 절차로 멈춘 것을 확인한 뒤, 다음 후보로 같은 worktree에서 이어 받는다. 이어 받는 worker에게는 "커밋 안 된 변경이 진행분이다. git diff로 읽고 이어서 완성한다"를 보내고, 그 완료 보고는 머지 전에 coordinator가 직접 확인한다.
- 한 task는 세 번까지 보낸다. 셋 다 실패하면 우회 task를 만들지 않고 사용자에게 보고한다.
- 파일을 고치는 worker를 병렬로 돌리면 각자 worktree(`new-child`)에서 돌린다. 읽기만 하는 worker는 공식 기본(`current`)대로.
- worker는 worktree 뿌리에서 시작한다. Codex는 뿌리에서 시작 폴더까지의 AGENTS.md만 읽으므로, task 범위 아래에 따로 AGENTS.md가 있으면 "먼저 읽을 것"에 넣는다.

## 띄우기와 기다리기 (공식에 없는 것)

- 띄우기는 `bash <이 폴더>/start-worker.sh <worker-start 인자들>`로 한다.
  - worker-start 전에 점검한다: agent CLI, Codex `check_for_update_on_startup = false`, `new-child`의 기준 브랜치, 저장소의 `.orca/preflight.sh`.
  - 뜬 뒤에는 화면을 보고 지시문 미제출, 권한 질문, 업데이트 안내를 가려 낸다.
  - 마지막 줄 `DISPATCH <id> <상태>`를 읽는다. 권한 질문은 사용자에게 묻는다(Enter를 보내면 허용이 눌린다).
- worker를 띄우면 `node <이 폴더>/watch-workers.mjs --run <runId>`를 백그라운드로 늘 켜 둔다.
  - 공식 `check --wait`가 깨우지 않는 것에서도 깨운다: 한도 걸림, 시작 막힘, 화면이 오래 그대로, heartbeat 끊김.
  - 깨면 공식 절차로 들여다보고 처리한다. watcher 알림은 들여다볼 신호일 뿐, 중지나 재시도의 근거가 아니다.
  - 메모리가 모자라면 watcher를 끄지 말고 worker 수를 줄인다. lanternkeep M4에서 watcher를 끈 동안 완료 3건이 2시간 처리되지 않았다.
  - DeskPet 알림을 쓰면 `--notify-deskpet "<명령>"`을 더한다.
- coordinator가 직접 돌리는 테스트와 빌드는 `node <이 폴더>/run-summarized.mjs -- <명령...>`으로 감싸 요약만 읽는다. 실패했을 때만 로그의 해당 부분을 읽는다.

## 리뷰와 머지

- worker의 완료 보고를 믿지 않는다. 머지 전에 coordinator가 깨끗한 worktree에서 "값" 표의 확인 명령 전체를 한 번 돌린다. lanternkeep에서 worker 환경에서는 통과한 무작위 실패를 여기서 잡았다. 겹치지 않는 브랜치는 합쳐서 한 번에 확인해도 된다.
- 자동 머지는 "값" 표의 자동 머지 조건을 다 만족할 때만 한다. 수정 금지나 확인 필요 영역을 건드렸으면 사람에게 묻는다(공식 gate).
- R 기준(에이전트 리뷰)과 사람 확인 직전의 화면 판독은 `worker 리뷰` 행의 worker가 새 컨텍스트에서 한다.
  - 리뷰 worker에게는 기준, diff, 재현 명령(확인 명령, 캡처 명령)만 주고, 확인과 캡처는 리뷰 worker가 직접 돌린다. coordinator의 판단과 구현 worker의 완료 보고(worker_done 요약)는 주지 않는다. 남이 낸 결론과 고른 증거를 받으면 그 결론을 따라 읽게 된다.
  - 일 덩어리마다 리뷰 worker를 두지 않는다.
- 리뷰에서 나온 문제는 고칠 task를 새로 만들어 보낸다. coordinator가 직접 고치지 않는다(공식).
- 머지하고 release한 worker의 worktree는 머지를 확인(`git merge-base --is-ancestor`)한 뒤 지운다. 세션을 마치기 전에 `git worktree list`에 main과 진행 중인 것만 남았는지 본다.

## 진행 기록과 보고

- 진행은 마일스톤 폴더의 tasks.md에 체크한다. 결정이 필요한 것은 개요 "미정"이나 tasks.md에, 사람이 볼 것은 `(사용자 확인)`으로 쓴다. 따로 상태 문서를 두지 않는다.
- 마일스톤마다 새 세션으로 시작한다. coordinator가 긴 운영 컨텍스트를 매번 다시 읽는 것이 비용의 대부분이었다(deskpet, AoGD: 입력 토큰의 62~63%가 coordinator).
- 보고에 쓸 것:
  - 머지한 변경(task마다 한 줄)과 채운 기준
  - 실패하거나 막힌 task와 이유
  - 사람 확인 대기와 결정 대기
  - 한도와 운영 문제
- 마일스톤이 끝나면 기준 표를 다시 본다. A, R 기준이 다 통과하고 H 기준이 사람 확인을 받으면 폴더를 `docs/changes/archive/`로 옮긴다(core 큰 변경 규칙).
- 엔진별 병렬 함정(Unity의 batchmode, 프로세스 종료, `.meta`)은 그 묶음 규칙에 있다.
