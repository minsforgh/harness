---
name: unity-module
description: Unity 프로젝트에 새 모듈(폴더, asmdef, Editor asmdef, 테스트 asmdef, 시스템 문서, 입력 에셋)을 한 번에 만들고 에디터에서 컴파일과 .meta까지 확인한다. 겹치는 asmdef 이름, 찾을 수 없는 참조, 이미 있는 폴더는 만들기 전에 막는다. 새 시스템이나 POC 폴더를 만들 때, "asmdef 만들어줘", "새 시스템 폴더 만들어줘"에 쓴다.
---

# unity-module

새 모듈을 손으로 만들 때 틀리기 쉬운 것(asmdef 이름 겹침, 참조 이름 오타, 테스트 asmdef 설정, asmdef 아래의 `Editor/` 폴더, 빈 폴더가 git에 남지 않음, 생긴 `.meta`를 빠뜨림)을 스크립트와 확인 단계로 막는다. 파일은 `new-module.js`가 만들고, `.meta`와 컴파일은 Unity가 한다. 파일 결과는 `tests/run.js`(27개)로 본다.

## 순서

`<P>`는 Unity 프로젝트 절대 경로, `<이 스킬 폴더>`는 이 파일이 있는 폴더다. 모든 `unity` 명령에 `--project-path <P>`를 붙인다.

1. 미리 본다. 막히는 줄이 나오면 그 이유를 고친다(이름을 바꾸거나 참조 이름을 `Library/PackageCache`의 asmdef 이름으로 맞춘다).

   ```
   node <이 스킬 폴더>/new-module.js <P> --dir <Assets/...> --asmdef <이름> [옵션] --dry-run
   ```

2. `--dry-run` 없이 만든다.
3. 에디터에서 확인한다.

   ```
   unity command console clear --project-path <P>
   unity recompile --project-path <P> --format json
   unity status --project-path <P> --until-ready
   unity command script run --project-path <P> -- --file <이 스킬 폴더>/verify_module.cs --entry VerifyModule.Run --args '["<asmdef 이름> <asmdef 이름>"]'
   ```

   `recompile`이 끝난 직후에는 도메인 리로드 중이라 `script run`이 `success: false`로 끝날 수 있다. ready를 기다린 뒤에도 그러면 한 번 더 부른다. `recompile`의 `data.errors`가 비어야 하고, 이름마다 `compiled=True`, `meta=True`여야 한다. asmdef 아래 `.cs`가 하나도 없으면 어셈블리가 만들어지지 않아 `compiled=False`로 나온다(첫 스크립트를 넣은 뒤 다시 돌린다). 그 밖의 False는 `unity command console get --project-path <P> -- --level error`를 읽는다.
4. `git status`에 새 파일과 함께 폴더와 asmdef의 `.meta`가 보이는지 본다. `.meta`까지 같은 커밋에 넣는다.
5. 보고: 만든 파일, 컴파일 오류 수, verify 결과 줄, 막혀서 고친 것.

## 쓰는 곳별 옵션

| 쓰는 곳 | 옵션 |
|---|---|
| POC 폴더 하나 | `--dir Assets/<PocId> --asmdef <PocId> --refs Unity.InputSystem[,Unity.TextMeshPro] --folders Art,Audio,Data,Prefabs,Scenes,Scripts/Core,Scripts/View --editor Scripts/Editor --inputactions-from Assets/Settings/InputSystem_Actions.inputactions --inputactions Input/<PocId>.inputactions` |
| 시스템마다 asmdef | `--dir Assets/<시스템> --asmdef <프로젝트>.<시스템> --refs <의존 시스템 asmdef> --folders Scripts,Prefabs,Data --editor Editor --tests Assets/<시스템>/Tests --spec docs/systems/<시스템 소문자>.md --spec-from docs/systems/_template.md` (시스템 하나가 폴더 하나다. `Assets/Scripts/<시스템>`처럼 종류 폴더 아래 두면 시스템마다 공용 부모 여럿에 폴더를 만들어 팀에서 폴더 `.meta` 충돌이 잦다) |

- asmdef 아래의 `Editor/` 폴더는 특별 폴더가 아니다(그 안 코드도 런타임 asmdef로 들어가 Player 빌드에서 `UnityEditor`를 못 찾는다). 그래서 `--folders`에 `Editor`가 들면 막고, `--editor <폴더>`가 그 폴더에 `<이름>.Editor` asmdef(Editor 플랫폼만, 본 asmdef 참조, 자동 참조 끔)를 만든다. 에디터 코드가 패키지를 쓰면 그 asmdef에 참조를 더한다.
- `--folders`, `--editor`, `--inputactions`는 모듈 안 상대 경로다(`Scripts/Core`, `Input/<이름>.inputactions`). 파일이 들어가는 폴더(`Input/`)는 `--folders`에 따로 주지 않는다.
- 참조는 asmdef 이름이다(패키지 이름이 아니다). Unity 6의 TextMeshPro는 `Unity.TextMeshPro`, UI는 `UnityEngine.UI`다.
- 기본 Input Actions 경로는 프로젝트마다 다르다(`Assets/Settings/` 또는 `Assets/`). `*.inputactions`를 찾아 정한다.
- 시스템 문서 틀의 빈칸은 복사만 하고 채우지 않는다. 내용은 그 작업에서 쓴다.

## 쓴 기록

- 2026-11-04, MaxwellDemon(6000.3.27f1, pipeline 0.9.1): POC 줄 옵션으로 7개 생성, 참조 3개 막힘 없음, 컴파일 오류 0. `.cs`가 없을 때 `compiled=False`, 첫 스크립트 4개를 넣은 뒤 `compiled=True meta=True`. 그때 확인은 `script eval_file`이었고, 지금의 `script run` 방식은 harness-unity로 옮기며 바꿨다(2026-11-09).
- 2026-11-09, 임시 프로젝트(6000.3.27f1, pipeline 0.10.0-exp.1, `--template 2d`): 시스템 줄과 비슷한 옵션(`--tests`, 입력 에셋 포함)으로 5개 생성. 입력 에셋 원본 경로가 틀리면 만들기 전에 막힘. `.cs` 없을 때 `compiled=False meta=True`, 첫 스크립트 두 개 뒤 `compiled=True meta=True`, 컴파일 오류 0. `recompile` 직후 `script run`이 한 번 `success: false`(리로드 중)
- 2026-11-09, Arrowhead(6000.3.27f1, pipeline 0.10.0-exp.1, POC P3): 표의 POC 줄 `--inputactions Input/<PocId>.inputactions`를 스크립트가 "폴더 없는 파일 이름"으로 막았고(그때는 모듈 뿌리에만 만들었다), `--folders`로 만든 `Scripts/Editor`는 런타임 asmdef 아래라 Editor 전용으로 컴파일되지 않았다. 모듈 안 경로와 `--editor`를 더하고 POC 줄을 묶음 규칙의 처음 폴더와 맞췄다. Editor asmdef 모양은 MaxwellDemon `Entropy.Editor`(같은 자리, 에디터 도구 4개 컴파일)와 같다
