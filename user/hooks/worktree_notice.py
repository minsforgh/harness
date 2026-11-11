"""개인 모드 worktree 알림 (harness-user 세션 시작 훅이 부른다).

개인 모드(apply --personal)는 harness 묶음을 local 범위(.claude/settings.local.json, git에 안 들어감)로 켠다.
새 worktree(Orca, git worktree add)에는 그 파일이 따라가지 않아 묶음이 꺼진 채로 시작한다.
그 경우에만 한 줄로 알리고 켜는 명령을 보여 준다. 자동으로 복사하지 않는다(harness-design Q5 결정).
"""
import json
import os
import re
import subprocess

PACK = re.compile(r"^harness-([a-z0-9-]+)@harness$")


def _git(cwd, *args):
    try:
        r = subprocess.run(["git", *args], cwd=cwd, capture_output=True, encoding="utf-8", errors="replace", timeout=10)
    except (OSError, ValueError, subprocess.SubprocessError):
        return None
    return r.stdout.strip() if r.returncode == 0 else None


def _states(root, name):
    """한 설정 파일의 묶음마다 켬(True)/끔(False). 적히지 않은 묶음은 없다."""
    try:
        with open(os.path.join(root, ".claude", name), encoding="utf-8-sig") as f:
            plugins = json.load(f).get("enabledPlugins") or {}
    except (OSError, ValueError, AttributeError):
        return {}
    out = {}
    for pid, v in plugins.items():
        m = PACK.match(pid)
        if m and isinstance(v, bool) and m.group(1) != "user":
            out[m.group(1)] = v
    return out


def _apply_path():
    config = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")
    try:
        with open(os.path.join(config, "plugins", "known_marketplaces.json"), encoding="utf-8") as f:
            root = ((json.load(f).get("harness") or {}).get("source") or {}).get("path")
    except (OSError, ValueError, AttributeError):
        root = None
    return os.path.join(root, "apply.mjs") if root and os.path.isdir(root) else "<dev-wiki>/_harness/apply.mjs"


def notice(cwd):
    out = _git(cwd, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir")
    lines = (out or "").splitlines()
    if len(lines) != 2 or os.path.basename(lines[1].rstrip("/\\")) != ".git":
        return None
    here, main = os.path.normcase(os.path.abspath(lines[0])), os.path.dirname(os.path.abspath(lines[1].rstrip("/\\")))
    if os.path.normcase(main) == here:
        return None
    local = {p for p, v in _states(main, "settings.local.json").items() if v}
    # worktree의 local에 적힌 값(켬이든 끔이든)은 사용자가 고른 것이라 알리지 않는다.
    here_local, here_project = _states(lines[0], "settings.local.json"), _states(lines[0], "settings.json")
    missing = sorted(p for p in local if p not in here_local and here_project.get(p) is not True)
    if not missing:
        return None
    order = ("core", "unity", "orca")  # 마켓플레이스 순서(apply는 앞 묶음 위에 뒤 묶음을 얹는다)
    wanted = {p for p in local if here_local.get(p) is not False} | {"core"}
    packs = ",".join(sorted(wanted, key=lambda p: (order.index(p) if p in order else len(order), p)))
    return (f"[harness] 이 worktree에는 main worktree({main})에서 local로 켠 묶음({', '.join('harness-' + p for p in missing)})이 꺼져 있다. "
            f"켜려면: node \"{_apply_path()}\" \"{os.path.abspath(lines[0])}\" --personal --packs {packs} 뒤 새 세션")
