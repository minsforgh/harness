"""SessionStart 훅 (harness-poc): rules.md를 세션 맥락에 넣는다.

규칙의 "느슨하게" 절은 core와 unity 규칙의 같은 일을 대신한다. 훅끼리 순서가 정해져 있지 않으므로
어느 줄을 대신하는지는 규칙 글 안에 적어 둔다(묶음을 끄면 원래 규칙대로 돌아간다).
"""
import json
import os
import sys

ROOT = os.environ.get("CLAUDE_PLUGIN_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    try:
        with open(os.path.join(ROOT, "rules.md"), encoding="utf-8") as f:
            text = f.read().strip()
    except OSError:
        return
    out = {"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": text}}
    sys.stdout.buffer.write(json.dumps(out, ensure_ascii=False).encode("utf-8"))


if __name__ == "__main__":
    sys.dont_write_bytecode = True
    main()
