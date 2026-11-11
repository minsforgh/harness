"""harness-core 스크립트(규칙 주입 훅, 커밋 전 검사)가 같이 쓰는 프로젝트 정보 읽기.

문서 수준은 프로젝트 AGENTS.md "값" 표의 `| 문서 수준 | standard |` 행이다. apply.mjs가 프로필에 맞춰 넣는다.
값의 백틱과 굵게 표시는 벗기고 읽는다. 행이 없으면 standard, 값을 모르면 standard로 보고 그 값을 알린다.
"""
import os
import re
import subprocess

LEVELS = ("standard", "light")
ROW = re.compile(r"^\|\s*문서\s*수준\s*\|([^|\n]*)\|", re.M)


def repo_root(cwd):
    # git은 경로를 UTF-8로 낸다. 이 PC의 기본 인코딩(cp949)으로 읽으면 한글 경로에서 stdout이 None이 된다.
    try:
        r = subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=cwd, capture_output=True,
                           encoding="utf-8", errors="replace")
    except (OSError, ValueError):
        return os.path.abspath(cwd)
    top = (r.stdout or "").strip()
    return os.path.abspath(top) if r.returncode == 0 and top else os.path.abspath(cwd)


def level_info(text):
    """(수준, 못 읽은 값). 행이 없으면 ("standard", None), 값을 모르면 ("standard", 그 값)."""
    m = ROW.search(text or "")
    if not m:
        return "standard", None
    value = m.group(1).strip().strip("`*_").strip().lower()
    if value in LEVELS:
        return value, None
    return "standard", m.group(1).strip() or "(빈칸)"


def read_agents(root):
    try:
        with open(os.path.join(root, "AGENTS.md"), encoding="utf-8-sig", errors="replace") as f:
            return f.read()
    except OSError:
        return ""


def docs_level(root):
    return level_info(read_agents(root))[0]
