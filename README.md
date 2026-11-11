# harness

Claude Code와 Codex가 프로젝트에서 따를 규칙, 스킬, 훅, 커밋 전 검사를 **플러그인 묶음**으로 만든 개인 AI 작업 하네스.

| 규모 (이 저장소에서 센 값) | |
|---|---|
| 플러그인 | 7개 (user 1, 묶음 5, 시험 1) |
| 스킬 | 12개 (정식 9, 시험 3) |
| 훅 스크립트, 커밋 전 검사 | 11개, 2개 (+ 팀 저장소용 pre-push, PR 검사) |
| 자동 시험 | `tests/run.mjs` 317개 |
| 설계 결정 기록 | 182건 (대표 결정은 [docs/decisions.md](docs/decisions.md)) |

## 왜 만들었나

AGENTS.md에 "끝내기 전에 확인 단계를 돌린다" 같은 문장 규칙을 적어 두는 방식으로 Unity POC 하나를 끝까지 만들어 봤다. 대화 기록을 세어 보니 에이전트는 보고에 확인과 마감 단계를 약 30번 적었지만, 실제로 그 도구를 부른 것은 1번과 0번이었다. 반대로 실제로 문제를 잡은 것은 커밋 전 코드 검사, 확인 명령, 사람의 플레이테스트였다.

그래서 원칙을 하나로 정했다.

> **문장 규칙은 지켜지지 않는다. 강제할 것은 훅과 커밋 전 검사로, 판단할 것만 짧은 규칙으로.**

그리고 프로젝트마다 규칙을 복사해 넣으면 다음 프로젝트로 옮겨지지 않고 제각각 낡는다. 그래서 규칙과 검사를 플러그인 안에 두고, 프로젝트는 플러그인을 켜기만 한다. 원본을 한 번 고쳐 배포하면 켠 프로젝트가 모두 같이 바뀐다.

## 구조: 층, 묶음, 프로필

```
[user 층]  harness-user        모든 세션. 전역 지시 주입, 한국어 답 확인, 원본 보호,
                               갱신 알림, 지식 후보 대기열 / grilling, skill-make,
                               harness-apply, harness-update
     |
[묶음 층]  프로젝트마다 켠다 (project 범위)
     +-- harness-core   엔진 무관. 범위, 확인과 보고, 커밋, 문서 규칙 + 커밋 전 문서 검사
     +-- harness-unity  공식 Unity CLI 먼저, C# 컨벤션, 런타임 화면 조립 검사, unity-module
     +-- harness-poc    게임 POC. 느슨한 확인, poc 스킬(기획 -> 승인 -> 구현 -> 플레이테스트 -> 마감)
     +-- harness-team   팀 저장소. 팀원에게 닿는 것은 저장소 파일로(AGENTS.md 블록, git 훅, PR 템플릿)
     +-- harness-orca   멀티 에이전트 오케스트레이션 정책 (어느 프로필 위에나 더함)
     |
[시험 층]  harness-trial       효과가 입증되지 않은 스킬. 시험할 프로젝트에만 켠다
```

**프로필** = 쌓을 묶음 + 문서 수준 (`profiles.json`)

| 프로필 | 묶음 | 문서 수준 | 언제 |
|---|---|---|---|
| `personal` | core | standard | 엔진 없는 오래 갈 프로젝트 |
| `unity-game` | core + unity | standard | 오래 갈 개인 Unity 게임 |
| `unity-poc` | core + unity + poc | light | 짧게 끝낼 게임 POC |
| `unity-team` | core + unity + team | standard | 내가 PR 관리자인 팀 저장소 |

묶음은 모두 같은 여섯 칸을 채운다: 규칙, 컨벤션, 문서, 확인, 도구, 평가. 새 스택은 같은 칸을 채운 묶음 하나를 더하면 된다.

프로젝트에 들어가는 것은 처음 파일(AGENTS.md 머리, docs 틀)과 검사 연결 파일(`.githooks/`)뿐이다. 규칙은 세션 시작 훅이 플러그인에서 주입한다.

## 개선 사이클

```
 1. 시험      2. 배포           3. 평가                 4. 환류
 고친 원본 -> 시험 전부 통과 -> 기록에서 지표를 세어 -> 작업 중 나온 지식은 후보 대기열로,
 을 그 세션   한 원본만 버전   기준선과 같은 국면    사람이 골라 위키에 올림.
 에서만 켜서  올려 release    끼리 비교             평가에서 나온 고칠 점은 결정 기록으로
 써 봄                                              남기고 1로
```

1. **시험**: `claude --plugin-dir <묶음 폴더>`로 그 세션에서만 켜 본다. 새 스킬은 통과 기준을 먼저 정하고 `trial/`에서 시험한다
2. **배포**: `tests/run.mjs`가 모두 통과하면 원본의 지문을 `tests/.passed`에 남긴다. `release.mjs`는 지금 원본이 그 지문과 다르면 멈춘다
3. **평가**: `eval/run.py`가 대화 기록, Unity eval 기록, git에서 센다. 에이전트의 자기 보고는 근거로 쓰지 않는다. 판단이 필요한 것(끝났다고 한 뒤 사람이 찾은 버그 등)은 후보만 뽑고 사람이 판정한다
4. **환류**: 에이전트가 보고 끝에 `wiki 후보: <한 줄>`을 붙이면 Stop 훅이 PC의 대기열에 모은다. 저장소에는 쓰지 않으므로 팀 저장소에 흔적이 남지 않는다

기준선은 하네스 이전 방식으로 만든 POC의 마감 국면(하루, 도구 시간 4.8시간)이다. 확인 시간 30%, 커밋 60개 중 fix 13개, fix 중 테스트를 더한 커밋 0개. 하네스로 만든 첫 프로젝트는 기준선보다 나빠진 비율이 없었고, 사람이 가장 많이 고친 것(게임 안 문구 15번 넘게, UI 겹침 10번 안팎)과 한 세션 압축 17번을 근거로 규칙 셋을 더했다([docs/decisions.md](docs/decisions.md) Q182).

## 설치와 사용

필요한 것: Node.js, Python 3, git, Claude Code CLI(시험한 환경은 Node 24, Python 3.13). Unity 묶음을 쓰려면 Unity 공식 CLI.

원본은 개인 지식 저장소 안의 `_harness/` 폴더에 두는 구조로 만들었다(설치 스크립트가 이 폴더의 부모를 "원본 저장소"로 본다). 그래서 아무 폴더 아래 `_harness`라는 이름으로 clone한다.

```bash
git clone <이 저장소 URL> my-notes/_harness
```

**1. 시험이 도는지 확인** (임시 폴더에서만 돌고 설정을 건드리지 않는다)

```bash
node my-notes/_harness/tests/run.mjs
```

**2. PC 설정**: 로컬 마켓플레이스 `harness` 등록, harness-user를 user 범위로 설치, Codex 홈 AGENTS.md에 전역 지시 블록. 여러 번 돌려도 결과가 같다

```bash
node my-notes/_harness/setup.mjs --dry-run
```

```bash
node my-notes/_harness/setup.mjs
```

**3. 프로젝트에 적용**: Claude 세션에서 "하네스 적용"(harness-apply 스킬)이라고 하거나 직접 돌린다. 커밋은 하지 않는다

```bash
node my-notes/_harness/apply.mjs <프로젝트 폴더> --profile personal --dry-run
```

```bash
node my-notes/_harness/apply.mjs <새 폴더> --new --profile unity-poc
```

- `--new`: 폴더를 만들고 `git init` 뒤 적용. unity 묶음이면 공식 `unity projects create`로 프로젝트까지 만든다
- `--personal`: 남이 관리하는 저장소. 내 PC에서만 플러그인을 켜고 공용 파일은 건드리지 않는다
- `--packs core,unity,orca`: 프로필 위에 묶음을 더한다

**4. 원본을 고친 뒤**

```bash
node my-notes/_harness/tests/run.mjs
```

```bash
node my-notes/_harness/release.mjs harness-core
```

설치본은 버전별 캐시 복사본이라 버전을 올려야 반영된다. 적용은 새 세션부터다.

**끄기**: `HARNESS_UPDATE_CHECK=0`(갱신 알림), `HARNESS_DOC_CHECK=0`(문서 전체 검사 알림), `HARNESS_WIKI_CANDIDATES=0`(후보 대기열)

## 폴더

| 경로 | 내용 |
|---|---|
| `user/` | harness-user: 전역 지시(`instructions.md`), 훅, 사용자 스킬 |
| `packs/<묶음>/` | `rules.md`(주입), `hooks/`, `skills/`, `git/checks/`, `scaffold/`(처음 파일), `managed/`(연결 파일), `values.md`(프로젝트 값 표) |
| `trial/` | 시험 중 스킬과 통과 기준 |
| `apply.mjs`, `setup.mjs`, `release.mjs` | 적용, PC 설정, 배포 |
| `tests/run.mjs` | 훅, 검사, 연결 파일, apply 시험 (임시 저장소에서 실제 커밋까지) |
| `eval/` | 기록 기반 평가 스크립트. 기준선과 결과 파일은 대화 원문이 들어 있어 공개본에서 뺐다 |

## 알아 둘 것

- 문서와 주석은 한국어다. 에이전트의 답도 한국어로 받도록 되어 있다(`user/instructions.md`)
- 주석의 `harness-design Q<번호>`는 비공개 설계 문서의 결정 번호다. 대표 결정은 [docs/decisions.md](docs/decisions.md)에 요약했다
- 주석과 시험 스킬에 나오는 Arrowhead, MaxwellDemon, BreathForge, deskpet은 근거를 얻은 개인 프로젝트 이름이다
- Windows 11에서 만들고 시험했다. 다른 OS에서는 돌려 보지 않았다
