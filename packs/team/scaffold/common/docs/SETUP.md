# 처음 클론한 뒤

> 현재 상태 문서. 클론한 PC마다 한 번 한다. 커밋 전 검사는 python으로 돈다(없으면 건너뛴다).

1. git 훅을 연결한다. main 직접 push를 막고, 커밋 전에 문서를 검사한다.

   ```
   git config core.hooksPath .githooks
   ```

2. 공식 Unity 플러그인과 스킬을 Codex와 Claude Code에 깐다.

   ```
   unity setup all
   ```

3. 쓰는 에이전트(Codex, Claude Code)로 이 폴더를 한 번 열고, 이 폴더를 신뢰하겠냐고 물으면 신뢰한다. 신뢰하지 않은 폴더에서는 `.codex/rules/`와 `.claude/settings.json`의 승인 생략(Unity 확인 명령)을 읽지 않는다.

`unity vcs merge-setup`과 `unity vcs hooks install`은 돌리지 않는다(이유는 AGENTS.md 공통 규칙 "팀 저장소").
