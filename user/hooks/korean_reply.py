"""Stop hook (harness-user): 사용자에게 보이는 마지막 답이 한국어가 아니면 한 번 돌려보낸다.

MaxwellDemon `.claude/hooks/korean_reply.py`에서 옮겼다(2026-11-08).
코드 블록, 인라인 코드, 주소, 경로는 세지 않는다. 이미 한 번 돌려보낸 답(stop_hook_active)은 통과시켜 무한 반복을 막는다.
"""
import json
import re
import sys

MIN_LATIN = 40       # 영문 글자가 이보다 적으면 짧은 답이라 보지 않는다
MIN_HANGUL_RATIO = 0.3


def last_assistant_text(data):
    text = data.get("last_assistant_message")
    if isinstance(text, str) and text.strip():
        return text
    path = data.get("transcript_path")
    if not path:
        return ""
    parts = []
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                message = entry.get("message") or {}
                role = message.get("role") or entry.get("type")
                content = message.get("content")
                if role == "user":
                    # 사용자 입력(도구 결과 제외)이 오면 그 앞의 답은 지난 차례다.
                    if isinstance(content, str) or (isinstance(content, list) and any(c.get("type") == "text" for c in content if isinstance(c, dict))):
                        parts = []
                elif role == "assistant" and isinstance(content, list):
                    for c in content:
                        if isinstance(c, dict) and c.get("type") == "text":
                            parts.append(c.get("text", ""))
    except OSError:
        return ""
    return "\n".join(parts)


def prose(text):
    text = re.sub(r"```.*?```", " ", text, flags=re.S)
    text = re.sub(r"`[^`\n]*`", " ", text)
    text = re.sub(r"https?://\S+", " ", text)
    text = re.sub(r"\S*[/\\]\S*", " ", text)
    # 백틱 없이 쓴 식별자(harness-user:grilling, korean_reply.py, v0.1.1)도 원문 그대로 두는 것이라 세지 않는다.
    # 2026-11-09 스킬 이름만 적은 한국어 차례의 답이 영어로 판정돼 돌려보내졌다.
    text = re.sub(r"\S*[A-Za-z0-9][:_.\-][A-Za-z0-9]\S*", " ", text)
    return text


def main():
    try:
        data = json.loads(sys.stdin.buffer.read().decode("utf-8") or "{}")
    except ValueError:
        return
    if data.get("stop_hook_active"):
        return
    text = prose(last_assistant_text(data))
    hangul = len(re.findall(r"[가-힣]", text))
    latin = len(re.findall(r"[A-Za-z]", text))
    if latin < MIN_LATIN or hangul / (hangul + latin) >= MIN_HANGUL_RATIO:
        return
    out = {
        "decision": "block",
        "reason": "방금 답이 영어로 쓰였다. 사용자는 한국어 답을 원한다. 같은 내용을 한국어로 다시 써라(코드, 경로, 명령은 그대로 둔다).",
    }
    sys.stdout.buffer.write(json.dumps(out, ensure_ascii=False).encode("utf-8"))


if __name__ == "__main__":
    main()
