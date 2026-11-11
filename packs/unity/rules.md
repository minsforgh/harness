# 작업 규칙: harness-unity

하네스 묶음 규칙이다(원본 dev-wiki `_harness/packs/unity/rules.md`, 세션마다 주입). 프로젝트 `AGENTS.md`와 다르면 `AGENTS.md`를 따른다(이미 다른 이름 규칙으로 쓴 코드가 있는 프로젝트도 같다). Unity 프로젝트 경로와 확인 씬은 `AGENTS.md` "값" 표에 있다.

## 공식을 먼저

에디터 조종은 공식 `unity:unity-cli`, `unity:unity-pipeline` 스킬과 com.unity.pipeline 문서를 따른다. 아래는 공식과 다르거나 공식이 정하지 않은 것만이다. 공식과 부딪치면 공식을 따르고, 이 규칙의 고칠 점으로 보고한다.

| 하는 일 | 방법 |
|---|---|
| 값 하나(씬, 에셋, 배열, 참조) | `component set_field` |
| 여러 단계를 한 번에 | `job batch` |
| 대량 만들기, 비공개 필드 연결, 자식 추가 | `AgentScripts/*.cs` + `script run` |
| 같은 상태를 두 번째 읽을 때부터 | `AgentScripts/State.cs`의 진입점 + `script run --entry State.<이름>` (처음에는 `<harness-unity>/agent-scripts/State.cs`를 복사한다) |
| 한 번만 보는 탐색 | `script eval` 한 줄. 길면 파일로 써서 `script eval --file` |
| 끝났다고 하기 전 | `console status`의 오류 0, 컴파일 실패 없음("값" 표의 확인 명령에 늘 포함한다). 씬 연결이나 `Awake`/`OnEnable`/`Start`를 바꿨으면 Play에 들어가 몇 프레임 뒤 오류 0을 보고 나온다(편집 모드에서는 안 보인다) |

- 모든 `unity` 명령에 `--project-path <Unity 프로젝트 절대 경로>`를 붙인다.
- `AgentScripts/`(Assets 밖, 커밋한다)에는 다시 쓸 스크립트만 둔다. 한 번 쓰고 버릴 스크립트는 scratchpad(없으면 `Temp/agent/`)에 쓴다.
- 사람이 손댈 수 있는 씬과 prefab을 지우고 다시 만드는 빌더는 쓰지 않는다(손 수정이 사라지고 diff가 파일 전체가 된다). 처음 만들 때 돌린 코드는 남기지 않고, 그 뒤로는 있는 파일을 열어 바뀐 값만 고친다. prefab 안쪽은 `PrefabUtility.LoadPrefabContents` -> 고침 -> `SaveAsPrefabAsset` -> `UnloadPrefabContents`로 고친다.
- 캡처는 `capture game_view -- --output-path Screenshots/<이름>.png`(프로젝트 뿌리, git에서 뺌)로 받아 Read로 본다. UI를 바꿨으면 가장 긴 문구와 가장 많은 표시가 함께 뜬 상태로 찍어 겹침, 가림, 잘림을 본다.
- 입력 시험: 누르고 있기(`isPressed`)는 공식 `runtime simulate_key`, `simulate_pointer`의 `--action down` 뒤 `up`. 눌린 순간(`WasPressedThisFrame`)과 정해진 시간 누르기는 `<harness-unity>/agent-scripts/TestInput.cs`를 복사하지 않고 `script run --file`로 부른다(사용법은 파일 머리). 넣기 전에 State로 `focused`를 본다. false면 Action까지 가지 않으므로, 내가 시작한 플레이는 한 번 멈추고 다시 시작해 본다(창이 뒤에 있어도 true가 된 적이 있지만 늘 그렇지는 않다). 그래도 false면 입력 시험을 그만두고, 확인할 동작은 그 처리 메서드를 직접 불러 State로 판정하고, 입력이 실제로 닿는지는 사람이 볼 것으로 남긴다(창 클릭을 부탁하지 않는다). `editor focus`는 부르지 않는다(창을 앞으로 못 가져오고 입력이 끊긴다). 결과는 State로 읽는다.
- 사람이 봐야 하는 확인(조작감, 연출)이나 입력이 닿지 않는 확인은 섞는다: 에이전트가 플레이와 상황을 만들고, 사람에게 "조작 -> 기대 결과"를 한 줄씩 준 뒤, 끝났다고 하면 State로 읽어 기대값과 비교한다.
- `[CliCommand]` 상태 명령은 이름으로 늘 보여야 하거나 Player에서 읽어야 할 때만 쓴다. `<harness-unity>/agent-scripts/AgentCommands.asmdef`를 복사한 폴더 안에만 둔다(참조는 `Unity.Pipeline.Attributes`. 패키지가 없으면 어셈블리를 건너뛰어 Safe Mode를 막는다).
- 테스트: 작업 중에는 컴파일과 콘솔만 보고, 끝낼 때 바꾼 시스템의 EditMode 테스트를 돌린다. 설정, 패키지, asmdef 참조가 바뀌었으면 전체를 돌린다. 필터 이름이 틀리면 0개로 성공하므로 `Total` 0은 통과가 아니다.
- 컴파일은 `unity recompile`로 부른다(창이 뒤에 있거나 최소화돼도 끝난다. 끝난 직후 연결 오류와 파일을 고친 직후의 400은 `unity status`가 ready일 때까지 기다린다). 사람에게 창 클릭을 부탁하는 것은 Pipeline 첫 설치, Unity 대화창, `isCompiling`이 5분 넘게 true로 거듭 시간 초과일 때뿐이다(콘솔의 에디터 오류도 같이 보고).
- Player 빌드는 요청받았거나 보낼 때, Player에서만 깨질 변경(에디터 전용 코드, asmdef, 전역 설정)이 있을 때만 한다. 빌드는 URP 에셋과 ProjectSettings를 다시 쓰므로 끝나면 `git status`로 보고 되돌린다.
- 이미 플레이 중인 에디터는 사용자의 세션이다. 그 설정을 바꾸거나 멈추지 않는다. 남긴 부작용(켜 둔 auto tick, Assets 밖에 쓴 파일)은 보고에 적는다.

## Unity 기본

- `.meta`는 에셋과 같이 더하고 옮기고 지운다. 직접 고치지 않는다. 에셋과 폴더 이동은 에디터나 `AssetDatabase.MoveAsset`으로 한다(GUID 유지).
- 직렬화 필드 이름을 바꾸면 `[FormerlySerializedAs("옛이름")]`을 단다. 직렬화되는 enum은 숫자를 고정하고 끝에만 더한다. 맞지 않는 타입으로 바꾸면 저장된 값이 조용히 사라진다. `Dictionary`, 프로퍼티, `[SerializeReference]` 없는 인터페이스 필드는 저장되지 않는다.
- MonoBehaviour와 ScriptableObject는 클래스 이름과 파일 이름이 같다.
- asmdef 아래의 `Editor/` 폴더는 특별 폴더가 아니다(그 안 코드도 런타임 asmdef로 들어가 Player 빌드가 깨진다. 에디터에서는 안 보이므로 마일스톤이 끝나면 Player 빌드를 한 번 한다). 에디터 코드는 Editor 전용 asmdef(`<이름>.Editor`, Editor 플랫폼만)가 있는 폴더에 둔다. 새 모듈이면 `harness-unity:unity-module`의 `--editor`가 같이 만든다.
- 씬, prefab, 에셋 YAML을 텍스트로 고치지 않는다. 고친 뒤에는 `git status`로 고치려던 파일만 바뀌었는지 본다(에디터가 열린 다른 씬과 에셋을 같이 저장할 수 있다). 스크립트로 연결한 참조와 값은 저장된 파일에서 다시 읽어 본다. 스크립트가 쥔 에셋 객체는 `EditorSceneManager.OpenScene`(Single) 뒤 무효가 되어 빈 참조(`{fileID: 0}`)로 저장될 수 있으니, 씬을 연 뒤 `AssetDatabase.LoadAssetAtPath`로 다시 불러 연결한다.
- 입력은 Input Actions 에셋을 거친다. `Keyboard.current` 같은 장치 직접 접근은 게임 코드에 쓰지 않는다.
- `UnityEngine.Object`는 `== null`이나 bool로 확인한다(`?.`, `??`, `is null`은 파괴된 오브젝트를 못 본다). 없을 수 있는 컴포넌트는 `TryGetComponent`.
- 이벤트는 기본으로 `OnEnable`에서 구독하고 `OnDisable`에서 해제한다. 꺼져 있는 동안에도 받아야 하는 컴포넌트만 `Awake`/`OnDestroy`로 짝을 맞춘다. 해제할 수 없는 람다로 구독하지 않는다(필드에 담아 두면 해제할 수 있다).
- 플레이 중에 ScriptableObject 에셋 값을 코드로 바꾸지 않는다(에디터에서는 에셋에 남는다).
- 자기 오브젝트 밖의 의존은 쓰는 쪽이 찾지 않고 받는다. 같은 프리팹이나 씬 안의 것과 에셋은 Inspector(`[SerializeField]`), 그 밖(실행 중에 만든 오브젝트가 바깥 것을 쓸 때 등)은 만든 쪽이나 조립 지점(시작할 때 객체를 엮는 한 곳)이 넘긴다. 자기 오브젝트의 컴포넌트는 `GetComponent`로 가져와도 된다(꼭 있어야 하면 `[RequireComponent]`로 드러낸다). 이름, 태그, 경로 문자열이나 씬 전체 타입 검색(`GameObject.Find`, `transform.Find`, `FindWithTag`, `FindObjectsByType`, `Resources.Load`)은 조립 지점, Editor, 테스트, `AgentScripts/`에서만 쓴다. 이름을 바꾸면 조용히 깨지고 무엇에 기대는지 숨는다.
- 상태는 수명이 맞는 쪽이 갖는다. static에는 앱 전체 수명인 것만 두고, 씬에서만 뜻이 있는 목록과 이벤트(적 목록, 적이 죽음 등)는 그 씬에 있는 쪽이 갖는다. 자기보다 오래 사는 것(static, 씬을 넘어 사는 오브젝트, ScriptableObject)에 등록하거나 구독하면 해제와 짝을 맞춘다(보통 `OnEnable`/`OnDisable`). 도메인 리로드를 끄면(2D 템플릿 기본값) static이 다음 Play까지 남는다. Play마다 처음부터 시작해야 하는 static은 늘 `[RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]`에서 초기화한다(매번 덮어쓰는 임시 버퍼는 해당 없음).
- 꼭 있어야 하는 `[SerializeField]` 참조는 `Awake` 첫머리에서 비었는지 보고, 비었으면 필드 이름을 `Debug.LogError`로 알리고 `enabled = false`로 멈춘다(그대로 두면 다른 줄의 NullReferenceException으로 번져 원인이 숨는다).
- 매 프레임 도는 코드(`Update` 등)에서는 `GetComponent`와 LINQ를 부르지 않고 새 배열, 리스트, 클로저를 만들지 않는다(찾을 것은 `Awake`에서 찾아 필드에 둔다). 물리 오브젝트는 `FixedUpdate`에서 `Rigidbody`(2D) API로 움직이고 `transform`을 직접 옮기지 않는다. 프레임마다 쌓는 이동과 시간은 `Time.deltaTime`을 곱한다.
- 조절할 값은 코드 상수 대신 Inspector나 ScriptableObject에 둔다.
- 사람이 보고 고칠 게임 요소(캐릭터, 적, UI 배치, 효과, 임시 그림)는 prefab과 씬에 둔다. 실행 중에 개수나 종류가 정해지는 것은 그 prefab을 `Instantiate`한다(어느 prefab인지는 데이터나 `[SerializeField]`가 갖는다). `new GameObject`와 `AddComponent`를 쌓아 화면을 만들거나 그림을 `Texture2D`로 그리지 않는다(편집 모드에서 안 보이고, 위치 하나를 고쳐도 코드와 컴파일을 거친다). prefab을 처음 만들 때는 버릴 에디터 스크립트를 써도 된다. 정말 코드로 만들어야 하는 줄(디버그 표시 등)은 줄 끝에 `// harness:runtime-ok: 이유`를 단다. 커밋 전 검사가 표시 없는 새 줄을 막는다.
- 사람이 조정할 값(튜닝 값, 배치, 연출 값)의 자리는 `docs/tuning.md`(조정 지도)에 바꾸고 싶은 것 기준으로 쓴다: `| 바꾸고 싶은 것 | 어디 | 의도 |`, 어디는 에셋이나 prefab 경로(백틱) 뒤에 `> 컴포넌트 > 필드`. 수치는 쓰지 않는다. 조정할 값을 새로 만들 때와, 사용자가 값 조정을 부탁할 때(자주 바꾸는 값이라는 뜻) 그 줄을 더하고 보고에 Inspector 위치를 쓴다.
- 테스트는 EditMode가 기본이다. 프레임이 흘러야만 재현되는 것(물리, 코루틴과 시간, Animator, 씬 로드 뒤 초기화)만 PlayMode로 쓴다.

## 병렬로 돌릴 때 (worktree 여럿, worker 여럿, 에디터 하나를 쓰는 세션 여럿)

- 세션 여럿이 에디터 하나를 쓰면 씬과 prefab 저장은 한 세션만 한다. 에디터는 디스크가 아니라 컴파일된 코드로 직렬화하므로, 다른 세션이 스크립트를 고치는 중에 저장하면 그 참조가 빈 값이 된다. 다른 세션은 파일(그림, 문서)만 고치고, 저장한 뒤에는 diff에 남의 변경이 섞였는지 본다.
- 동시에 도는 batchmode 실행(테스트, 빌드, 임포트) 수를 정해 두고 넘기지 않는다. 한 번에 몇 개까지 되는지는 그 PC에서 본다.
- Unity 프로세스는 내가 띄운 PID로만 끈다. 이름으로 끄면 사용자 에디터와 다른 worktree의 실행까지 꺼진다.
- 두 브랜치가 같은 폴더에 새 파일을 만들면 머지 전에 `.meta` GUID가 겹치는지 본다. 겹치면 한쪽을 에디터에서 다시 만든다(`.meta`를 직접 고치지 않는다).
- `unity test` 등은 로그를 worktree가 아니라 공용 `Editor.log`에 쓴다. 병렬로 돌 때는 그 로그로 판정하지 않고 실행마다 따로 남는 결과 파일(테스트 결과 XML 등)로 본다. 로그가 필요하면 실행마다 다른 경로를 준다(batchmode `-logFile`).
- 새 worktree는 첫 임포트(오래 걸린다) 뒤 `git status`가 깨끗한지 본다. 에디터에서만 바꾸고 저장하지 않은 설정이 있으면 새 worktree에서 파일이 다시 바뀐다.
- 화면을 보는 batchmode 실행(캡처)에는 `-nographics`를 붙이지 않는다. 카메라가 아무것도 그리지 않는다.

## C# (이름과 using 위치는 `.editorconfig`가 IDE로 알린다)

- 이름: private 필드 `_camelCase`, private static 필드 `s_camelCase`, 상수 PascalCase, 인터페이스 `I` + PascalCase, 지역 변수와 매개변수 camelCase, 나머지 PascalCase. bool은 is/has/can으로 시작한다.
- Inspector에 보일 값만 `[SerializeField] private`로 둔다. 밖에서 읽을 값은 필드를 열지 않고 프로퍼티로 연다.
- 필드 순서: const, static, `[Header]` 그룹(그룹 안은 `[SerializeField] private`, 그 밖의 private/protected).
- 접근 제한자를 쓴다. Unity Lifecycle 메서드는 생략한다(virtual, override, abstract면 쓴다).
- using 순서: System, UnityEngine, 패키지, 프로젝트. 쓰지 않는 using은 지운다.
- 주석: 공개 메서드와 의도가 안 보이는 메서드에 `summary` 한 줄. 안쪽 주석은 코드로 알 수 없는 이유만 짧은 평문으로 쓴다.
