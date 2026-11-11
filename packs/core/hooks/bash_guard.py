"""PreToolUse(Bash) 훅 (harness-core): 실패가 확인된 두 경우만 다룬다.

1. 약 7,900자가 넘는 Bash 명령은 잘려 `unexpected EOF`로 실패했다(MaxwellDemon). -> 거부하고 파일로 쓰게 한다.
2. heredoc으로 넣은 python/node 스크립트 안의 백슬래시가 바뀌어 들어갔다(MaxwellDemon, dev-wiki 세션). -> 백슬래시가 있을 때만 알린다.

셸로 파일을 읽는 명령(cat, grep 등)은 경고하지 않는다. 하네스 시스템 프롬프트가 허용하고, 경고해도 무시됐다.
엔진별 안내(unity eval, 캡처 크기)는 그 엔진 묶음의 훅이 맡는다.
"""
import json
import re
import sys

MAX_CHARS = 7500
HEREDOC = re.compile(r"\b(python3?|py|node)\b[^\n|;&]*<<", re.I)


def main():
    try:
        data = json.loads(sys.stdin.buffer.read().decode("utf-8") or "{}")
    except ValueError:
        return
    command = (data.get("tool_input") or {}).get("command") or ""
    heredoc = HEREDOC.search(command)
    if len(command) > MAX_CHARS:
        reason = (f"명령이 {len(command)}자다. {MAX_CHARS}자가 넘으면 잘려서 실패한다. "
                  "코드와 문서는 Edit/Write로 고치고, 긴 스크립트는 Write로 scratchpad에 파일을 쓴 뒤 그 파일을 실행하라.")
        out = {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                      "permissionDecisionReason": reason}}
    elif heredoc and "\\" in command[heredoc.end():]:
        out = {"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext":
               "heredoc 스크립트에 백슬래시가 있다. 이 환경에서는 heredoc 안 백슬래시가 바뀌어 들어간 적이 있다. "
               "결과가 이상하면 Write로 scratchpad에 스크립트 파일을 쓰고 실행하라."}}
    else:
        return
    sys.stdout.buffer.write(json.dumps(out, ensure_ascii=False).encode("utf-8"))


if __name__ == "__main__":
    main()
