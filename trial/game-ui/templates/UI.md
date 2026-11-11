# UI 값

game-ui 스킬이 읽는 이 프로젝트의 UI 기준이다. 사람이 고치고, 스킬은 여기를 따른다.

## 분위기

- 한 줄 요약: (예: 무쇠 공장의 계기판. 거칠고 따뜻한 빛)
- 피할 것: (예: 둥근 모바일 버튼, 네온)

## 레퍼런스

| 게임, 링크 | 무엇을 가져올지 |
|---|---|

## 디자인 값

이름은 시안 HTML의 CSS 변수와 같고, 글자 크기는 TMP Style Sheet 스타일 이름(`--font-small` -> `small`)과 맞춘다. 값을 바꾸면 이 표, 기본 부품 prefab, TMP 스타일을 함께 바꾼다.

| 변수 | 값 | 쓰임 |
|---|---|---|
| `--color-bg` | | 가장 어두운 색. 막, 패널 바탕 |
| `--color-surface` | | 패널, 막대 바탕 |
| `--color-text` | | 본문 글자 |
| `--color-text-dim` | | 보조 글자 |
| `--color-accent` | | 강조(한 화면에 하나) |
| `--color-danger` | | 피해, 위험 |
| `--font-small` | | 보조 숫자, 라벨 |
| `--font-body` | | 본문, 안내 |
| `--font-title` | | 제목, 결과 |
| `--space` | | 여백 단위. 여백은 이 값의 배수로만 |
| `--safe` | 32px | 화면 가장자리 안전 여백 |

- 기본 부품 prefab 폴더: (예: `Assets/<PocId>/Prefabs/UI/Parts/`. 부품 목록은 game-ui `templates/parts.md`)
- TMP Style Sheet: (예: `Assets/<PocId>/Art/UI/<이름> Style Sheet.asset`. TMP Settings의 기본 스타일 시트로 지정)

## 부품 규칙

game-ui의 기본 규칙과 다른 것만 적는다.

## 화면 목록

| 화면 | 시안 | 구현 | 상태 |
|---|---|---|---|
