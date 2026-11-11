#!/usr/bin/env python3
"""하네스 평가: 프로젝트 하나의 대화 기록, Unity eval 기록, git에서 harness-design 7절 지표를 센다.

  python <dev-wiki>/_harness/eval/run.py <프로젝트> [--since 2026-11-07T23:50] [--until 2026-11-08T21:11]
         [--json] [--out <파일.json>] [--compare <기준선.json>]
  --transcripts <폴더>  대화 기록 폴더를 직접 준다(시험용, 여러 번). 주지 않으면 설정 폴더에서 찾는다.
  --codex <폴더>        Codex sessions 폴더를 직접 준다(시험용, 여러 번). 주지 않으면 Codex 홈에서 찾는다(--transcripts를 주면 보지 않는다).

- 시각은 로컬 시각으로 받는다. 대화 기록은 Claude와 Codex(~/.codex, Orca의 Codex 홈, CODEX_HOME의 sessions)를 본다.
  Codex 세션은 session_meta의 cwd가 이 저장소나 그 worktree 안인 것(지운 worktree는 시작 커밋으로 찾는다). 위쪽 지표는
  Claude만 세고(기준선과 같은 뜻), Codex는 "codex"에 따로 센다. agents에는 agent:model:effort마다와 세션마다의 수를 둘 다 둔다.
- 기계 지표는 같은 기록과 파일이면 다시 돌려도 같다. 판단이 필요한 것(새어 나간 버그, 보고와 실제 확인, "미정")은
  후보만 근거 위치와 걸린 말과 함께 뽑는다. 판정은 사람이 하고 결과 파일의 judged에 적는다(비교 표에는 판정만 올린다).
- 대화 기록 위치: ~/.claude와 Orca 프로필(<APPDATA>/orca/claude-profiles/<id>/home)의
  projects/<경로를 바꾼 이름>. 이 저장소의 worktree 경로도 본다. 하위 에이전트(sidechain)는 뺀다.
- 명령이 스크립트(래퍼)를 실행하면 그 내용도 본다: 대화 기록 전체(창 밖 포함)에서 그 호출 전에 Write로 쓴 마지막 내용,
  없으면 디스크의 셸 스크립트(프로젝트 안이나 절대 경로). 끝내 모르는 것은 wrapper_unknown으로 센다.
- 코드 수정은 프로젝트(worktree 포함) 안 파일만 센다. unity 명령으로 에셋을 바꾼 것(build)은 에셋 수정으로 따로 센다.
"""
import argparse
import collections
import datetime as dt
import glob
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
HARNESS = os.path.dirname(HERE)
DEV_WIKI = os.path.dirname(HARNESS)
CAP = 300  # 다음 일까지의 간격 상한(초). 사용자를 기다린 간격은 세지 않는다
LIMIT = 40  # 후보 목록 길이
MAX_SCRIPT = 256 * 1024  # 디스크에서 읽는 래퍼 크기 상한


def git(root, *args):
    r = subprocess.run(["git", "-c", "core.quotepath=off", *args], cwd=root, capture_output=True,
                       text=True, encoding="utf-8", errors="replace")
    return r.stdout if r.returncode == 0 else ""


def parse_ts(s):
    try:
        return dt.datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        return None


def local_arg(s):
    if not s:
        return None
    t = dt.datetime.fromisoformat(s)
    return t.astimezone() if t.tzinfo is None else t


def show(t):
    return t.astimezone().strftime("%m-%d %H:%M")


def snip(s, n=140):
    return re.sub(r"\s+", " ", s).strip()[:n]


# ---------- 기록 찾기 ----------

def config_homes():
    home = os.path.expanduser("~")
    homes = [os.path.join(home, ".claude")]
    appdata = os.environ.get("APPDATA") or os.path.join(home, "AppData", "Roaming")
    homes += sorted(glob.glob(os.path.join(appdata, "orca", "claude-profiles", "*", "home")))
    return [h for h in homes if os.path.isdir(os.path.join(h, "projects"))]


def mangle(p):
    return re.sub(r"[^A-Za-z0-9]", "-", os.path.normpath(p))


def transcript_dirs(root):
    want = {mangle(p).lower() for p in worktrees(root)}
    out = []
    for h in config_homes():
        base = os.path.join(h, "projects")
        out += [os.path.join(base, n) for n in sorted(os.listdir(base)) if n.lower() in want]
    return out


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(x.get("text", "") for x in content if isinstance(x, dict))
    return ""


# 도구 실패의 종류. 권한 거부와 막힘은 명령이 돌지 않은 것이라 sleep과 플레이 진입으로 세지 않는다.
FAIL_KINDS = [
    ("user_rejected", re.compile(r"^The user doesn't want to proceed")),
    ("permission", re.compile(r"^Permission for this action was denied|needs the user's confirmation")),
    ("blocked", re.compile(r"^(?:<tool_use_error>)?Blocked:|^.{0,80}PreToolUse.{0,80}(?:denied|blocked)", re.I | re.S)),
    ("command", re.compile(r"^Exit code \d+")),
]
NOT_RUN = {"user_rejected", "permission", "blocked"}


def failure_kind(text):
    t = text.lstrip()
    return next((k for k, p in FAIL_KINDS if p.search(t)), "tool_use")


def load(dirs, since, until):
    """세션별 사건 목록: user(사람 말, 슬래시 명령은 slash), atext(에이전트 글), use(도구 호출), res(도구 결과), compact(압축).
    writes: 창과 상관없이 대화 기록 전체에서 Write로 쓴 스크립트 (시각, 파일 이름, 내용), 시각순."""
    seen, sessions, writes, files, bad = set(), collections.defaultdict(list), [], 0, 0
    for d in dirs:
        for f in sorted(glob.glob(os.path.join(d, "*.jsonl"))):
            files += 1
            for line in open(f, encoding="utf-8", errors="replace"):
                if '"timestamp"' not in line:
                    continue
                try:
                    e = json.loads(line)
                except ValueError:
                    bad += 1
                    continue
                typ = e.get("type")
                if typ not in ("user", "assistant", "system") or e.get("isSidechain"):
                    continue
                uid = e.get("uuid") or line
                if uid in seen:
                    continue  # 이어 간 세션은 옛 줄을 다시 담는다
                seen.add(uid)
                t = parse_ts(e.get("timestamp"))
                if not t:
                    bad += 1
                    continue
                content = (e.get("message") or {}).get("content")
                if typ == "assistant":
                    for c in content if isinstance(content, list) else []:
                        inp = (c.get("input") or {}) if isinstance(c, dict) else {}
                        if isinstance(c, dict) and c.get("name") == "Write" and SCRIPT_FILE.search(str(inp.get("file_path", ""))):
                            writes.append((t, os.path.basename(str(inp["file_path"]).replace("\\", "/")), str(inp.get("content", ""))))
                if (since and t < since) or (until and t > until):
                    continue
                evs = sessions[e.get("sessionId") or os.path.basename(f)]
                if typ == "system":
                    if e.get("subtype") == "compact_boundary":
                        evs.append({"t": t, "k": "compact"})
                    continue
                if typ == "user":
                    if e.get("isCompactSummary") or e.get("isMeta"):
                        continue
                    results = [c for c in content if isinstance(c, dict) and c.get("type") == "tool_result"] if isinstance(content, list) else []
                    for c in results:
                        full = text_of(c.get("content"))
                        err = bool(c.get("is_error"))
                        # 오류 판정은 글 전체로 한다(긴 콘솔 출력 뒤쪽의 오류). 저장은 앞부분만
                        evs.append({"t": t, "k": "res", "id": c.get("tool_use_id"), "err": err, "text": full[:4000],
                                    "bad": bool(BAD_CHECK.search(full)), "fail": bool(FAIL_TEXT.search(full)),
                                    "kind": failure_kind(full) if err else None})
                    txt = "" if results else text_of(content).strip()
                    if txt.startswith("<command-name>"):
                        evs.append({"t": t, "k": "user", "text": txt, "slash": True})  # 턴은 나누지만 사람 말로 보지 않는다
                    elif txt and not txt.startswith("<"):  # 명령 출력, 시스템 알림은 사람 말이 아니다
                        evs.append({"t": t, "k": "user", "text": txt})
                    continue
                who = f"claude:{(e.get('message') or {}).get('model') or '?'}:{e.get('effort') or '?'}"  # 줄마다 그때의 effort
                for c in content if isinstance(content, list) else []:
                    if not isinstance(c, dict):
                        continue
                    if c.get("type") == "text" and c.get("text", "").strip():
                        evs.append({"t": t, "k": "atext", "text": c["text"]})
                    elif c.get("type") == "tool_use":
                        evs.append({"t": t, "k": "use", "id": c.get("id"), "name": c.get("name"), "input": c.get("input") or {}, "who": who})
    for evs in sessions.values():
        evs.sort(key=lambda x: x["t"])
    writes.sort(key=lambda w: w[0])
    return sessions, writes, files, bad


# ---------- Codex 기록 ----------
# 파일 하나가 세션 하나다. session_meta.cwd로 프로젝트(worktree 포함)를 고른다. 지운 worktree라 cwd가 지금 없으면
# session_meta.git의 commit_hash가 이 저장소의 커밋인지(그리고 repository_url이 있으면 원격 주소가 같은지)로 고른다.
# turn_context에 그 턴의 model과 effort. 도구 호출은 exec(JS 코드) 하나 안에 tools.exec_command, tools.apply_patch 등으로
# 들어 있다. exec 하나를 명령 호출 하나로 보고, 분류에는 exec_command의 cmd 글자만 쓴다(글자가 없으면 patch 본문을 뺀 코드).
# apply_patch가 고친 파일은 파일마다 Edit 하나로 본다. patch만 한 exec는 결과가 첫 Edit에 붙고(나머지는 group으로 따라간다),
# 실패한 patch는 코드 수정으로 세지 않는다. 오래 걸린 exec는 "Script running with cell ID n"으로 먼저 돌아오고, 결과는
# 그 셀을 기다린 wait의 출력에 온다(같은 호출의 결과로 붙인다). sleep 도구는 sleep으로 센다(같은 확인 반복으로는 세지 않는다).

PATCH_FILE = re.compile(r"\*\*\* (?:Add|Update|Delete) File: ((?:[^\n\"'`\\]|\\\\)+)")
PATCH_BODY = re.compile(r"\*\*\* Begin Patch.*?\*\*\* End Patch", re.S)
INNER_TOOL = re.compile(r"\btools\.(\w+)\(")
CELL = re.compile(r"^Script running with cell ID (\S+)")
CMD_LITERAL = re.compile(r"""\bcmd\s*:\s*("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)""", re.S)
# exec 결과의 종료 코드: 줄 맨 앞(짧은 이름표 뒤도 됨)에서 여는 JSON 객체 안. 출력에 섞인 파일 내용 속 "exit_code"는 보지 않는다
EXIT_CODE = re.compile(r'^(?:[\w.\- ]{0,40}:\s*)?\{[^\n]*?"exit_code"\s*:\s*(-?\d+)', re.M)
PREAMBLE = ("<", "# AGENTS.md instructions")


def codex_session_dirs():
    home = os.path.expanduser("~")
    appdata = os.environ.get("APPDATA") or os.path.join(home, "AppData", "Roaming")
    homes = [os.environ.get("CODEX_HOME"), os.path.join(home, ".codex"), os.path.join(appdata, "orca", "codex-runtime-home", "home")]
    out = []
    for h in homes:
        d = os.path.join(h, "sessions") if h else None
        if d and os.path.isdir(d) and os.path.normcase(os.path.abspath(d)) not in {os.path.normcase(os.path.abspath(x)) for x in out}:
            out.append(d)
    return out


def codex_items(content):
    if isinstance(content, list):
        return [x.get("text", "") for x in content if isinstance(x, dict)]
    return [content] if isinstance(content, str) else []


def codex_text(content):
    return "".join(codex_items(content))


def under(path, roots):
    p = os.path.normcase(os.path.abspath(path or ""))
    return any(p == r or p.startswith(r + os.sep) for r in roots)


def js_string(lit):
    if lit[0] == '"':
        try:
            return json.loads(lit)
        except ValueError:
            pass
    return re.sub(r"\\(.)", lambda m: {"n": "\n", "t": "\t"}.get(m.group(1), m.group(1)), lit[1:-1], flags=re.S)


def codex_command(code):
    """exec 안 명령 글자. cmd 글자가 없으면(변수로 넘김) patch 본문을 뺀 코드."""
    cmds = [js_string(m.group(1)) for m in CMD_LITERAL.finditer(code)]
    return "\n".join(cmds) if cmds else PATCH_BODY.sub("", code)


def remote_urls(repo):
    norm = lambda u: u.strip().rstrip("/").removesuffix(".git").lower()
    return {norm(l.split()[1]) for l in git(repo, "remote", "-v").splitlines() if len(l.split()) >= 2}, norm


def same_repo(meta, repo, cache):
    """지운 worktree의 세션: 지금 없는 cwd이고, 시작 커밋이 이 저장소에 있고, 원격 주소가 있으면 같다."""
    g = meta.get("git") if isinstance(meta.get("git"), dict) else {}
    commit, url = str(g.get("commit_hash") or ""), g.get("repository_url")
    if not repo or not re.fullmatch(r"[0-9a-f]{7,40}", commit) or os.path.exists(meta.get("cwd") or ""):
        return False
    if "urls" not in cache:
        cache["urls"], cache["norm"] = remote_urls(repo)
    if url and cache["urls"] and cache["norm"](url) not in cache["urls"]:
        return False
    if commit not in cache:
        cache[commit] = bool(git(repo, "rev-parse", "--verify", "--quiet", f"{commit}^{{commit}}").strip())
    return cache[commit]


def load_codex(dirs, since, until, roots, repo=None):
    """Claude load와 같은 사건 목록. roots: 프로젝트와 그 worktree 경로. repo: 지운 worktree 세션을 커밋으로 찾을 저장소."""
    roots = {os.path.normcase(os.path.abspath(r)) for r in roots}
    sessions, files, bad, recovered, cache = {}, 0, 0, 0, {}
    for d in dirs:
        for f in sorted(glob.glob(os.path.join(d, "**", "*.jsonl"), recursive=True)):
            evs, cwd, sid, who, cells = None, None, None, "codex:?:?", {}
            for line in open(f, encoding="utf-8", errors="replace"):
                try:
                    e = json.loads(line)
                except ValueError:
                    bad += 1
                    continue
                typ, p = e.get("type"), e.get("payload") or {}
                if typ == "session_meta":
                    cwd, sid = p.get("cwd"), p.get("id") or os.path.basename(f)
                    if not under(cwd, roots):
                        if not same_repo(p, repo, cache):
                            break  # 다른 프로젝트의 세션
                        recovered += 1
                    files += 1
                    evs = sessions.setdefault(f"codex-{sid}", [])
                    continue
                if evs is None:
                    continue
                if typ == "turn_context":
                    who = f"codex:{p.get('model') or '?'}:{p.get('effort') or '?'}"
                    continue
                t = parse_ts(e.get("timestamp"))
                if not t:
                    bad += 1
                    continue
                if (since and t < since) or (until and t > until):
                    continue
                if typ == "compacted":
                    evs.append({"t": t, "k": "compact"})
                    continue
                if typ != "response_item":
                    continue
                pt = p.get("type")
                if pt == "message":
                    if p.get("role") == "assistant":
                        text = codex_text(p.get("content")).strip()
                        if text:
                            evs.append({"t": t, "k": "atext", "text": text})
                    elif p.get("role") == "user":
                        # 한 메시지에 AGENTS 안내, 환경 정보, 사용자 글이 따로 들어온다. 사용자 글만 남긴다
                        text = "\n".join(x.strip() for x in codex_items(p.get("content")) if x.strip() and not x.lstrip().startswith(PREAMBLE))
                        if text:
                            evs.append({"t": t, "k": "user", "text": text})
                elif pt == "custom_tool_call" and p.get("name") == "exec":
                    code, cid = str(p.get("input") or ""), p.get("call_id")
                    inner = INNER_TOOL.findall(code)
                    runs = any(x in ("exec_command", "write_stdin") for x in inner)
                    for n, m in enumerate(PATCH_FILE.finditer(code) if "apply_patch" in inner else []):
                        path = m.group(1).replace("\\\\", "\\").strip()
                        path = path if os.path.isabs(path) else os.path.join(cwd or "", path)
                        ev = {"t": t, "k": "use", "id": f"{cid}#e{n}", "name": "Edit", "input": {"file_path": path}, "who": who,
                              "patch": "mixed" if runs else "only"}
                        if not runs:
                            if n == 0:
                                ev["id"] = cid  # patch만 한 exec의 결과(실패 포함)는 첫 Edit에 붙는다
                            else:
                                ev["group"] = cid
                        evs.append(ev)
                    if runs:
                        evs.append({"t": t, "k": "use", "id": cid, "name": "Bash", "input": {"command": codex_command(code)}, "who": who})
                    elif not inner or set(inner) - {"apply_patch"}:
                        evs.append({"t": t, "k": "use", "id": cid, "name": f"codex:{inner[0] if inner else 'exec'}", "input": {}, "who": who})
                elif pt == "function_call" and p.get("name") == "sleep":
                    try:
                        ms = int(json.loads(p.get("arguments") or "{}").get("duration_ms") or 0)
                    except (ValueError, AttributeError, TypeError):
                        ms = 0
                    evs.append({"t": t, "k": "use", "id": p.get("call_id"), "name": "Bash", "input": {"command": f"Start-Sleep -Milliseconds {ms}"},
                                "who": who, "synthetic": "sleep"})
                elif pt == "function_call" and p.get("name") == "wait":
                    try:
                        cell = str(json.loads(p.get("arguments") or "{}").get("cell_id"))
                    except (ValueError, AttributeError):
                        cell = None
                    if cell in cells:
                        cells[p.get("call_id")] = cells[cell]  # 이 wait의 출력은 그 셀을 띄운 exec의 결과다
                elif pt in ("custom_tool_call_output", "function_call_output"):
                    text = codex_text(p.get("output")) if not isinstance(p.get("output"), str) else p["output"]
                    cid = cells.get(p.get("call_id"), p.get("call_id"))
                    m = CELL.match(text)
                    if m:
                        cells[m.group(1)] = cid
                    aborted = text.startswith("aborted by user")
                    err = aborted or text.startswith("Script failed") or any(int(c) != 0 for c in EXIT_CODE.findall(text))
                    evs.append({"t": t, "k": "res", "id": cid, "err": err, "text": text[:4000],
                                "bad": bool(BAD_CHECK.search(text)), "fail": bool(FAIL_TEXT.search(text)),
                                "kind": ("user_rejected" if aborted else "command") if err else None})
    for evs in sessions.values():
        evs.sort(key=lambda x: x["t"])
    return {k: v for k, v in sessions.items() if v}, files, bad, recovered


# ---------- 도구 호출 나누기 ----------

# 0.9는 `unity command <묶음> <명령>`, 0.10은 `unity <묶음> <명령>`. editor.playmode, editor.console도 같은 묶음으로 본다.
UNITY = re.compile(r"\bunity\s+(?:command\s+)?([a-z][\w.]*)(?:\s+([a-z]\w*))?")
READ_SUB = {"get", "get_fields", "get_properties", "get_hierarchy", "find", "info", "status", "list", "active", "get_logs"}
BUILD_SUB = {"set_field", "set_property", "add", "delete", "copy", "move", "rename", "create", "save", "save_all",
             "save_contents", "set_active", "open", "instantiate", "refresh"}
VERIFY_KINDS = {"play", "capture", "console", "compile", "test", "read", "input"}
COMPILE_KINDS = {"compile", "console", "test"}
SLEEP = re.compile(r"\b(?:sleep|Start-Sleep(?:\s+-(?:Seconds|s))?)\s+(\d+(?:\.\d+)?)", re.I)
SLEEP_MS = re.compile(r"\bStart-Sleep\s+-(?:Milliseconds|m)\s+(\d+)", re.I)
COMMIT = re.compile(r"\bgit\s+(?:-[cC]\s+\S+\s+)*commit\b")
SCRIPT_FILE = re.compile(r"\.(sh|bash|ps1|py|cmd|bat)$", re.I)
SHELL_FILE = re.compile(r"\.(sh|bash|ps1|cmd|bat)$", re.I)  # 디스크에서 읽는 것(파이썬 도구는 글 안의 unity 낱말이 섞인다)
# 실행하는 스크립트만 본다(git add x.sh, cat x.sh는 아니다): 명령 맨 앞, ; & | ( 뒤, 또는 실행기 뒤
SCRIPT_CALL = re.compile(
    r"""(?:^|[;&|(\n]|(?<![\w./\\-])(?:bash|sh|zsh|pwsh|powershell(?:\.exe)?|python3?|source|call)(?:\s+-\w+)*)\s*["']?"""
    r"""([^\s'"`;|&<>()]+\.(?:sh|bash|ps1|py|cmd|bat))(?=["'\s;|&)]|$)""", re.I | re.M)
# 테스트 파일: tests/ 폴더, *Test.cs와 *Tests.cs(대문자 T. Latest.cs는 아님), test_*.py, *.test.js
TEST_PATH = re.compile(r"(^|/)[Tt]ests?(/|$)|(?-i:Tests?)\.cs$|(^|/)test_[^/]*$|[._]test\.[a-z]+$", re.I)


def unity_kind(group, sub):
    g, sub = group.replace("editor.", "", 1), sub or ""
    if g == "playmode" or group in ("editor_play", "editor_stop") or sub in ("set_auto_tick", "set_run_in_background"):
        return "play" if sub in ("start", "stop", "pause", "step", "set_auto_tick", "set_run_in_background") or group.startswith("editor_") else "read"
    if g in ("capture", "screenshot") or g.startswith("capture_"):
        return "capture"
    if g == "console":
        return "console"
    if g in ("recompile", "status") or (g == "script" and sub.startswith("recompile")):
        return "compile"
    if g == "test":
        return "test"
    if g in ("script", "eval", "eval_file"):
        return "script"
    if g == "runtime" and sub.startswith("simulate"):
        return "input"
    if sub in READ_SUB:
        return "read"
    if sub in BUILD_SUB:
        return "build"
    return "unity-other"


def disk_script(ref, roots, cache):
    """디스크의 스크립트 내용(프로젝트 안 상대 경로나 절대 경로). 없으면 None.
    셸 스크립트만 읽는다. 파이썬 도구(.githooks/check_docs.py 등)는 있으면 빈 내용으로 둔다(래퍼가 아니고, 글 안의 unity 낱말이 섞인다)."""
    m = re.match(r"^/([A-Za-z])/(.*)$", ref)  # git bash의 /c/Users/... 경로
    ref = f"{m.group(1)}:/{m.group(2)}" if m else ref
    for p in [ref] if os.path.isabs(ref) else [os.path.join(r, ref) for r in roots]:
        if p not in cache:
            try:
                if not SHELL_FILE.search(p):
                    cache[p] = "" if os.path.isfile(p) else None
                else:
                    cache[p] = open(p, encoding="utf-8", errors="replace").read() if os.path.getsize(p) <= MAX_SCRIPT else None
            except OSError:
                cache[p] = None
        if cache[p] is not None:
            return cache[p]
    return None


def wrappers(cmd, t, writes, roots, cache):
    """명령이 실행하는 스크립트들의 내용. (내용 목록, 모르는 스크립트 수)"""
    bodies, unknown = [], 0
    for ref in dict.fromkeys(SCRIPT_CALL.findall(cmd)):
        name = os.path.basename(ref.replace("\\", "/"))
        body = None
        for wt, wn, wc in writes:  # 그 호출 전에 마지막으로 쓴 내용(세션이 달라도 시각순)
            if wt > t:
                break
            if wn == name:
                body = wc
        if body is None:
            body = disk_script(ref, roots, cache)
        if body is None:
            unknown += 1
        else:
            bodies.append(body)
    return bodies, unknown


def classify(use, check_cmd, bodies=()):
    """호출 하나를 (분류, unity 종류 목록, sleep 초 목록, 본 명령)으로. bodies: 명령이 실행하는 래퍼 내용
    (세션마다 새로 만든 래퍼로 unity를 부르면 명령에는 unity가 안 보인다)."""
    name, inp = use["name"], use["input"]
    if name in ("Read", "Grep", "Glob"):
        return "explore", [], [], ""
    if name in ("Edit", "Write", "MultiEdit", "NotebookEdit"):
        return ("docs" if str(inp.get("file_path", "")).endswith(".md") else "code"), [], [], ""
    if name not in ("Bash", "PowerShell"):
        return "other", [], [], ""
    cmd = str(inp.get("command", ""))
    body = cmd + "".join("\n" + b for b in bodies)
    kinds = [unity_kind(m.group(1), m.group(2)) for m in UNITY.finditer(body)]
    sleeps = [float(m.group(1)) for m in SLEEP.finditer(body)] + [int(m.group(1)) / 1000 for m in SLEEP_MS.finditer(body)]
    if COMMIT.search(cmd):
        return "commit", kinds, sleeps, body
    if VERIFY_KINDS & set(kinds) or sleeps or (check_cmd and check_cmd in body):
        return "verify", kinds, sleeps, body
    if "script" in kinds:
        return "script", kinds, sleeps, body
    if "build" in kinds:
        return "build", kinds, sleeps, body
    if re.search(r"\bgit\b", cmd):
        return "git", kinds, sleeps, body
    return "shell", kinds, sleeps, body


def agents_value(root, key):
    try:
        text = open(os.path.join(root, "AGENTS.md"), encoding="utf-8").read()
    except OSError:
        return None
    m = re.search(r"^\|\s*" + re.escape(key) + r"\s*\|([^|\n]*)\|", text, re.M)
    v = m.group(1).strip().strip("`*_ ") if m else ""
    return v if v and not v.startswith("<") and v != "없음" else None


# ---------- 대화 기록 지표 ----------

BAD_CHECK = re.compile(r'"compilationFailed"\s*:\s*true|"consoleErrors"\s*:\s*[1-9]|"errorCount"\s*:\s*[1-9]|"errors"\s*:\s*[1-9]|error CS\d{4}')
BUG_WORDS = re.compile(r"안 ?[돼되]|버그|이상[해한하]|깨[져졌지]|안 ?보[여이]|안 ?나[와오]|틀[렸려]|오류|에러|않[아는네]|왜 .{0,30}\?")
DONE_WORDS = re.compile(r"완료|끝났|마쳤|커밋(했|함|을 했)|고쳤|반영했|됐습니다")
CLAIM_WORDS = re.compile(r"확인했|통과(했|함|합니다)|테스트[를가]? ?(돌|실행|통과)|돌려 ?(봤|보니)|검증했|문제 ?없(었|습|음)")
FAIL_TEXT = re.compile(r"\bFailed\b|\bFAIL\b|failed:|\"success\"\s*:\s*false|error CS\d{4}|Tests? failed", re.I)


def worktrees(root):
    return [root] + [os.path.normpath(l[9:].strip()) for l in git(root, "worktree", "list", "--porcelain").splitlines()
                     if l.startswith("worktree ")]


def transcript_metrics(sessions, root, check_cmd, writes=()):
    paths = worktrees(root)
    roots = {os.path.normcase(os.path.realpath(p)) for p in paths}
    dev_wiki = os.path.normcase(os.path.normpath(DEV_WIKI))
    own = os.path.normcase(os.path.normpath(root)) == dev_wiki
    m = {
        "minutes": collections.Counter(), "calls": collections.Counter(), "failures": collections.Counter(),
        "who_calls": collections.Counter(), "who_minutes": collections.Counter(), "who_verify": collections.Counter(),
        "who_failures": collections.Counter(), "who_sessions": collections.defaultdict(set),
        "sid_calls": collections.Counter(), "sid_minutes": collections.Counter(), "sid_who": collections.defaultdict(collections.Counter),
        "failure_kinds": collections.Counter(), "sleep_count": 0, "sleep_seconds": 0.0, "play_starts": 0, "captures": 0,
        "repeated_reads": 0, "eval_mixed": 0, "wrapper_calls": 0, "wrapper_unknown": 0,
        "commits": {"after_code_edit": 0, "no_compile_check": 0, "play_check_only": 0, "with_errors": 0,
                    "after_asset_only": 0, "asset_unchecked": 0, "samples": []},
        "compactions": {}, "dev_wiki": {"edits": 0, "commits": 0},
        "file_edits": {"edit": 0, "edit_chars": 0, "rewrite": 0, "rewrite_chars": 0, "rewrites": collections.Counter()},
    }
    cand = {"leaked_bugs": [], "claims_without_check": [], "undecided_mentions": [], "criteria_edit_after_fail": []}
    disk = {}

    def claim(a, sid):
        hit = CLAIM_WORDS.search(a["text"]) if a else None
        if hit:
            cand["claims_without_check"].append(f"{show(a['t'])} {sid[:8]} [{hit.group(0)}] {snip(a['text'])}")

    for sid, evs in sessions.items():
        uses = {e["id"]: e for e in evs if e["k"] == "use"}
        seen_cmds = set()
        last_code = last_asset = last_check = last_any = None
        turn_verified, last_atext, failed_check = False, None, False
        m["compactions"][sid[:8]] = sum(1 for e in evs if e["k"] == "compact")
        results = {e["id"]: e for e in evs if e["k"] == "res"}
        for i, e in enumerate(evs):
            k = e["k"]
            if k == "user":
                if not turn_verified:
                    claim(last_atext, sid)
                done = DONE_WORDS.search(last_atext["text"]) if last_atext else None
                bug = None if e.get("slash") else BUG_WORDS.search(e["text"])
                if done and bug:
                    cand["leaked_bugs"].append(f"{show(e['t'])} {sid[:8]} [{done.group(0)} -> {bug.group(0)}] {snip(e['text'])}")
                turn_verified, last_atext, failed_check = False, None, False
                continue
            if k == "atext":
                last_atext = e
                if "미정" in e["text"]:
                    cand["undecided_mentions"].append(f"{show(e['t'])} {sid[:8]} {snip(e['text'])}")
                continue
            if k == "res":
                use = uses.get(e["id"])
                if use and e["err"]:
                    m["failures"][use["name"]] += 1
                    m["failure_kinds"][e["kind"]] += 1
                    m["who_failures"][use.get("who") or "?"] += 1
                continue
            if k != "use":
                continue
            inp = e["input"]
            cmd = str(inp.get("command", "")) if e["name"] in ("Bash", "PowerShell") else ""
            bodies, unknown = wrappers(cmd, e["t"], writes, paths, disk) if cmd else ([], 0)
            if bodies or unknown:
                m["wrapper_calls"] += 1
                m["wrapper_unknown"] += 1 if unknown else 0
            cat, kinds, sleeps, body = classify(e, check_cmd, bodies)
            m["calls"][cat] += 1
            who = e.get("who") or "?"
            m["who_calls"][who] += 1
            m["who_sessions"][who].add(sid)
            m["who_verify"][who] += 1 if cat == "verify" else 0
            m["sid_calls"][sid] += 1
            m["sid_who"][sid][who] += 1
            nxt = next((x for x in evs[i + 1:] if x["k"] in ("use", "atext", "user")), None)
            if nxt and nxt["k"] != "user":
                gap = min(max((nxt["t"] - e["t"]).total_seconds(), 0), CAP) / 60
                m["minutes"][cat] += gap
                m["who_minutes"][who] += gap
                m["sid_minutes"][sid] += gap
            # realpath: ~/.claude/skills/<이름>처럼 dev-wiki로 이어진 링크(junction)를 거친 수정도 원본 수정으로 센다
            path = os.path.normcase(os.path.realpath(str(inp.get("file_path", "")))) if inp.get("file_path") else ""
            res = results.get(e.get("group") or e["id"])
            ran = not (res and res["kind"] in NOT_RUN)  # 권한 거부나 훅에 막힌 명령은 돌지 않았다
            failed_patch = e.get("patch") == "only" and bool(res and res["err"])  # Codex: 실패한 apply_patch는 고친 것이 아니다
            code_edit = cat == "code" and not failed_patch and any(path.startswith(r + os.sep) for r in roots)
            asset_edit = ran and "build" in kinds  # unity 명령으로 씬, 프리팹, 에셋을 바꿈
            if cat in ("code", "docs") and not failed_patch and any(path.startswith(r + os.sep) for r in roots):
                # 있는 파일을 Write로 통째 다시 쓴 것(결과가 "File created"가 아님)과 Edit의 새 글 양. 큰 다시 쓰기는 컨텍스트를 채운다
                fe = m["file_edits"]
                if e["name"] == "Write":
                    if res and not res["err"] and not res["text"].startswith("File created"):
                        fe["rewrite"] += 1
                        fe["rewrite_chars"] += len(str(inp.get("content", "")))
                        fe["rewrites"][os.path.basename(str(inp["file_path"]).replace("\\", "/"))] += 1
                elif not (res and res["err"]):
                    fe["edit"] += 1
                    news = [x.get("new_string", "") for x in inp.get("edits") or [] if isinstance(x, dict)] or [inp.get("new_string") or inp.get("new_source") or ""]
                    fe["edit_chars"] += sum(len(str(s)) for s in news)
            if cat in ("verify", "script"):
                turn_verified = True  # eval로 계산 결과를 본 것도 확인이다
                norm = re.sub(r"\s+", " ", cmd).strip()
                if norm in seen_cmds and not e.get("synthetic"):
                    m["repeated_reads"] += 1  # 그 사이에 고친 것 없이 같은 확인(Codex sleep 도구는 확인이 아니라 기다림)
                seen_cmds.add(norm)
            if cat == "verify" and ran:
                last_any = e
                m["sleep_count"] += len(sleeps)
                m["sleep_seconds"] += sum(sleeps)
                m["play_starts"] += len(re.findall(r"\b(?:playmode\s+start|editor_play)\b", body))
                m["captures"] += kinds.count("capture")
                m["eval_mixed"] += 1 if "script" in kinds else 0
                if COMPILE_KINDS & set(kinds) or (check_cmd and check_cmd in body):
                    last_check = e
                    if res and (res["fail"] or res["bad"] or (res["err"] and "test" in kinds)):
                        failed_check = True
            if failed_patch:
                pass
            elif cat in ("code", "docs") and not own and path.startswith(dev_wiki + os.sep):
                m["dev_wiki"]["edits"] += 1
            elif code_edit:
                last_code = e
                if failed_check and TEST_PATH.search(path.replace("\\", "/")):
                    cand["criteria_edit_after_fail"].append(f"{show(e['t'])} {sid[:8]} 확인 실패 뒤 테스트 파일 수정: {inp.get('file_path')}")
            if asset_edit:
                last_asset = e
            if (cat in ("code", "docs") and not failed_patch) or asset_edit:
                seen_cmds.clear()
            if cat == "commit":
                if not own and ("dev-wiki" in cmd or DEV_WIKI.replace("\\", "/") in cmd.replace("\\", "/")):
                    m["dev_wiki"]["commits"] += 1
                    continue
                c = m["commits"]
                since = lambda x, y: x is not None and x["t"] >= y["t"]
                if last_code:
                    # 코드를 고쳤으면 컴파일/콘솔/테스트로 본 것만 확인으로 친다
                    c["after_code_edit"] += 1
                    r = results.get(last_check["id"]) if since(last_check, last_code) else None
                    if not r:
                        c["no_compile_check"] += 1
                        if since(last_any, last_code):
                            c["play_check_only"] += 1  # 플레이, 캡처, 읽기로만 봤다
                    elif r["bad"]:
                        c["with_errors"] += 1
                        hit = BAD_CHECK.search(r["text"])
                        c["samples"].append(f"{show(e['t'])} {sid[:8]} {hit.group(0) if hit else '오류(결과 앞 4000자 뒤)'}")
                elif last_asset:
                    # 에셋만 바꿨으면 컴파일은 상관없고, 어떤 확인(플레이, 캡처, 읽기, 콘솔)이든 봤는지
                    c["after_asset_only"] += 1
                    c["asset_unchecked"] += 0 if since(last_any, last_asset) else 1
                last_code = last_asset = None
        if not turn_verified:
            claim(last_atext, sid)
    tot = sum(m["minutes"].values()) or 1
    verify = {
        "minutes": round(m["minutes"]["verify"], 1), "share": round(m["minutes"]["verify"] / tot, 3),
        "script_minutes": round(m["minutes"]["script"], 1), "calls": m["calls"]["verify"],
        "sleep_count": m["sleep_count"], "sleep_seconds": round(m["sleep_seconds"]),
        "play_starts": m["play_starts"], "captures": m["captures"], "repeated_reads": m["repeated_reads"],
        "eval_mixed": m["eval_mixed"], "wrapper_calls": m["wrapper_calls"], "wrapper_unknown": m["wrapper_unknown"],
    }
    tools = {"calls": sum(m["calls"].values()), "active_hours": round(tot / 60, 2),
             "minutes_by_category": {k: round(v, 1) for k, v in m["minutes"].most_common()},
             "calls_by_category": dict(m["calls"].most_common()), "failures_by_tool": dict(m["failures"].most_common()),
             "failures_by_kind": dict(m["failure_kinds"].most_common())}
    # agent:model:effort마다(값 표의 worker 후보와 같은 형식). effort를 바꾼 효과는 같은 일끼리 비교한다(세션 목록에서 고른다)
    agents = {"by_agent_effort": {w: {"sessions": len(m["who_sessions"][w]), "calls": n, "minutes": round(m["who_minutes"][w], 1),
                                      "verify_calls": m["who_verify"][w], "failures": m["who_failures"][w]}
                                  for w, n in m["who_calls"].most_common()},
              "sessions": [{"id": k, "who": [w for w, _ in m["sid_who"][k].most_common()], "calls": n, "minutes": round(m["sid_minutes"][k], 1)}
                           for k, n in m["sid_calls"].most_common()]}
    context = {"compactions": sum(m["compactions"].values()), "by_session": {k: v for k, v in m["compactions"].items() if v}}
    c = m["commits"]
    share = lambda a, b: round(a / b, 3) if b else None
    c["no_compile_check_share"] = share(c["no_compile_check"], c["after_code_edit"])
    c["with_errors_share"] = share(c["with_errors"], c["after_code_edit"])
    c["asset_unchecked_share"] = share(c["asset_unchecked"], c["after_asset_only"])
    fe = m["file_edits"]
    fe["rewrite_share"] = share(fe["rewrite"], fe["edit"] + fe["rewrite"])
    fe["rewrites"] = dict(fe["rewrites"].most_common(LIMIT))
    tools["file_edits"] = fe
    return tools, verify, c, context, m["dev_wiki"], cand, agents


# ---------- Unity eval 기록 ----------

def eval_usage(root, since, until):
    unity = agents_value(root, "Unity 프로젝트")
    base = os.path.join(root, unity) if unity else (root if os.path.exists(os.path.join(root, "ProjectSettings", "ProjectVersion.txt")) else None)
    f = os.path.join(base, "Library", "Pipeline", "eval-usage.jsonl") if base else None
    if not f or not os.path.exists(f):
        return None
    rows, unparsed = [], 0
    for line in open(f, encoding="utf-8", errors="replace"):
        if not line.strip():
            continue
        try:
            r = json.loads(line)
        except ValueError:
            unparsed += 1
            continue
        t = parse_ts(r.get("time"))
        if not t:
            unparsed += 1
        elif (not since or t >= since) and (not until or t <= until):
            rows.append(r)
    n = len(rows) or 1
    fps = [set(r.get("fingerprints") or []) for r in rows]
    fails = sum(1 for r in rows if not r.get("success"))
    stmts = sum(1 for r in rows if r.get("classification") == "statements")
    return {
        "file": os.path.relpath(f, root).replace("\\", "/"), "total": len(rows), "unparsed": unparsed,
        "by_command": dict(collections.Counter(r.get("command") for r in rows).most_common()),
        "statements_share": round(stmts / n, 3), "failures": fails, "fail_share": round(fails / n, 3),
        "reflection_nonpublic": sum(1 for s in fps if "System.Reflection.BindingFlags.NonPublic" in s),
        "find_objects": sum(1 for s in fps if any(re.search(r"\.Find(Any|First)?Objects?(Of|By)Type|GameObject\.Find(WithTag)?$", x) for x in s)),
    }


# ---------- git ----------

def git_metrics(root, since, until):
    rng = ([f"--since={since.isoformat()}"] if since else []) + ([f"--until={until.isoformat()}"] if until else [])
    out = git(root, "log", *rng, "--no-merges", "--format=%x01%H%x00%s", "--name-status")
    commits = []
    for block in out.split("\x01")[1:]:
        head, _, rest = block.partition("\n")
        sha, _, subject = head.partition("\x00")
        files = [l.split("\t") for l in rest.splitlines() if "\t" in l]  # 상태, 경로(이름 바꾸기는 옛 경로, 새 경로)
        commits.append((subject, [(f[0][:1], f[-1]) for f in files]))
    types = collections.Counter((re.match(r"(\w+)[(!:]", s) or re.match(r"(\S+)", s or "-")).group(1) for s, _ in commits)
    fixes = [(s, fs) for s, fs in commits if re.match(r"fix[(!:]", s)]
    tasks = git(root, "log", *rng, "-p", "--format=%x01", "--", "docs/tasks.md", ":(glob)docs/changes/**/tasks.md")
    overview = git(root, "log", *rng, "-p", "--format=%x01", "--", "docs/overview.md")
    diff_lines = lambda text, sign: [l for l in text.splitlines() if l.startswith(sign) and not l.startswith(sign * 3)]
    decision = lambda l: l.startswith("- ", 1) and "정할 때:" in l
    # 닫은 구조 결정: 커밋마다 지운 "정할 때:" 줄에서 다시 넣은 줄을 뺀 순수 감소(문구만 고친 것은 닫은 것이 아니다)
    closed = sum(max(0, sum(map(decision, diff_lines(b, "-"))) - sum(map(decision, diff_lines(b, "+")))) for b in overview.split("\x01"))
    n = len(commits) or None
    nf = len(fixes) or None
    with_tests = sum(1 for _, fs in fixes if any(TEST_PATH.search(p) for _, p in fs))
    return {
        "commits": len(commits), "by_type": dict(types.most_common()), "fix": len(fixes),
        "fix_share": round(len(fixes) / n, 3) if n else None,
        "fix_with_tests": with_tests, "fix_with_tests_share": round(with_tests / nf, 3) if nf else None,
        "fix_adding_tests": sum(1 for _, fs in fixes if any(st == "A" and TEST_PATH.search(p) for st, p in fs)),
        # 아래 셋은 하네스가 들인 관례라 기준선(하네스 전)에는 없다. 운용을 보는 수치이고 비교 표에 올리지 않는다
        "user_check_added": sum(1 for l in diff_lines(tasks, "+") if "(사용자 확인)" in l),
        "user_check_removed": sum(1 for l in diff_lines(tasks, "-") if "(사용자 확인)" in l),
        "decisions_closed": closed,
    }


# ---------- 출력 ----------

# (지표, 키, 좋은 쪽). 창 길이에 비례하는 수는 도구 시간당으로 비교한다. 좋은 쪽이 "짝"인 것은 판정한 결과와 같이 본다
COMPARE = [
    ("확인 시간 비율", "verify.share", "낮게, 판정한 새어 나간 버그가 늘지 않을 때만"),
    ("확인 호출/시간", "per_hour.verify_calls", "참고"),
    ("sleep 초/시간", "per_hour.sleep_seconds", "낮게"),
    ("플레이 진입/시간", "per_hour.play_starts", "낮게, 확인 시간과 같이"),
    ("캡처/시간", "per_hour.captures", "낮게, 확인 시간과 같이"),
    ("수정 없이 같은 확인 반복/시간", "per_hour.repeated_reads", "낮게"),
    ("코드를 고친 뒤 커밋", "commits_in_transcript.after_code_edit", "참고(아래 비율의 분모)"),
    ("그중 컴파일/콘솔/테스트 없이", "commits_in_transcript.no_compile_check_share", "낮게"),
    ("그중 마지막 확인이 오류", "commits_in_transcript.with_errors_share", "낮게"),
    ("에셋만 고친 뒤 커밋 중 확인 없이", "commits_in_transcript.asset_unchecked_share", "낮게"),
    ("압축/시간", "per_hour.compactions", "낮게"),
    ("dev-wiki 원본 수정/시간", "per_hour.dev_wiki_edits", "낮게"),
    ("있는 파일 고치기 중 Write로 통째", "tools.file_edits.rewrite_share", "낮게"),
    ("eval 여러 문장 비율", "eval_usage.statements_share", "낮게"),
    ("eval 실패 비율", "eval_usage.fail_share", "낮게"),
    ("fix 커밋 비율", "git.fix_share", "참고(국면에 따라 다르다)"),
    ("fix 중 테스트 파일을 함께 바꿈", "git.fix_with_tests_share", "높게"),
    ("래퍼 호출 중 내용 모름", "verify.wrapper_unknown", "0이어야 위 확인 수치를 믿는다"),
    ("판정: 새어 나간 버그", "judged.leaked_bugs", "낮게"),
    ("판정: 확인했다는 말과 실제가 다름", "judged.claims_without_check", "낮게"),
]


def dig(d, key):
    for p in key.split("."):
        d = d.get(p) if isinstance(d, dict) else None
    return d


def per_hour(r):
    h = r["tools"]["active_hours"] or None
    rate = lambda v: round(v / h, 2) if h and v is not None else None
    v = r["verify"]
    return {"verify_calls": rate(v["calls"]), "sleep_seconds": rate(v["sleep_seconds"]), "play_starts": rate(v["play_starts"]),
            "captures": rate(v["captures"]), "repeated_reads": rate(v["repeated_reads"]),
            "compactions": rate(r["context"]["compactions"]), "dev_wiki_edits": rate(r["dev_wiki"]["edits"])}


def report(r):
    v, c, e, g = r["verify"], r["commits_in_transcript"], r["eval_usage"], r["git"]
    fe = r["tools"]["file_edits"]
    w = r["window"]
    lines = [
        f"# 평가: {r['project']} ({w['since'] or '처음'} ~ {w['until'] or '지금'})",
        f"기록: 대화 기록 폴더 {r['sources']['transcript_dirs']}곳, 파일 {r['sources']['files']}개, 세션 {r['sources']['sessions']}개"
        f"(그중 Codex {r['sources'].get('codex_sessions', 0)}"
        + (f", 지운 worktree에서 커밋으로 찾음 {r['sources']['codex_recovered']}" if r["sources"].get("codex_recovered") else "") + ")"
        + (f", 읽지 못한 줄 {r['sources']['unparsed']}" if r["sources"].get("unparsed") else ""),
        "",
        f"- 확인 비용: 도구 시간 {r['tools']['active_hours']}시간 중 확인 {v['minutes']}분({v['share']:.0%}), 호출 {v['calls']}, "
        f"sleep {v['sleep_count']}번 {v['sleep_seconds']}초, 플레이 진입 {v['play_starts']}, 캡처 {v['captures']}, 수정 없이 같은 확인 반복 {v['repeated_reads']}"
        f" (eval만 부른 호출 {v['script_minutes']}분은 따로, eval을 섞은 확인 {v['eval_mixed']})",
        f"- 래퍼: 스크립트를 실행한 호출 {v['wrapper_calls']}, 그중 내용을 모름 {v['wrapper_unknown']}",
        f"- 커밋(대화 기록): 코드를 고친 뒤 커밋 {c['after_code_edit']}, 그중 컴파일/콘솔/테스트 없이 {c['no_compile_check']}"
        f"(플레이, 캡처, 읽기로만 본 것 {c['play_check_only']}), 마지막 확인이 오류 {c['with_errors']}. "
        f"에셋만 고친 뒤 커밋 {c['after_asset_only']}, 그중 아무 확인 없이 {c['asset_unchecked']}",
        f"- 컨텍스트: 압축 {r['context']['compactions']}번",
        f"- 프로젝트 파일 고치기: Edit {fe['edit']}번(새 글 {fe['edit_chars']}자), 있는 파일을 Write로 통째 {fe['rewrite']}번({fe['rewrite_chars']}자)"
        + (f" {fe['rewrites']}" if fe["rewrites"] else ""),
        f"- dev-wiki 원본: 프로젝트 세션이 고침 {r['dev_wiki']['edits']}, 커밋 {r['dev_wiki']['commits']}",
        f"- 실패한 도구 호출: {r['tools']['failures_by_tool'] or '없음'}, 종류 {r['tools']['failures_by_kind'] or '없음'}",
        "- 에이전트와 effort(세션/호출/분/확인 호출/실패): "
        + (", ".join(f"{w} {a['sessions']}/{a['calls']}/{a['minutes']}/{a['verify_calls']}/{a['failures']}" for w, a in r["agents"]["by_agent_effort"].items()) or "없음"),
        (f"- eval: {e['total']}건 {e['by_command']}, 여러 문장 {e['statements_share']:.0%}, 실패 {e['failures']}({e['fail_share']:.0%}), "
         f"리플렉션 NonPublic {e['reflection_nonpublic']}, Find류 {e['find_objects']}") if e else "- eval: 기록 없음",
        f"- git: 커밋 {g['commits']} {g['by_type']}, fix {g['fix']} 중 테스트 파일을 함께 바꿈 {g['fix_with_tests']}(새 테스트 파일 {g['fix_adding_tests']})",
        f"- 하네스 운용: (사용자 확인) 더함 {g['user_check_added']} 지움 {g['user_check_removed']}, 닫은 구조 결정 {g['decisions_closed']}",
    ]
    x = r.get("codex")
    if x:
        xv, xc, xt = x["verify"], x["commits_in_transcript"], x["tools"]
        lines.append(f"- Codex(위 줄들과 따로 셈. 도구 시간은 agent마다라 Claude와 겹친다): 도구 시간 {xt['active_hours']}시간, 호출 {xt['calls']} "
                     f"{xt['calls_by_category']}, 확인 {xv['minutes']}분({xv['share']:.0%}), 수정 없이 같은 확인 반복 {xv['repeated_reads']}, "
                     f"코드를 고친 뒤 커밋 {xc['after_code_edit']}(컴파일/콘솔/테스트 없이 {xc['no_compile_check']}), 실패 {xt['failures_by_tool'] or '없음'}")
    lines += ["", "## 후보 (판정은 사람이 한다. 결과 파일 judged에 수를 적는다)"]
    names = {"leaked_bugs": "끝났다고 한 뒤 사용자가 문제를 말함", "claims_without_check": "확인했다고 했는데 그 턴에 확인 호출 없음",
             "undecided_mentions": "\"미정\"을 말함", "criteria_edit_after_fail": "확인 실패 뒤 테스트 파일을 고침"}
    for label, cand in (("", r["candidates"]), ("Codex: ", (x or {}).get("candidates"))):
        for k, title in names.items() if cand else ():
            items = cand[k]
            if label and not items:
                continue
            lines.append(f"### {label}{title}: {len(items)}")
            lines += [f"- {i}" for i in items[:LIMIT]] + ([f"- ... 외 {len(items) - LIMIT}"] if len(items) > LIMIT else [])
    return "\n".join(lines)


def compare(r, base):
    cell = lambda v: "-" if v is None else str(v)
    lines = ["", "## 기준선과 비교", f"기준선: {base.get('project')} ({base['window']['since']} ~ {base['window']['until']})",
             "같은 국면끼리 비교한다(구현 초반과 마감은 확인 방식이 다르다). judged가 비어 있으면 판정 전이다.", "",
             "| 지표 | 기준선 | 이번 | 좋은 쪽 |", "|---|---|---|---|"]
    for title, key, better in COMPARE:
        lines.append(f"| {title} | {cell(dig(base, key))} | {cell(dig(r, key))} | {better} |")
    return "\n".join(lines)


def keep_judged(out):
    """--out 파일에 사람이 적은 판정이 있으면 다시 돌려도 남긴다."""
    try:
        with open(out, encoding="utf-8") as f:
            return json.load(f).get("judged")
    except (OSError, ValueError):
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("project")
    ap.add_argument("--since")
    ap.add_argument("--until")
    ap.add_argument("--transcripts", action="append")
    ap.add_argument("--codex", action="append")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--out")
    ap.add_argument("--compare")
    a = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    top = git(a.project, "rev-parse", "--show-toplevel").strip()
    if not top:
        sys.exit(f"{a.project}는 git 저장소가 아니다")
    root = os.path.normpath(top)
    since, until = local_arg(a.since), local_arg(a.until)
    dirs = a.transcripts or transcript_dirs(root)
    sessions, writes, files, unparsed = load(dirs, since, until)
    codex_dirs = a.codex or ([] if a.transcripts else codex_session_dirs())
    codex, codex_files, codex_bad, codex_recovered = load_codex(codex_dirs, since, until, worktrees(root), root)
    check_cmd = agents_value(root, "확인 명령")
    # 위 지표는 Claude 세션만 센다(기준선과 같은 뜻). Codex는 따로 센다: 병렬 worker라 도구 시간이 Claude와 겹치고,
    # 섞으면 비율(확인 비중 등)이 기준선과 다른 뜻이 된다. agent:model:effort 열만 둘을 합친다.
    tools, verify, commits, context, devwiki, cand, agents = transcript_metrics(sessions, root, check_cmd, writes)
    codex_part = None
    if codex:
        ct, cv, cc, cx, cd, ccand, cagents = transcript_metrics(codex, root, check_cmd, writes)
        codex_part = {"note": "Codex 세션만. 도구 시간은 agent마다 세서 Claude와 겹친다(병렬)",
                      "tools": ct, "verify": cv, "commits_in_transcript": cc, "context": cx, "dev_wiki": cd, "candidates": ccand}
        agents = {"by_agent_effort": {**agents["by_agent_effort"], **cagents["by_agent_effort"]},
                  "sessions": agents["sessions"] + cagents["sessions"]}
    r = {
        "project": os.path.basename(root),
        # since, until은 받은 그대로(로컬 시각), *_utc는 다른 시간대 PC에서 다시 셀 때 쓴다
        "window": {"since": a.since, "until": a.until,
                   "since_utc": since.astimezone(dt.timezone.utc).isoformat() if since else None,
                   "until_utc": until.astimezone(dt.timezone.utc).isoformat() if until else None},
        "sources": {"transcript_dirs": len(dirs), "files": files, "sessions": len(sessions) + len(codex), "unparsed": unparsed + codex_bad,
                    "codex_files": codex_files, "codex_sessions": len(codex), "codex_recovered": codex_recovered},
        "tools": tools, "verify": verify, "commits_in_transcript": commits, "context": context, "dev_wiki": devwiki,
        "codex": codex_part, "agents": agents,
        "eval_usage": eval_usage(root, since, until), "git": git_metrics(root, since, until), "candidates": cand,
    }
    r["per_hour"] = per_hour(r)
    r["judged"] = (keep_judged(a.out) if a.out else None) or {
        "leaked_bugs": None, "claims_without_check": None,
        "note": "사람이 후보를 보고 맞는 것의 수를 적는다. 다시 돌려도 --out 파일의 이 값은 남는다"}
    if a.out:
        os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
        with open(a.out, "w", encoding="utf-8") as f:
            json.dump(r, f, ensure_ascii=False, indent=1)
    if a.json:
        print(json.dumps(r, ensure_ascii=False, indent=1))
        return
    print(report(r))
    if a.compare:
        print(compare(r, json.load(open(a.compare, encoding="utf-8"))))


if __name__ == "__main__":
    main()
