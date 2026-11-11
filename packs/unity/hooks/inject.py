"""SessionStart 훅 (harness-unity): rules.md를 세션 맥락에 넣고, Unity 프로젝트 경로와 pipeline 패키지 상태를 한 줄 알린다.

Unity 프로젝트는 AGENTS.md "값" 표의 `| Unity 프로젝트 | <경로> |` 행이다(저장소 뿌리 기준, 행이 없으면 뿌리).
패키지 버전마다 명령이 다르다: 0.9.x의 capture `save_path`는 맨 경로를 Assets/ 아래로 붙여 저장하고 .meta를 만들며,
`script eval --file`이 없다(0.10부터). 그래서 세션마다 버전을 알려 맞는 쪽을 쓰게 한다.
"""
import json
import os
import re
import subprocess
import sys

ROOT = os.environ.get("CLAUDE_PLUGIN_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROW = re.compile(r"^\|\s*Unity\s*프로젝트\s*\|([^|\n]*)\|", re.M)
VERSION = re.compile(r"^(\d+)\.(\d+)")


def repo_root(cwd):
    # git은 경로를 UTF-8로 낸다. 이 PC의 기본 인코딩(cp949)으로 읽으면 한글 경로에서 stdout이 None이 된다.
    try:
        r = subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=cwd, capture_output=True,
                           encoding="utf-8", errors="replace")
    except (OSError, ValueError):
        return os.path.abspath(cwd)
    top = (r.stdout or "").strip()
    return os.path.abspath(top) if r.returncode == 0 and top else os.path.abspath(cwd)


def unity_dir(root):
    try:
        with open(os.path.join(root, "AGENTS.md"), encoding="utf-8-sig", errors="replace") as f:
            m = ROW.search(f.read())
    except OSError:
        m = None
    rel = m.group(1).strip().strip("`*_").strip() if m else "."
    if not rel or rel.startswith("<"):
        rel = "."
    return os.path.normpath(os.path.join(root, rel))


def package_note(project):
    manifest = os.path.join(project, "Packages", "manifest.json")
    try:
        with open(manifest, encoding="utf-8-sig") as f:
            deps = json.load(f).get("dependencies") or {}
    except OSError:
        return (f"[harness-unity] Unity 프로젝트를 찾지 못했다({manifest} 없음). "
                "AGENTS.md \"값\" 표의 Unity 프로젝트 행(저장소 뿌리 기준 경로)을 고친다.")
    except ValueError:
        return f"[harness-unity] {manifest}를 JSON으로 읽지 못했다. Unity 프로젝트: {project}"
    version = deps.get("com.unity.pipeline")
    if not version:
        return (f"[harness-unity] Unity 프로젝트 {project}에 com.unity.pipeline 패키지가 없다. unity CLI로 에디터를 조종하려면 "
                f"사용자에게 묻고 `unity pipeline install --project-path \"{project}\"`를 돌린다.")
    m = VERSION.match(str(version))
    if not m:
        return f"[harness-unity] Unity 프로젝트 {project}, com.unity.pipeline {version}(버전을 읽지 못함)."
    if (int(m.group(1)), int(m.group(2))) < (0, 10):
        return (f"[harness-unity] Unity 프로젝트 {project}, com.unity.pipeline {version}: 0.10 아래다. "
                "capture의 `save_path`는 Assets/ 아래에 저장하고 .meta를 만들므로 경로 없이 받고, "
                "파일 eval은 `script eval_file`을 쓴다(`script eval --file` 없음). "
                f"올리려면 사용자에게 묻고 `unity pipeline upgrade --project-path \"{project}\"`.")
    return f"[harness-unity] Unity 프로젝트 {project}, com.unity.pipeline {version}."


def main():
    try:
        data = json.loads(sys.stdin.buffer.read().decode("utf-8") or "{}")
    except ValueError:
        data = {}
    root = repo_root(data.get("cwd") or os.getcwd())
    texts = [package_note(unity_dir(root))]
    try:
        with open(os.path.join(ROOT, "rules.md"), encoding="utf-8") as f:
            # 규칙의 <harness-unity>를 설치본 경로로 바꿔, agent-scripts/ 파일을 스킬 없이 바로 부를 수 있게 한다.
            texts.append(f.read().strip().replace("<harness-unity>", ROOT.replace("\\", "/")))
    except OSError:
        pass
    out = {"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "\n\n".join(t for t in texts if t)}}
    sys.stdout.buffer.write(json.dumps(out, ensure_ascii=False).encode("utf-8"))


if __name__ == "__main__":
    sys.dont_write_bytecode = True
    main()
