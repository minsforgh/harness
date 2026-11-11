"""SessionStart hook (harness-user): 전역 지시(instructions.md)를 세션 맥락에 넣고, 갱신 알림을 낸다.

설정 폴더가 여럿(~/.claude, Orca 프로필)이어도 이 플러그인을 켠 곳이면 같은 지시를 받는다.
CLAUDE.md 사본을 폴더마다 두지 않기 위해서다.

갱신(harness-design 4절 "외부 갱신"): 새 세션(startup, resume)마다 저장된 확인 결과에 갱신이 있으면 사용자에게 한 줄
(systemMessage). 마지막 확인이 하루 가까이 지났으면 update_check.py를 뒤에서 띄운다(세션 시작을 기다리게 하지 않는다).
HARNESS_UPDATE_CHECK=0이면 둘 다 하지 않는다.

개인 모드 worktree(worktree_notice.py): main worktree에서 local로 켠 harness 묶음이 이 worktree에 꺼져 있으면 한 줄.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.dont_write_bytecode = True  # 설치본 폴더에 __pycache__를 남기지 않는다
sys.path.insert(0, HERE)


def update_notice(source):
    if source not in ("startup", "resume") or os.environ.get("HARNESS_UPDATE_CHECK") == "0":
        return None
    try:
        import update_check
        msg = update_check.notice()
        if update_check.due():
            update_check.spawn_background()
        return msg
    except Exception:  # 알림 때문에 세션 시작을 막지 않는다
        return None


def worktree_notice(data):
    if (data.get("source") or "startup") not in ("startup", "resume"):
        return None
    try:
        import worktree_notice as w
        return w.notice(data.get("cwd") or os.getcwd())
    except Exception:  # 알림 때문에 세션 시작을 막지 않는다
        return None


def main():
    try:
        data = json.loads(sys.stdin.buffer.read().decode("utf-8") or "{}")
    except ValueError:
        data = {}
    root = os.environ.get("CLAUDE_PLUGIN_ROOT") or os.path.dirname(HERE)
    try:
        with open(os.path.join(root, "instructions.md"), encoding="utf-8") as f:
            text = f.read().strip()
    except OSError:
        text = ""
    out = {}
    if text:
        out["hookSpecificOutput"] = {"hookEventName": "SessionStart", "additionalContext": text}
    msgs = [update_notice(data.get("source") or "startup"), worktree_notice(data)]
    if any(msgs):
        out["systemMessage"] = "\n".join(m for m in msgs if m)
    if out:
        sys.stdout.buffer.write(json.dumps(out, ensure_ascii=False).encode("utf-8"))


if __name__ == "__main__":
    main()
