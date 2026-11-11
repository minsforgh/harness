## 팀 저장소

- 커밋하기 전에 `git config core.hooksPath`가 `.githooks`인지 본다. 아니면 커밋하지 않고 사용자에게 `docs/SETUP.md`를 하라고 알린다(훅이 없으면 main push 막기와 문서 검사가 돌지 않는다).
- 작업은 브랜치 `<시스템>/<작업>`(예: `combat/dash`)에서 한다. 만들기 전에 `git fetch`로 같은 `<시스템>/`의 원격 브랜치가 있는지 보고, 있으면 사용자에게 알린다(누가 그 시스템을 고치고 있다). 만들면 바로 push한다. 원격 브랜치가 작업 중이라는 표시다.
- main에 직접 커밋하거나 push하지 않는다. main에는 GitHub PR로만 들어간다(`.githooks/pre-push`가 main push를 막는다).
- PR 하나에 목표 하나. 본문은 `.github/pull_request_template.md`의 세 칸(확인한 것, 직접 볼 것, 확인 못 한 것)을 채운다. 확인한 것은 돌린 명령과 실제 값(테스트 통과/전체, 콘솔 오류 수)으로 쓰고, 화면이 바뀌었으면 스크린샷을 붙인다.
- 할 일과 진행 상황은 팀이 쓰는 곳에 둔다. 저장소에 할 일 목록(`docs/tasks.md`)을 만들지 않는다. 큰 변경(`docs/changes/`)의 할 일만 그 폴더의 `tasks.md`에 두고 체크해 남긴다.
- PR을 올리기 전에 바꾼 범위의 테스트를 돌린다: `unity test <절대 경로> --affected --since origin/main --output <저장소 밖 경로>`. 전체 테스트는 PR 관리자가 머지 묶음을 마칠 때 돌린다. `Total` 0은 통과가 아니다(필터가 틀려도 0개로 성공한다).
- 시스템마다 `Assets/<시스템>/` 폴더 하나에 코드와 어셈블리(`<게임>.<시스템>`), `Prefabs/`, `Data/`, 에디터 코드(`Editor/`의 `<게임>.<시스템>.Editor`), 테스트(`Tests/`의 `<게임>.<시스템>.Tests`)를 둔다. 여러 시스템이 같이 쓰는 아트, 사운드, 게임 씬은 처음부터 있는 공용 폴더(`docs/architecture.md` "두는 위치")에 둔다. 시스템 이름은 Unity 특별 폴더 이름(`Editor`, `Resources`, `Plugins`, `StreamingAssets`, `Gizmos`)과 겹치지 않게 짓는다. 다른 시스템을 새로 참조하면 `docs/architecture.md`의 의존 방향과 맞는지 PR에 쓴다.
- 씬에는 prefab 인스턴스의 배치와 씬 고유 설정(카메라, 조명)만 둔다. 내용은 시스템이나 구역 prefab에 두고, 씬에서 바꾼 인스턴스 값은 배치와 씬 안 참조가 아니면 prefab에 Apply한다(씬에 쌓인 값은 그 씬을 고치는 모두와 충돌한다).
- 씬을 저장하는 작업을 시작하기 전에 사람이 팀에 알렸는지 묻는다. 같은 씬을 고치는 사람이 있으면 순서대로 한다. 씬에 고정 담당은 두지 않는다.
- 확인은 실제 게임 씬에서 한다. 원하는 상황까지 오래 걸리면 테스트 씬 대신 그 상황으로 바로 가는 디버그 명령을 시스템에 만든다(사람과 에이전트가 같은 명령을 쓴다). 테스트 씬은 실제 씬에서 확인할 수 없을 때만 만들고, 이유를 PR에 쓰고 `Assets/<시스템>/Scenes/`에 둔다(빌드 씬 목록에는 넣지 않는다).
- 공식 스킬이 권해도 `unity vcs merge-setup`은 쓰지 않는다. 그 merge 드라이버는 같은 prefab 인스턴스 값을 양쪽이 고친 merge를 git 충돌 없이 커밋하고 항목을 둘 남긴다(Unity는 마지막 것을 읽어 한쪽 값이 조용히 정해진다).
- main을 합치다 씬, prefab, `.asset` 파일이 충돌하면 직접 풀지 않고 PR에 적어 PR 관리자에게 넘긴다. 파일을 통째로 한쪽으로 고르지 않는다(`git checkout --ours`/`--theirs`, `unity vcs resolve --ours`/`--theirs`). 상대가 같은 파일에서 바꾼 다른 값도 사라진다.
- 예외: 폴더 `.meta`(`folderAsset: yes`)만 add/add로 충돌하면(둘이 같은 폴더를 따로 만들어 GUID가 다르다) main 쪽을 고른다: `git checkout --theirs -- <파일>`(main을 합치는 중이면 theirs가 main). 고르기 전에 버리는 쪽 GUID를 `git grep`으로 찾아 쓰는 곳이 있으면 PR 관리자에게 넘긴다.
- 공식 `unity vcs hooks install`은 쓰지 않는다. `.githooks/pre-commit`에 설치한 사람 PC의 `unity.exe` 절대 경로를 적어 다른 PC에서 깨진다.
- Codex 샌드박스 안에서 `unity`가 안 보이거나 에디터에 붙지 못하면 샌드박스 밖 실행을 요청한다(확인 명령은 `.codex/rules/`에 샌드박스 밖 승인 생략으로 있고, 폴더를 신뢰해야 읽힌다). 확인을 건너뛰고 통과라고 쓰지 않는다.
