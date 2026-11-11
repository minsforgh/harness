"""PreToolUse 훅 (harness-user): 프로젝트 세션이 dev-wiki 하네스 원본(_harness, _skills)을 고치려 하면 승인을 묻는다.

MaxwellDemon 세션들이 dev-wiki 원본을 약 90번 고쳤고, 그중 일부는 프로젝트 사정에 맞춘 수정이었다.
원본은 dev-wiki 세션에서만 고치고, 프로젝트 세션은 문제와 근거를 보고한다(harness-design Q31).
dev-wiki의 위키 문서(내용 폴더, log.md 등)는 프로젝트에서 기록하는 곳이라 막지 않는다.
dev-wiki 저장소 안(worktree 포함)에서 돈 세션이면 묻지 않는다.
"""
import json
import os
import subprocess
import sys

MARK = os.path.join("_harness", ".claude-plugin", "marketplace.json")
SOURCES = ("_harness", "_skills")


def norm(p):
    return os.path.normcase(os.path.abspath(p))


def harness_repo(path):
    """path의 조상 중 _harness 마켓플레이스가 있는 폴더(dev-wiki 저장소 뿌리)."""
    cur = os.path.dirname(norm(path))
    while True:
        if os.path.exists(os.path.join(cur, MARK)):
            return cur
        parent = os.path.dirname(cur)
        if parent == cur:
            return None
        cur = parent


def session_in_repo(cwd):
    if not cwd:
        return False
    if harness_repo(os.path.join(cwd, "x")):
        return True
    # git은 경로를 UTF-8로 낸다. 기본 인코딩(cp949)으로 읽으면 한글 경로에서 stdout이 None이 되어 훅이 죽고,
    # 죽은 PreToolUse 훅은 묻지 않고 통과시킨다. 알 수 없으면 dev-wiki 세션이 아닌 것으로 보고 묻는다.
    try:
        r = subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=cwd, capture_output=True,
                           encoding="utf-8", errors="replace", timeout=10)
    except (OSError, subprocess.SubprocessError):
        return False
    top = (r.stdout or "").strip()
    return bool(top) and os.path.exists(os.path.join(top, MARK))


def main():
    try:
        data = json.loads(sys.stdin.buffer.read().decode("utf-8") or "{}")
    except ValueError:
        return  # 고칠 파일을 모르면 판단할 것이 없다
    tool_input = data.get("tool_input") or {}
    target = tool_input.get("file_path") or tool_input.get("notebook_path") or ""
    if not target:
        return
    repo = harness_repo(target)
    if not repo:
        return
    rel = os.path.relpath(norm(target), repo)
    if rel.split(os.sep)[0] not in SOURCES or session_in_repo(data.get("cwd")):
        return
    reason = (f"dev-wiki 하네스 원본({rel})이다. 프로젝트 세션에서는 원본을 고치지 않고 문제와 근거를 보고한다. "
              "사용자가 이 세션에서 고치라고 했을 때만 승인한다. 고친 뒤에는 dev-wiki에서 release.mjs로 반영해야 설치본에 들어간다.")
    out = {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "ask", "permissionDecisionReason": reason}}
    sys.stdout.buffer.write(json.dumps(out, ensure_ascii=False).encode("utf-8"))


if __name__ == "__main__":
    main()
