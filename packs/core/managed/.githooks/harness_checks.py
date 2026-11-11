"""harness 커밋 전 검사 찾기. harness-apply가 만들고 다시 적용할 때마다 덮어쓴다.
원본: dev-wiki _harness/packs/core/managed/.githooks/harness_checks.py

이 프로젝트에 켠 harness 묶음 플러그인(.claude/settings.json, settings.local.json의 enabledPlugins 중 *@harness)마다
설치 위치를 ~/.claude/plugins/installed_plugins.json에서 찾아 그 안의 git/checks/*.py를 --staged로 돌린다.
검사를 프로젝트에 복사하지 않으므로 묶음을 release하면 검사도 같이 바뀐다.
이 PC에 플러그인이 없으면 알리고 넘어간다(커밋을 막지 않는다).
저장소 사본: .githooks/harness-<묶음>/git/checks/*.py가 있으면(team 묶음이 팀 저장소에 넣는다) 플러그인 없이 누구에게나 그것을 돌리고,
같은 묶음의 플러그인 검사는 건너뛴다(내 PC에서 같은 검사가 두 번 돌지 않게, 팀원과 같은 판에서 보게).
`python .githooks/harness_checks.py --all`은 커밋과 상관없이 저장소 전체를 본다(적용 직후 점검용).
"""
import glob
import json
import os
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")
MARKET = "@harness"


def read_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def enabled_plugins(root):
    on = {}
    for name in ("settings.json", "settings.local.json"):
        on.update(read_json(os.path.join(root, ".claude", name)).get("enabledPlugins") or {})
    ids = [k for k, v in on.items() if v and k.endswith(MARKET)]
    # harness-core를 먼저 돌린다(문서 검사 같은 공통 검사).
    return sorted(ids, key=lambda k: (k != "harness-core" + MARKET, k))


def install_path(plugin_id, root):
    homes = [os.environ.get("CLAUDE_CONFIG_DIR"), os.path.join(os.path.expanduser("~"), ".claude")]
    for home in [h for h in homes if h]:
        entries = read_json(os.path.join(home, "plugins", "installed_plugins.json")).get("plugins", {}).get(plugin_id) or []
        same = [e for e in entries if os.path.normcase(os.path.abspath(e.get("projectPath") or "")) == os.path.normcase(root)]
        for e in same + entries:
            if os.path.isdir(e.get("installPath") or ""):
                return e["installPath"]
    return None


def main():
    # git은 경로를 UTF-8로 낸다. 기본 인코딩(cp949)으로 읽으면 한글 경로에서 stdout이 None이 되어 모든 커밋이 막힌다.
    top = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, encoding="utf-8", errors="replace").stdout
    root = os.path.abspath((top or "").strip() or ".")
    status = 0
    mode = [] if "--all" in sys.argv else ["--staged"]
    here = os.path.dirname(os.path.abspath(__file__))
    copies = sorted(d for d in glob.glob(os.path.join(here, "harness-*")) if os.path.isdir(os.path.join(d, "git", "checks")))
    copied = {os.path.basename(d) + MARKET for d in copies}
    # 앞의 검사가 실패해도 뒤의 것을 돌려 문제를 한 번에 보인다.
    for d in copies:
        for check in sorted(glob.glob(os.path.join(d, "git", "checks", "*.py"))):
            if subprocess.run([sys.executable, check, *mode, root], cwd=root).returncode != 0:
                status = 1
    for plugin_id in enabled_plugins(root):
        if plugin_id in copied:
            continue
        path = install_path(plugin_id, root)
        if not path:
            print(f"[harness] {plugin_id}가 이 PC에 깔려 있지 않아 그 검사를 건너뛴다", file=sys.stderr)
            continue
        for check in sorted(glob.glob(os.path.join(path, "git", "checks", "*.py"))):
            if subprocess.run([sys.executable, check, *mode, root], cwd=root).returncode != 0:
                status = 1
    return status


if __name__ == "__main__":
    sys.exit(main())
