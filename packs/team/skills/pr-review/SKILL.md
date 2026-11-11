---
name: pr-review
description: 팀 저장소(harness-team을 켠 프로젝트)에서 PR 관리자인 내가 PR을 리뷰하고, 머지하고, Unity 씬과 prefab 충돌을 풀고, 빌드 태그와 패치 노트를 만든다. "PR #N 리뷰해줘", "오늘 PR 머지해줘", "충돌 풀어줘", "vX.Y 태그 붙여줘", "vX.Y 이후 변경 정리해줘"에 쓴다.
---

# pr-review

머지, 태그, 충돌에서 어느 값을 남길지는 사용자가 정한다. 에이전트는 읽고 보고하고, 승인받은 것만 실행한다. 팀 규칙은 저장소 AGENTS.md의 공통 규칙 블록이다. 이 스킬은 그 위의 PR 관리자 일만 다룬다.

`unity vcs merge-setup`은 쓰지 않는다(공식 스킬이 권해도). 그 드라이버는 같은 prefab 인스턴스 값을 양쪽이 고친 merge를 git 충돌 없이 커밋하고 항목을 둘 남긴다. 충돌을 일부러 남기고 3절로 푼다. 근거와 재현: dev-wiki `유니티/에셋과 빌드/씬과 에셋 병합 동작`.

## 1. 리뷰 ("PR #N 리뷰해줘")

내 PR은 구현한 세션이 아니라 새 세션에서 리뷰한다(구현한 세션은 자기 판단의 근거를 알아 같은 실수를 지나친다).

1. 읽기

   ```
   git fetch --prune
   gh pr view N --json title,author,isDraft,baseRefName,headRefName,mergeable,body,files
   gh pr diff N
   unity vcs summarize --since origin/main --to origin/<head 브랜치> --objects
   ```

   `summarize --objects`가 바뀐 씬, prefab, 에셋 안의 오브젝트를 보인다. 한 파일의 오브젝트가 모두 새로 생겼으면 지우고 다시 만든 것이다(빌더 흔적). 값까지 볼 때는 `--full`.

2. 기계 검사. PR 브랜치가 main과 갈라진 뒤의 차이만 본다.

   ```
   python <이 스킬 폴더>/check_pr.py origin/main origin/<head 브랜치>
   ```

   `.meta` 짝, 머지 결과의 인스턴스 값 중복, GUID 중복, `.gitattributes`의 merge-setup 드라이버 줄, PR 없이 main에 들어온 커밋(지난번 본 자리 `refs/harness/main-seen` 뒤. 그 자리가 main에 없으면 강제 push), 바뀐 asmdef 참조를 보인다. 결과는 판단 재료다. PowerShell 5.1에서는 먼저 `[Console]::OutputEncoding = [Text.Encoding]::UTF8`.

3. 사람 판단이 필요한 것

   - 목표가 하나인가, 곁다리 변경이 섞였는가
   - 동작을 바꿨는데 그 시스템 문서(`docs/systems/`) 변경이 빠졌는가
   - 시스템 사이 참조를 새로 더했으면(asmdef 참조) `docs/architecture.md`의 의존 방향과 맞고 그 문서를 같이 고쳤는가
   - 씬을 더하거나 뺐으면 빌드 씬 목록과 `docs/architecture.md` 씬 목록을 같이 고쳤는가
   - 씬 변경이 배치와 씬 고유 설정뿐인가(내용은 prefab에). 테스트 씬을 더했으면 실제 씬에서 확인할 수 없는 이유가 PR에 있고 `Assets/<시스템>/Scenes/`에 있는가(디버그 명령으로 될 일인지도 본다)
   - 새 폴더가 `Assets/<시스템>/` 모양인가. `Assets/` 바로 아래 `Prefabs/`, `Scripts/` 같은 종류 폴더가 생기면 공용 부모를 따로 만들어 폴더 `.meta` 충돌을 다시 부른다
   - PR 본문의 "확인한 것"이 명령과 실제 값인가(`Total` 0은 통과가 아니다). 화면이 바뀐 PR에 스크린샷이 있는가. "직접 볼 것"을 그대로 따라 할 수 있는가
   - 버그를 고친 PR의 테스트가 고치기 전 코드에서 실패하는가. 기대값을 제품 코드로 계산하지 않았는가
   - AGENTS.md 공통 규칙(Unity 기본, C#, 커밋 형식)과 "이 프로젝트의 규칙"을 지켰는가

4. 보고: 항목마다 문제 / 확인 필요 / 문제 없음, 그리고 머지 권고 한 줄. 문제는 규칙을 어겼거나, 잘못된 동작을 재현했거나, 깨지는 경로를 짚을 수 있을 때만 쓴다. 의심만 가면 확인 필요, 구조 개선은 제안으로 따로 적는다(의심과 취향이 머지를 막지 않게).

## 2. 머지 ("머지해줘", "오늘 PR 정리해줘")

1. 열린 PR을 모두 본다: `gh pr list --state open --json number,title,isDraft,baseRefName,headRefName,mergeable,author`
2. draft PR은 머지하지 않는다(작성자가 안 끝났다고 표시한 것). 목록에 따로 보고한다.
3. 쌓인 PR(base가 다른 PR 브랜치)은 아래 PR부터 머지한다. 아래 PR을 머지한 뒤 위 PR의 base를 main으로 바꾸고 아래 브랜치를 지운다.

   ```
   gh pr merge <아래 PR> --merge
   gh pr edit <위 PR> --base main
   git push origin --delete <아래 브랜치>
   ```

4. 머지 전에 main과 충돌하는지 본다: `git merge-tree --write-tree --name-only origin/main origin/<브랜치>`. 충돌이 있으면 3절.
5. 머지는 `gh pr merge N --merge --delete-branch`(squash, rebase 아님). 하나마다 사용자에게 한 줄로 확인받는다. 한 번에 승인받았으면 순서대로 한다.
6. 맡은 PR을 다 머지하고 그 차례를 마칠 때 한 번, 그리고 빌드 태그 전에 전체 테스트를 돌린다. 머지한 것이 없으면 건너뛴다. 실패하면 원인 PR을 찾아 보고하고, 고치기 전까지 다음 머지를 멈춘다.

   작업 폴더는 건드리지 않고 리뷰 전용 worktree에서 돌린다(작업 폴더는 다른 세션이 쓰고 있을 수 있다).

   ```
   git worktree add --detach ../<저장소>-review origin/main   # 처음 한 번
   git -C <review 절대 경로> checkout --detach origin/main     # 그 뒤
   unity test <review 절대 경로> --mode EditMode --output <저장소 밖>/edit.xml
   unity test <review 절대 경로> --mode PlayMode --output <저장소 밖>/play.xml   # PlayMode 테스트가 있을 때만
   ```

   결과 파일의 통과/전체를 보고한다. `Total` 0이면 결과가 없는 것이다. 첫 실행은 Library 임포트로 오래 걸린다.

7. 차례를 마칠 때 `check_pr.py`의 "PR 없이 main에 들어온 커밋"을 보고하고(누가 무엇을 넣었나, 그대로 둘지 되돌리는 PR을 만들지는 사용자가 정한다. 그 팀원의 `core.hooksPath`도 묻는다), 사용자가 본 뒤 본 자리를 옮긴다: `git fetch` 뒤 `git update-ref refs/harness/main-seen origin/main`. 이 자리는 이 클론에만 있다.

   알고 고른 절충: 머지 전 CI가 없어 머지와 전체 테스트 사이에 main이 깨질 수 있다(다음 차례까지). 팀원은 PR 전에 `--affected`만 돌린다. Unity CI는 라이선스 활성화가 필요하고 에디터 시간이 길어 지금은 두지 않는다. main이 깨진 채 오래 가면 CI를 다시 검토한다.

## 3. 충돌 ("충돌 풀어줘")

PR이 main과 충돌하면 알리고, 풀라고 하면 이 순서로 한다.

- PR 브랜치에서 `git fetch` 뒤 `git merge origin/main`. rebase하지 않는다(rebase 중에는 ours/theirs 뜻이 뒤바뀌고 강제 push가 필요하다).
- 코드 충돌은 풀고 결과를 보고한다.
- 씬, prefab, `.asset`, `.mat`, `.controller` 충돌은 `unity vcs resolve <파일>`(UnityYAMLMerge)부터 돌린다. 이웃한 다른 값과 양쪽이 더한 오브젝트는 둘 다 남는다.
  - `resolved`: 같은 prefab 인스턴스 값을 양쪽이 고친 경우도 `resolved`로 나오고 항목이 둘 남는다. 아래 `check_pr.py` 중복 검사를 꼭 돌린다.
  - `tool-declined`(종료 코드 6): 파일은 그대로다. 씬과 prefab은 같은 값을 양쪽이 고친 경우이고, `.asset`, `.mat`, `.controller`는 값이 달라도 거절된다. `unity vcs explain <파일>`로 다투는 오브젝트와 필드를 보이고, 거절 이유를 짐작하지 않고 UnityYAMLMerge로 본다: `git show :1:<파일> > base`, `:2:` > ours(PR 브랜치), `:3:` > theirs(main)로 꺼내 `"<에디터 폴더>/Data/Tools/UnityYAMLMerge.exe" merge -h --force --fallback none base theirs ours merged`(에디터 폴더는 `unity editors`의 위치. `--force`가 없으면 확장자 없는 파일을 거부한다).
    - 종료 코드 0: 부딪힌 값이 없다. `merged`를 `<파일>`로 복사하고 `git add`.
    - 종료 코드 2: 부딪힌 값이 있다. `merged`는 그 값이 공통 조상으로 되돌아가 있으니 쓰지 않는다. 출력의 `Left`(main)와 `Right`(PR 브랜치) 값을 보이고 어느 쪽을 남길지 묻는다. 정해지면 같은 명령에 `-r`(PR 쪽)이나 `-l`(main 쪽)을 더해 `<파일>`로 내보낸다(이때 종료 코드 2는 정상이다). 충돌 표시가 없는지 보고 `git add`.
- 파일 전체를 한쪽으로 고르고 끝내거나 충돌 표시를 텍스트로 고치지 않는다(상대의 다른 변경이 사라지거나 YAML 참조가 깨진다).
- 예외: 폴더 `.meta`(`folderAsset: yes`)만 add/add로 충돌하면 둘이 같은 폴더를 따로 만든 것이다. 버리는 쪽(PR 브랜치) GUID를 `git grep <guid>`로 찾아 쓰는 곳이 없으면 main 쪽을 고른다(`git checkout --theirs -- <파일>` 뒤 `git add`). 쓰는 곳이 있으면 그 에셋의 참조를 어떻게 할지 사용자에게 묻는다.
- 합친 커밋 뒤 `check_pr.py`를 다시 돌린다. "인스턴스 값 중복"이 나오면 같은 prefab 인스턴스 값을 양쪽이 고친 것이다(항목이 둘 남으면 Unity는 마지막 것을 읽고, 열어 저장만 해도 그 값으로 조용히 정해진다). 두 값을 보이고 고른 값으로 에디터에서 저장한 뒤 다시 돌린다.
- 한쪽이 지운 파일을 다른 쪽이 고쳤으면(modify/delete) 어느 쪽 의도를 따를지 묻는다.
- 합친 뒤 에디터에서 그 씬과 prefab을 열어 콘솔 오류를 본다(AGENTS.md "값" 표의 확인 명령).

## 4. 빌드 태그와 패치 노트

- main 최신에 `git tag -a vX.Y -m "<한 줄 요약>"` 뒤 `git push origin vX.Y`. 마일스톤과 배포 빌드마다 붙인다.
- "vX.Y 이후 변경 정리해줘": 두 태그 사이에 머지된 PR 제목으로 패치 노트 초안을 만든다.

  ```
  git log vX.Y..HEAD --merges --first-parent --format="%s%n%b"
  ```
