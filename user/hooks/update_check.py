"""harness-update 갱신 확인 (harness-user). 확인만 하고 아무것도 갱신하지 않는다.

  python update_check.py --now [--json]   지금 확인하고 결과를 저장, 출력 (harness-update 스킬)
  python update_check.py --background     확인하고 결과만 저장 (SessionStart가 하루 한 번 뒤에서 띄움)
  python update_check.py --diff <스킬>     npx skills 스킬의 설치본과 새 원본 차이 (SKILL.md)
  python update_check.py --dismiss <키>... 고르지 않은 갱신의 그 버전 알림을 끈다(키는 --now 출력의 [키])

보는 것(주인 표, harness-design 4-1절):
- harness 묶음: dev-wiki 원본 plugin.json 버전과 설치 버전 (다른 PC에서 git pull 한 뒤)
- Claude 플러그인: GitHub/git 마켓플레이스를 따로 얕게 받아(plugins/marketplaces 클론은 건드리지 않는다) 설치한 플러그인의 plugin.json 버전과 비교
- npx skills: ~/.agents/.skill-lock.json의 GitHub 출처 스킬 폴더 git 트리 해시(skills CLI가 lock에 쓰는 값과 같다). Orca 스킬은 빼고 Orca로 본다
  (갱신은 `-a codex`로 공유 폴더 ~/.agents/skills만 쓴다. `-a claude-code`와 `update`는 ~/.claude/skills에 복사본을 만들고 grilling 원본이 harness-user:grilling과 겹친다)
- Orca 스킬: orca skills update --all --dry-run --json (Orca 빌드에 든 버전)
- Unity CLI: unity self-update --check --json
결과: ~/.claude/harness-update.json. 네트워크가 안 되면 errors에 남기고 알림은 내지 않는다.
시험용: HARNESS_UPDATE_CMD_ORCA, HARNESS_UPDATE_CMD_UNITY에 명령을 JSON 배열로 주면 그것을 부른다("[]"이면 건너뜀).
"""
import datetime as dt
import difflib
import json
import os
import re
import shutil
import subprocess
import sys

HOME = os.path.expanduser("~")
CLAUDE = os.path.join(HOME, ".claude")
CACHE = os.path.join(CLAUDE, "harness-update.json")
LOCK = os.path.join(CLAUDE, "harness-update.lock")
REPOS = os.path.join(CLAUDE, "harness-update", "repos")
SKILL_LOCK = os.path.join(HOME, ".agents", ".skill-lock.json")
ORCA_SOURCES = {"stablyai/orca"}  # Orca 앱 설치기가 주인이다. npx skills로 갱신하지 않는다
TIMEOUT = 90
LOCK_AGE = 15 * 60  # 이보다 오래된 잠금은 죽은 확인이 남긴 것으로 본다
# 갱신 명령에 그대로 넣는 값. lock은 다른 도구가 쓰는 파일이라 모양을 확인한다
SAFE_SOURCE = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")
SAFE_NAME = re.compile(r"[A-Za-z0-9_.-]+")


def read_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default if default is not None else {}


def write_json(path, data):
    """원자적으로 쓴다(쓰다가 끊겨도 옛 파일이 남는다)."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def run(args, cwd=None, timeout=TIMEOUT):
    # 뒤에서 돌 때(DETACHED_PROCESS)는 콘솔이 없어, 콘솔 프로그램(git, claude, orca)을 부를 때마다 Windows가 새 창을 띄운다
    kw = {"creationflags": 0x08000000} if os.name == "nt" else {}  # CREATE_NO_WINDOW
    r = subprocess.run(args, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout, **kw)
    return r.returncode, r.stdout, r.stderr


def git(*args, cwd=None):
    code, out, err = run(["git", "-c", "core.quotepath=off", *args], cwd=cwd)
    if code != 0:
        raise RuntimeError((err or out).strip().splitlines()[-1] if (err or out).strip() else f"git {args[0]} 실패")
    return out


def fetch(name, url, ref="HEAD", filt="tree:0"):
    """url을 캐시 bare 저장소로 얕게 받고 FETCH_HEAD가 가리키는 커밋을 돌려준다."""
    repo = os.path.join(REPOS, re.sub(r"[^A-Za-z0-9._-]", "_", name) + ".git")
    if not os.path.isdir(repo):
        os.makedirs(repo, exist_ok=True)
        git("init", "-q", "--bare", repo)
    git("-C", repo, "fetch", "-q", "--depth", "1", f"--filter={filt}", url, ref or "HEAD")
    head = git("-C", repo, "rev-parse", "FETCH_HEAD").strip()
    run(["git", "-C", repo, "gc", "--auto", "--quiet"])  # 날마다 받은 옛 커밋이 쌓이지 않게
    return repo, head


def show(repo, commit, path):
    try:
        return git("-C", repo, "show", f"{commit}:{path}")
    except RuntimeError:
        return None


def repo_key(url):
    parts = url.rstrip("/").removesuffix(".git").replace("\\", "/").split("/")
    return "-".join(parts[-2:])


def join_path(*parts):
    p = "/".join(x.strip("/").removeprefix("./") for x in parts if x and x.strip("/") not in ("", "."))
    return p


def installed_plugins():
    return read_json(os.path.join(CLAUDE, "plugins", "installed_plugins.json")).get("plugins") or {}


def scopes_of(entries):
    return [{"scope": e.get("scope"), "project": e.get("projectPath"), "version": e.get("version")} for e in entries]


# ---------- 확인들 ----------

def check_harness(markets, installed):
    src = (markets.get("harness") or {}).get("source") or {}
    root = src.get("path")
    if not root or not os.path.isdir(root):
        return []
    items = []
    for p in read_json(os.path.join(root, ".claude-plugin", "marketplace.json")).get("plugins") or []:
        source = p.get("source") if isinstance(p.get("source"), str) else None
        latest = read_json(os.path.join(root, source or "", ".claude-plugin", "plugin.json")).get("version") if source else None
        pid = f"{p['name']}@harness"
        old = [e for e in installed.get(pid) or [] if latest and e.get("version") != latest]
        if old:
            items.append({"kind": "harness", "name": pid, "current": sorted({e.get("version") for e in old}), "latest": latest,
                          "where": scopes_of(old),
                          "update": ["claude plugin marketplace update harness", f"claude plugin update {pid} --scope <범위>"]})
    return items


def market_url(src):
    if src.get("source") == "github" and src.get("repo"):
        return f"https://github.com/{src['repo']}.git"
    if src.get("source") == "git" and src.get("url"):
        return src["url"]
    return None


def parse(text):
    """JSON 객체 하나. 없으면 {}, 깨졌거나 객체가 아니면 None."""
    try:
        data = json.loads(text or "{}")
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def check_markets(markets, installed, errors):
    items = []
    for name, m in markets.items():
        url = market_url(m.get("source") or {})
        mine = {pid: e for pid, e in installed.items() if pid.endswith("@" + name)}
        if not url or not mine:
            continue
        try:
            repo, head = fetch("market-" + name, url, (m.get("source") or {}).get("ref") or "HEAD")
        except (RuntimeError, subprocess.TimeoutExpired) as e:
            errors.append(f"마켓플레이스 {name}: {e}")
            continue
        # 한 마켓플레이스의 깨진 파일이 다른 마켓플레이스 확인을 멈추지 않게 그 항목만 errors에 남긴다
        catalog = parse(show(repo, head, ".claude-plugin/marketplace.json"))
        if catalog is None:
            errors.append(f"마켓플레이스 {name}: marketplace.json을 읽지 못했다")
            continue
        entries = {p.get("name"): p for p in catalog.get("plugins") or [] if isinstance(p, dict)}
        for pid, inst in mine.items():
            p = entries.get(pid.rsplit("@", 1)[0])
            if not p:
                continue
            latest = p.get("version")
            if not latest and isinstance(p.get("source"), str):
                manifest = parse(show(repo, head, join_path(p["source"], ".claude-plugin/plugin.json")))
                if manifest is None:
                    errors.append(f"플러그인 {pid}: plugin.json을 읽지 못했다")
                    continue
                latest = manifest.get("version")
            if not latest:
                continue  # 버전이 없는 플러그인(커밋으로만 구분)은 harness-update가 손으로 본다
            old = [e for e in inst if e.get("version") != latest]
            if old:
                items.append({"kind": "plugin", "name": pid, "current": sorted({e.get("version") for e in old}), "latest": latest,
                              "where": scopes_of(old), "source": url,
                              "update": [f"claude plugin marketplace update {name}", f"claude plugin update {pid} --scope <범위>"]})
    return items


def check_skills(errors):
    lock = read_json(SKILL_LOCK)
    groups = {}
    for name, e in (lock.get("skills") or {}).items():
        if e.get("source") in ORCA_SOURCES or not re.fullmatch(r"[0-9a-f]{40}", e.get("skillFolderHash") or "") or not e.get("skillPath"):
            continue
        url = e.get("sourceUrl")
        if url:
            groups.setdefault((url, e.get("ref") or "HEAD"), []).append((name, e))
    items = []
    for (url, ref), skills in groups.items():
        try:
            repo, head = fetch("skills-" + repo_key(url), url, ref, "blob:none")
        except (RuntimeError, subprocess.TimeoutExpired) as e:
            errors.append(f"npx skills {url}: {e}")
            continue
        for name, e in skills:
            folder = os.path.dirname(e["skillPath"]).replace("\\", "/")
            try:
                now = git("-C", repo, "rev-parse", f"{head}:{folder}").strip()
            except RuntimeError:
                items.append({"kind": "skill", "name": name, "current": e["skillFolderHash"][:8], "latest": None,
                              "note": f"원본에서 {folder}가 없어졌다", "source": url, "update": []})
                continue
            if now != e["skillFolderHash"]:
                safe = SAFE_SOURCE.fullmatch(e.get("source") or "") and SAFE_NAME.fullmatch(name)
                items.append({"kind": "skill", "name": name, "current": e["skillFolderHash"][:8], "latest": now[:8], "source": url,
                              "path": folder,
                              "update": [f"DISABLE_TELEMETRY=1 npx -y skills add {e['source']} -g -a codex -s {name} -y"] if safe else [],
                              **({} if safe else {"note": "lock의 출처나 이름 모양이 낯설어 갱신 명령을 만들지 않았다. 손으로 본다"})})
    return items


def tool_cmd(env, exe):
    if os.environ.get(env) is not None:
        return json.loads(os.environ[env])
    p = shutil.which(exe)
    return [p] if p else []


def check_orca(errors):
    cmd = tool_cmd("HARNESS_UPDATE_CMD_ORCA", "orca")
    if not cmd:
        return []
    try:
        code, out, err = run(cmd + ["skills", "update", "--all", "--dry-run", "--json"], timeout=60)
        plan = json.loads(out).get("plan") or {}
    except (ValueError, OSError, subprocess.TimeoutExpired) as e:
        errors.append(f"Orca 스킬: {e}")
        return []
    items = []
    for s in plan.get("skills") or []:
        change = [o for o in s.get("ops") or [] if o.get("kind") != "keep"]
        if change:
            items.append({"kind": "orca", "name": s.get("name"), "current": None, "latest": (s.get("digest") or "")[:8],
                          "note": ", ".join(sorted({o.get("kind") for o in change})), "update": [f"orca skills update --skill {s.get('name')}"]})
    return items


def check_unity(errors):
    cmd = tool_cmd("HARNESS_UPDATE_CMD_UNITY", "unity")
    if not cmd:
        return []
    try:
        code, out, err = run(cmd + ["self-update", "--check", "--json"], timeout=60)
        data = json.loads(out).get("data") or {}
    except (ValueError, OSError, subprocess.TimeoutExpired) as e:
        errors.append(f"Unity CLI: {e}")
        return []
    cur, new = data.get("currentVersion"), data.get("latestVersion")
    if cur and new and cur != new:
        return [{"kind": "unity", "name": "unity CLI", "current": cur, "latest": new,
                 "update": ["unity self-update --changelog", "unity self-update -y"]}]
    return []


def check_all():
    markets = read_json(os.path.join(CLAUDE, "plugins", "known_marketplaces.json"))
    installed = installed_plugins()
    errors = []
    items = check_harness(markets, installed)
    for f in (lambda: check_markets(markets, installed, errors), lambda: check_skills(errors),
              lambda: check_orca(errors), lambda: check_unity(errors)):
        try:
            items += f()
        except Exception as e:  # 한 가지가 깨져도 나머지는 본다
            errors.append(f"{type(e).__name__}: {e}")
    dismissed = read_json(CACHE).get("dismissed") or {}  # 확인이 끝난 뒤 읽는다(그동안 --dismiss한 것도 담는다)
    for it in items:
        it["key"] = f"{it['kind']}:{it['name']}"
        it["dismissed"] = bool(it.get("latest")) and dismissed.get(it["key"]) == it.get("latest")
    result = {"checked_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "items": items, "errors": errors,
              "dismissed": {k: v for k, v in dismissed.items() if any(i["key"] == k for i in items)}}
    write_json(CACHE, result)
    return result


# ---------- 알림 (session_start.py가 부른다) ----------

def label(it):
    cur = it.get("current")
    cur = ", ".join(cur) if isinstance(cur, list) else cur
    return f"{it['name']} {cur or ''} -> {it.get('latest') or '?'}".replace("  ", " ")


def notice(cache=None):
    """저장된 결과에 갱신이 있으면 한 줄."""
    items = [i for i in (cache if cache is not None else read_json(CACHE)).get("items") or [] if not i.get("dismissed")]
    if not items:
        return None
    shown = ", ".join(label(i) for i in items[:3]) + (f" 외 {len(items) - 3}" if len(items) > 3 else "")
    return f"[harness] 갱신 {len(items)}개: {shown}. harness-update로 바뀐 점과 영향을 보고 고른다"


def due(hours=20):
    """하루 한 번: 마지막 확인이 hours 시간보다 오래됐고 다른 확인이 돌고 있지 않으면 True."""
    last = read_json(CACHE).get("checked_at")
    try:
        if last and dt.datetime.now(dt.timezone.utc) - dt.datetime.fromisoformat(last) < dt.timedelta(hours=hours):
            return False
    except ValueError:
        pass
    try:
        if dt.datetime.now().timestamp() - os.path.getmtime(LOCK) < LOCK_AGE:
            return False
    except OSError:
        pass
    return True


def take_lock():
    """잠금 파일을 새로 만들 수 있으면 True. 세션 둘이 같이 시작해도 확인은 하나만 띄운다."""
    os.makedirs(CLAUDE, exist_ok=True)
    try:
        if dt.datetime.now().timestamp() - os.path.getmtime(LOCK) >= LOCK_AGE:
            os.remove(LOCK)
    except OSError:
        pass
    try:
        fd = os.open(LOCK, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except OSError:
        return False
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(str(os.getpid()))
    return True


def spawn_background():
    if not take_lock():
        return False
    kw = {"stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL, "close_fds": True}
    if os.name == "nt":
        kw["creationflags"] = 0x00000008 | 0x00000200 | 0x08000000  # DETACHED_PROCESS | NEW_PROCESS_GROUP | NO_WINDOW
    else:
        kw["start_new_session"] = True
    subprocess.Popen([sys.executable, os.path.abspath(__file__), "--background"], **kw)
    return True


# ---------- 차이 ----------

def skill_diff(name):
    e = (read_json(SKILL_LOCK).get("skills") or {}).get(name)
    if not e or not e.get("sourceUrl") or not e.get("skillPath"):
        return f"{name}: lock에 GitHub 출처가 없다"
    repo, head = fetch("skills-" + repo_key(e["sourceUrl"]), e["sourceUrl"], e.get("ref") or "HEAD", "blob:none")
    new = (show(repo, head, e["skillPath"].replace("\\", "/")) or "").splitlines(keepends=True)
    try:
        with open(os.path.join(HOME, ".agents", "skills", name, "SKILL.md"), encoding="utf-8") as f:
            old = f.readlines()
    except OSError:
        old = []
    return "".join(difflib.unified_diff(old, new, f"설치본/{name}/SKILL.md", f"원본/{e['skillPath']}")) or f"{name}: SKILL.md는 같다(다른 파일이 바뀜)"


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    a = sys.argv[1:]
    if "--background" in a:
        try:
            check_all()
        finally:
            try:
                os.remove(LOCK)
            except OSError:
                pass
        return
    if "--dismiss" in a:
        # 고르지 않은 갱신: 그 버전 알림만 끈다. 다음 버전이 나오면 다시 알린다
        cache = read_json(CACHE)
        keys = a[a.index("--dismiss") + 1:]
        found = [i for i in cache.get("items") or [] if i.get("key") in keys and i.get("latest")]
        for i in found:
            cache.setdefault("dismissed", {})[i["key"]] = i["latest"]
            i["dismissed"] = True
        write_json(CACHE, cache)
        print(f"알림 끔: {', '.join(i['key'] + ' ' + i['latest'] for i in found) or '없음(키를 --now 출력에서 확인)'}")
        return
    if "--diff" in a:
        print(skill_diff(a[a.index("--diff") + 1]))
        return
    r = check_all()
    if "--json" in a:
        print(json.dumps(r, ensure_ascii=False, indent=1))
        return
    print(f"확인 {r['checked_at']}: 갱신 {len(r['items'])}개")
    for it in r["items"]:
        where = ", ".join(f"{w['scope']}{' ' + w['project'] if w.get('project') else ''}" for w in it.get("where") or [])
        print(f"- [{it['key']}] {label(it)}" + (f" ({where})" if where else "") + (f" {it['note']}" if it.get("note") else "")
              + (" (알림 끔)" if it.get("dismissed") else ""))
        for c in it.get("update") or []:
            print(f"    {c}")
    for e in r["errors"]:
        print(f"! {e}")


if __name__ == "__main__":
    main()
