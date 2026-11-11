## 문서 구조 (문서 수준 standard)

| 종류 | 파일 |
|---|---|
| 현재 상태 | `AGENTS.md`(뿌리와 폴더별), `CLAUDE.md`(`@AGENTS.md`만), GLOSSARY.md, `docs/overview.md`, `docs/tasks.md`(생기면), `docs/architecture.md`(생기면), `docs/systems/<system>.md`, `docs/guides/`, 뿌리 `README.md` |
| 진행 중 | `docs/changes/<YYYY-MM-DD>-<slug>/` (proposal.md, tasks.md, design.md) |
| 기록 | `docs/adr/NNNN-<slug>.md`, `docs/changes/archive/`, `docs/archive/`, 첫 줄이 `<!-- doc: log -->`인 문서 |

변경 크기별로 남길 문서:

| 변경 | 문서 |
|---|---|
| 작은 수정(동작 불변) | 없음. 커밋 메시지 |
| 시스템 하나의 동작 변경 | 같은 커밋에서 그 시스템 문서 수정 |
| 여러 시스템에 걸치거나 한 세션에 끝나지 않는 작업 | 시작할 때 `docs/changes/`에 폴더(형식은 그 폴더의 `README.md`). 진행 중에도 동작을 바꾼 커밋마다 시스템 문서를 고친다. 끝나면 archive로 옮긴다 |
| 되돌리기 어려운 결정 | `docs/adr/` |

구조 지도(`docs/architecture.md`)는 처음부터 두지 않는다. 시스템 문서가 둘이 되거나 시스템 경계를 넘는 변경이 처음 생기면 만든다. 코드에서 바로 안 보이는 것만 쓴다: 시스템 사이 경계와 계약, 의존 방향 규칙, 여러 시스템이 같이 따르는 방식(저장, 오류, 시간, 설정 값), 코드와 데이터를 두는 위치 규칙. 시스템 목록은 `docs/systems/`의 파일 목록이라 다시 적지 않는다.

크기와 나누기:

- `AGENTS.md`는 200줄, 뿌리부터 한 폴더까지 합계 32 KiB 아래다(Codex가 거기서 자른다). 한 시스템 경계에만 해당하는 규칙은 그 폴더의 `AGENTS.md`에 쓰고 옆에 `@AGENTS.md` 한 줄짜리 `CLAUDE.md`를 둔다.
- 확인, 배포, 실행 같은 절차가 길어지면 `docs/guides/<할 일>.md`로 뺀다.

커밋 전 검사가 문서의 끊긴 링크와 경로, `_Avoid_` 표현, 제목의 날짜, 크기, 폴더 규칙을 막거나 알린다. 막히면 메시지대로 고친다.
