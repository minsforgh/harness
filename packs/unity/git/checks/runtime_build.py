"""harness-unity 커밋 전 검사: 사람이 보고 고칠 화면을 코드로 조립하지 않는다.
원본: dev-wiki _harness/packs/unity/git/checks/runtime_build.py

unity 규칙 "사람이 보고 고칠 게임 요소는 prefab과 씬에 둔다"를 받친다(harness-design Q174. Arrowhead M1은 씬에
오브젝트가 셋뿐이고 궁수, 괴수, HUD를 실행 중에 new GameObject + AddComponent로 만들었다. 문장 규칙 "조절할 값은
Inspector에 둔다"가 있었는데도 배치값 수십 개가 코드에 들어갔다).

- --staged: 이번 커밋에서 새로 더한 줄만 본다(옛 코드는 건드리지 않는다). 찾으면 막는다
- 그 밖(--all): 모든 줄을 알림으로만 보인다(적용 직후 점검용, 막지 않는다)
대상: 경로에 `Assets` 폴더가 있는 .cs 중 Editor, Tests, AgentScripts 폴더 밖의 것(에디터 도구, 테스트, 에이전트 시험
스크립트는 코드로 만들어도 된다).
찾는 것: new GameObject(, AddComponent<, AddComponent(, GameObject.CreatePrimitive(, Sprite.Create(, new Texture2D(
줄 끝에 `// harness:runtime-ok: 이유`를 단 줄은 통과한다. 이유 없는 표시는 받지 않는다. 주석과 문자열 안의 글은 찾지 않는다.
merge 중(MERGE_HEAD가 있음)에는 건너뛴다: 들어온 줄은 그 줄을 만든 커밋에서 이미 검사했다.

사용:
  python runtime_build.py [저장소]            모든 줄(알림)
  python runtime_build.py --staged [저장소]   이번 커밋에 더한 줄(막음)
"""
import os
import re
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8")

PATTERNS = [
    (re.compile(r"\bnew\s+GameObject\s*\("), "new GameObject"),
    (re.compile(r"\bAddComponent\s*[<(]"), "AddComponent"),
    (re.compile(r"\bGameObject\s*\.\s*CreatePrimitive\s*\("), "GameObject.CreatePrimitive"),
    (re.compile(r"\bSprite\s*\.\s*Create\s*\("), "Sprite.Create"),
    (re.compile(r"\bnew\s+Texture2D\s*\("), "new Texture2D"),
]
MARK = re.compile(r"//\s*harness:runtime-ok:(.*)$")
STRING = re.compile(r'@?\$?"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])\'')
BLOCK_COMMENT = re.compile(r"/\*.*?\*/")
SKIP_DIRS = {"editor", "tests", "agentscripts"}


def git(root, *args):
    r = subprocess.run(["git", "-c", "core.quotepath=false", *args], cwd=root, capture_output=True,
                       encoding="utf-8", errors="replace")
    return r.stdout if r.returncode == 0 else ""


def is_target(path):
    parts = path.replace("\\", "/").split("/")
    if not parts[-1].endswith(".cs") or "Assets" not in parts[:-1]:
        return False
    return not any(p.lower() in SKIP_DIRS for p in parts[:-1])


def code_part(line):
    """문자열과 주석을 뺀 코드 부분."""
    s = STRING.sub('""', line)
    s = BLOCK_COMMENT.sub(" ", s)
    i = s.find("//")
    return s if i < 0 else s[:i]


def judge(line):
    """(찾은 이름, 문제) 목록. 표시가 있으면 이유가 있는지만 본다."""
    hits = [name for pat, name in PATTERNS if pat.search(code_part(line))]
    if not hits:
        return []
    mark = MARK.search(line)
    if mark:
        return [] if len(mark.group(1).strip()) >= 2 else [(", ".join(hits), "표시에 이유가 없다")]
    return [(", ".join(hits), None)]


def added_lines(root):
    """--staged: 이번 커밋에 새로 더한 .cs 줄 (경로, 줄 번호, 글)."""
    out, path, num = [], None, 0
    diff = git(root, "diff", "--cached", "-U0", "--no-color", "--no-ext-diff", "-M", "--diff-filter=AMR", "--", "*.cs")
    for line in diff.splitlines():
        if line.startswith("+++ "):
            path = line[6:] if line.startswith("+++ b/") else None
        elif line.startswith("@@"):
            m = re.search(r"\+(\d+)", line)
            num = int(m.group(1)) if m else 0
        elif line.startswith("+") and path:
            if is_target(path):
                out.append((path, num, line[1:]))
            num += 1
    return out


def all_lines(root):
    out = []
    for path in git(root, "ls-files", "-co", "--exclude-standard", "--", "*.cs").splitlines():
        if not is_target(path):
            continue
        try:
            with open(os.path.join(root, path), encoding="utf-8-sig", errors="replace") as f:
                out += [(path, i, text.rstrip("\n")) for i, text in enumerate(f, 1)]
        except OSError:
            continue
    return out


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    staged = "--staged" in sys.argv
    root = os.path.abspath(args[0] if args else ".")
    if staged and subprocess.run(["git", "rev-parse", "-q", "--verify", "MERGE_HEAD"], cwd=root,
                                 capture_output=True).returncode == 0:
        return 0
    found = []
    for path, num, text in (added_lines(root) if staged else all_lines(root)):
        for names, why in judge(text):
            found.append(f"{path}:{num}: {names}{' (' + why + ')' if why else ''} -- {text.strip()[:120]}")
    if not found:
        return 0
    if not staged:
        for f in found:
            print(f"[알림] [런타임 조립] {f}")
        print(f"[harness-unity] 코드로 화면을 만드는 줄 {len(found)}개(막지 않음). 사람이 보고 고칠 것이면 prefab과 씬으로 옮길 후보다")
        return 0
    for f in found:
        print(f"[런타임 조립] {f}")
    print("[harness-unity] 사람이 보고 고칠 게임 요소(캐릭터, 적, UI 배치, 효과, 임시 그림)는 prefab과 씬에 두고, "
          "개수가 실행 중에 정해지면 그 prefab을 Instantiate한다. 정말 코드로 만들어야 하는 줄(디버그 표시 등)이면 "
          "줄 끝에 // harness:runtime-ok: 이유 를 달고 보고에 적는다.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
