"""SessionStart 훅 (harness-orca): 오케스트레이션 값이 비었으면 한 줄로 알린다. 채워져 있으면 아무것도 넣지 않는다.

규칙은 세션마다 넣지 않는다. 명령과 절차는 Orca 공식 orchestration 스킬, 정책은 harness-orca:orchestrate와 milestone-start에 있고
오케스트레이션을 할 때만 읽힌다(이 묶음을 켠 프로젝트에서도 직접 하는 작업이 많다).
값 표 읽기는 skills/orchestrate/values.mjs와 같다: "값" 절 안의 표만, 이스케이프하지 않은 |로 나눠 첫 칸이 이름, 둘째 칸이 값.
"""
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SPLIT = re.compile(r"(?<!\\)\|")
SEPARATOR = re.compile(r"^:?-+:?$")
SECTION = re.compile(r"^#{2,3}\s+값(\s|$)")


def repo_root(cwd):
    # git은 경로를 UTF-8로 낸다. 기본 인코딩(cp949)으로 읽으면 한글 경로에서 죽는다.
    try:
        r = subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=cwd, capture_output=True,
                           encoding="utf-8", errors="replace", timeout=10)
    except (OSError, ValueError, subprocess.SubprocessError):
        return os.path.abspath(cwd)
    top = (r.stdout or "").strip()
    return os.path.abspath(top) if r.returncode == 0 and top else os.path.abspath(cwd)


def cells(line):
    parts = SPLIT.split(line.strip())
    if parts and not parts[-1].strip():
        parts.pop()
    return [c.strip().replace("\\|", "|") for c in parts[1:]]


def strip(v):
    return re.sub(r"^[`*_]+|[`*_]+$", "", v).strip()


def is_separator(c):
    return bool(c) and all(SEPARATOR.match(x) for x in c)


def table_rows(lines):
    rows = []
    for i, line in enumerate(lines):
        if not line.lstrip().startswith("|"):
            continue
        c = cells(line)
        if len(c) < 2 or is_separator(c):
            continue
        nxt = lines[i + 1] if i + 1 < len(lines) else ""
        if nxt.lstrip().startswith("|") and is_separator(cells(nxt)):
            continue
        rows.append((re.sub(r"\s+", " ", strip(c[0])), strip(c[1])))
    return rows


def value_section(text):
    lines = text.splitlines()
    at = next((i for i, l in enumerate(lines) if SECTION.match(l)), None)
    if at is None:
        return []
    depth = len(re.match(r"^#+", lines[at]).group(0))
    end = next((i for i in range(at + 1, len(lines)) if re.match(r"^#{1,%d}\s" % depth, lines[i])), len(lines))
    return lines[at + 1:end]


def orca_rows():
    with open(os.path.join(HERE, "..", "values.md"), encoding="utf-8-sig") as f:
        return [name for name, _ in table_rows(f.read().splitlines())]


def empty_rows(text, required):
    rows = {}
    for name, value in table_rows(value_section(text)):
        rows.setdefault(name, value)
    return [n for n in required if not rows.get(n) or rows[n].startswith("<")]


def main():
    try:
        data = json.loads(sys.stdin.buffer.read().decode("utf-8") or "{}")
    except ValueError:
        data = {}
    try:
        required = orca_rows()
    except OSError:
        return
    root = repo_root(data.get("cwd") or os.getcwd())
    try:
        with open(os.path.join(root, "AGENTS.md"), encoding="utf-8-sig", errors="replace") as f:
            missing = empty_rows(f.read(), required)
    except OSError:
        missing = list(required)
    if not missing:
        return
    note = (f"[harness-orca] 오케스트레이션 값이 비었다({', '.join(missing)}). "
            "오케스트레이션을 시작하기 전에 harness-orca:milestone-start로 정한다. 직접 하는 작업에는 상관없다.")
    out = {"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": note}}
    sys.stdout.buffer.write(json.dumps(out, ensure_ascii=False).encode("utf-8"))


if __name__ == "__main__":
    sys.dont_write_bytecode = True
    main()
