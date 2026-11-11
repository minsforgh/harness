"""Stop 훅 (harness-user): 답에 붙은 `wiki 후보:` 줄을 dev-wiki 환류 대기열에 모은다. 기록은 하지 않는다.

전역 지시 "dev-wiki 환류"에 따라 에이전트가 보고 끝에 `wiki 후보: <한 줄>`을 붙이면, 그 줄만 기계적으로
~/.claude/harness-wiki-candidates.jsonl(설정 폴더가 여럿이어도 한 곳)에 더한다. 무엇이 지식인지는 판단하지 않는다.
dev-wiki 세션의 daily-sync가 대기열을 보여 주고 사용자가 고른 것만 반영한다(harness-design Q174).
- 같은 프로젝트의 같은 글은 한 번만 넣는다
- dev-wiki 안에서 연 세션은 넣지 않는다(그 세션은 그 자리에서 기록한다)
- 저장소 파일은 건드리지 않는다. 팀 저장소 세션이어도 이 PC의 대기열에만 쓴다
- Codex 세션은 이 훅이 돌지 않아 모이지 않는다
- 끄기: HARNESS_WIKI_CANDIDATES=0. 대기열 경로 바꾸기(시험용): HARNESS_WIKI_QUEUE
"""
import datetime
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from guard_source import session_in_repo  # noqa: E402
from korean_reply import last_assistant_text  # noqa: E402

LINE = re.compile(r"^\s*(?:[-*]\s*)?\**wiki 후보\**\s*:\s*\**\s*(.+?)\s*$", re.MULTILINE)


def queue_path():
    return os.environ.get("HARNESS_WIKI_QUEUE") or os.path.join(os.path.expanduser("~"), ".claude", "harness-wiki-candidates.jsonl")


def main():
    if os.environ.get("HARNESS_WIKI_CANDIDATES") == "0":
        return
    try:
        data = json.loads(sys.stdin.buffer.read().decode("utf-8") or "{}")
    except ValueError:
        return
    if not isinstance(data, dict):
        return
    found = [m.strip() for m in LINE.findall(last_assistant_text(data) or "") if m.strip()]
    cwd = data.get("cwd") or ""
    if not found or not cwd or session_in_repo(cwd):
        return
    path = queue_path()
    seen = set()
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                try:
                    e = json.loads(line)
                    seen.add((os.path.normcase(e.get("project", "")), e.get("text", "")))
                except ValueError:
                    continue
    except OSError:
        pass
    project = os.path.abspath(cwd)
    new = [t for t in dict.fromkeys(found) if (os.path.normcase(project), t) not in seen]
    if not new:
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    today = datetime.date.today().isoformat()
    with open(path, "a", encoding="utf-8") as f:
        for t in new:
            f.write(json.dumps({"date": today, "project": project, "session": data.get("session_id", ""), "text": t},
                               ensure_ascii=False) + "\n")


if __name__ == "__main__":
    try:
        main()
    except Exception:  # 훅이 죽어도 답을 막지 않는다
        pass
