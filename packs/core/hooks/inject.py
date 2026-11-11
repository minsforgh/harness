"""SessionStart 훅: 이 플러그인 폴더의 규칙 파일들(인자)을 세션 맥락에 넣는다.

규칙을 프로젝트 AGENTS.md에 복사하지 않고 플러그인이 직접 주입한다. 원본이 한 곳이라 프로젝트마다 어긋나지 않고,
release로 버전을 올리면 다음 세션부터 모든 프로젝트에 같이 반영된다. 압축 뒤 SessionStart(compact)에도 다시 들어간다.
인자 안의 {docs}는 프로젝트의 문서 수준(AGENTS.md "값" 표, 없으면 standard)으로 바꾼다: inject.py rules.md docs-{docs}.md

문서 전체 검사(harness-design Q116): 새 세션(startup, resume)에서 하루 한 번 `.githooks/harness_checks.py --all`을 돌려
문제가 있거나 검사가 실패하면 사용자에게 한 줄(systemMessage). 커밋 전 검사는 그 커밋의 문서만 보므로 코드가 옮겨져 끊긴
경로 같은 어긋남은 여기서 보인다. 고치지는 않는다. 날짜는 검사가 끝난 뒤 git 디렉터리의 harness-doc-check에 남긴다.
HARNESS_DOC_CHECK=0이면 끈다.
"""
import datetime as dt
import json
import os
import re
import subprocess
import sys

ROOT = os.environ.get("CLAUDE_PLUGIN_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.dont_write_bytecode = True  # 원본과 설치본 폴더에 __pycache__를 남기지 않는다
sys.path.insert(0, os.path.join(ROOT, "lib"))
from project import level_info, read_agents, repo_root  # noqa: E402


def doc_check(root, source):
    """하루 한 번 전체 문서 검사. 문제가 있으면 알림 한 줄."""
    launcher = os.path.join(root, ".githooks", "harness_checks.py")
    if source not in ("startup", "resume") or os.environ.get("HARNESS_DOC_CHECK") == "0" or not os.path.exists(launcher):
        return None
    try:
        r = subprocess.run(["git", "rev-parse", "--git-common-dir"], cwd=root, capture_output=True, encoding="utf-8", errors="replace")
        stamp = os.path.join(root, r.stdout.strip(), "harness-doc-check") if r.returncode == 0 and r.stdout.strip() else None
        today = dt.date.today().isoformat()
        if not stamp or (os.path.exists(stamp) and open(stamp, encoding="utf-8").read().strip() == today):
            return None
    except (OSError, ValueError):
        return None
    see = "보기: python .githooks/harness_checks.py --all"
    try:
        out = subprocess.run([sys.executable, launcher, "--all"], cwd=root, capture_output=True, encoding="utf-8",
                             errors="replace", timeout=30, env={**os.environ, "PYTHONIOENCODING": "utf-8"})
    except subprocess.TimeoutExpired:
        mark(stamp, today)  # 느린 검사를 새 세션마다 다시 돌려 시작을 늦추지 않는다
        return f"[harness] 문서 전체 검사가 30초 안에 끝나지 않아 오늘은 건너뛴다. {see}"
    except OSError:
        return None
    mark(stamp, today)  # 검사가 끝난 뒤에 남긴다. 돌지 못한 날은 다음 세션이 다시 돈다
    n = sum(int(x) for x in re.findall(r"문제 (\d+)개", (out.stdout or "") + (out.stderr or "")))
    if n:
        return f"[harness] 문서 전체 검사: 문제 {n}개. {see} (고치는 것은 요청할 때)"
    if out.returncode != 0:
        return f"[harness] 문서 전체 검사가 실패했다(종료 코드 {out.returncode}). {see}"
    return None


def mark(stamp, today):
    try:
        with open(stamp, "w", encoding="utf-8") as f:
            f.write(today)
    except OSError:
        pass


def main():
    try:
        data = json.loads(sys.stdin.buffer.read().decode("utf-8") or "{}")
    except ValueError:
        data = {}
    root = repo_root(data.get("cwd") or os.getcwd())
    level, unknown = level_info(read_agents(root))
    texts = []
    if unknown:
        texts.append(f"[harness-core] AGENTS.md \"값\" 표의 문서 수준 '{unknown}'를 몰라 standard 규칙을 넣었다. standard나 light로 고친다.")
    for name in sys.argv[1:] or ["rules.md"]:
        try:
            with open(os.path.join(ROOT, name.replace("{docs}", level)), encoding="utf-8") as f:
                text = f.read().strip()
        except OSError:
            continue
        if text:
            texts.append(text)
    out = {}
    if texts:
        out["hookSpecificOutput"] = {"hookEventName": "SessionStart", "additionalContext": "\n\n".join(texts)}
    msg = doc_check(root, data.get("source") or "startup")
    if msg:
        out["systemMessage"] = msg
    if out:
        sys.stdout.buffer.write(json.dumps(out, ensure_ascii=False).encode("utf-8"))


if __name__ == "__main__":
    main()
