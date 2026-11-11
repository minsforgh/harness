# 기본 부품

game-ui가 화면을 만들 때 쓰는 uGUI 부품 prefab과 TMP Style Sheet의 틀이다. 화면은 이 부품의 prefab variant로 만들고, 색과 글자 크기는 부품과 스타일에만 둔다. 값의 원본은 UI 값 문서의 디자인 값 표다. 값을 바꾸면 값 문서, 부품, 스타일을 함께 바꾼다.

부품 폴더와 스타일 시트의 위치는 값 문서에 적는다.

## 부품 prefab

| 부품 | 구성 | 값 문서에서 가져오는 값 | variant에서 바꿔도 되는 것 |
|---|---|---|---|
| `Panel` | RectTransform, Image(9-slice 스프라이트) | `--color-surface`, `--color-bg`(막) | 크기, 앵커, 불투명도 |
| `Label-Small` | TextMeshProUGUI, 스타일 `small` | `--font-small`, `--color-text-dim` | 문자열 표 키, 정렬, 앵커 |
| `Label-Body` | TextMeshProUGUI, 스타일 `body` | `--font-body`, `--color-text` | 문자열 표 키, 정렬, 앵커 |
| `Label-Title` | TextMeshProUGUI, 스타일 `title` | `--font-title`, `--color-text` | 문자열 표 키, 정렬, 앵커 |
| `Bar` | 바탕 Image + `Fill` 자식 Image(Filled, 가로) | `--color-surface`(바탕), `--color-accent`(채움), `--color-danger`(위험 상태) | 길이, 방향, 앵커 |
| `Divider` | Image(1px 높이) | `--color-text-dim` | 길이, 앵커 |

- 루트는 RectTransform이고 앵커는 부품 가운데에 둔다. 화면에 놓을 때 variant나 인스턴스에서 앵커를 정한다.
- 글자 크기와 굵기는 Label의 TMP 스타일로만 정한다. TextMeshProUGUI의 Font Size를 직접 넣지 않는다.
- 부품에 없는 모양이 필요하면 화면에서 따로 만들지 않고 부품을 먼저 더한 뒤 이 표에 적는다.
- 코드는 부품의 내용(글자, `Fill`의 채움 비율, 켜고 끄기)만 바꾼다. 색을 바꿔야 하는 상태(위험 등)는 부품에 상태별 색을 두고 코드는 상태만 고른다.

## TMP Style Sheet

스타일 이름은 값 문서의 글자 크기 변수에서 `--font-`를 뗀 이름이다.

| 값 문서 | 스타일 이름 | 여는 태그 예 |
|---|---|---|
| `--font-small` | `small` | `<size=18>` |
| `--font-body` | `body` | `<size=24>` |
| `--font-title` | `title` | `<size=48><b>` |

- 스타일 시트는 TMP Settings의 기본 스타일 시트로 지정해 모든 TextMeshProUGUI가 같은 시트를 본다.
- 크기 값은 1920x1080 기준이다(Canvas Scaler가 화면에 맞춰 줄이고 늘린다).
- 글꼴은 프로젝트가 고른 TMP 글꼴 하나다. 한국어를 쓰면 한글이 들어간 TMP 글꼴 에셋을 TMP Settings 기본 글꼴로 둔다.
