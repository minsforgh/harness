## 문서 구조 (문서 수준 light)

짧게 끝내는 프로젝트(POC 등)라 문서를 가볍게 둔다. 제작으로 넘어가면 "값" 표의 문서 수준을 standard로 바꾸고 harness-apply를 다시 돌린다.

| 종류 | 파일 |
|---|---|
| 현재 상태 | `AGENTS.md`, `CLAUDE.md`(`@AGENTS.md`만), GLOSSARY.md(생기면), `docs/overview.md`, `docs/tasks.md`(생기면), `docs/systems/<system>.md`(있는 시스템만) |
| 기록 | `docs/adr/NNNN-<slug>.md`(생기면), `docs/archive/`, 첫 줄이 `<!-- doc: log -->`인 문서 |

- 진행 중 문서(`docs/changes/`)와 구조 지도는 두지 않는다. 큰 작업도 커밋 메시지, `docs/tasks.md`, 시스템 문서로 남긴다.
- 예외: 오케스트레이션(harness-orca)의 마일스톤 폴더는 light에서도 `docs/changes/<YYYY-MM-DD>-<slug>/`에 둔다. worker에게 나눠 줄 기준과 대기열을 담는 곳이라 커밋 메시지로 대신하지 못한다. 검사는 standard의 진행 중 문서와 같다(링크와 경로만).
- 시스템이 하나뿐이거나 작으면 개요에 같이 써도 된다. 300줄이 넘으면 시스템 문서로 나눈다. 시스템 문서의 "구조" 절은 필요 없으면 지운다.
- `AGENTS.md`는 200줄, 다른 현재 상태 문서는 500줄이나 4만 자를 넘기지 않는다.

커밋 전 검사(충돌 없는 merge 커밋도 같다): 끊긴 링크와 경로와 줄 번호(대소문자가 실제 이름과 다른 것 포함), 크기, 현재 상태 문서 자리의 기록 표시만 막는다. `_Avoid_` 표현, 제목의 날짜, ADR 파일 이름, 폴더 규칙, CLAUDE.md의 @ 줄 밖 내용은 알리기만 한다.
