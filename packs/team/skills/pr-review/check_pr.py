"""PR에서 기계로 볼 수 있는 것을 찾는다(harness-team pr-review. 원본: dev-wiki _harness/packs/team/skills/pr-review/).

사용: python check_pr.py <base> <head>   예: python check_pr.py origin/main origin/combat/dash
표준 라이브러리만 쓴다. 결과는 판단 재료이고 판단은 리뷰어가 한다. 바뀐 씬과 prefab의 오브젝트는 공식 `unity vcs summarize --objects`가 본다.
- .meta 짝: Assets/ 아래에서 더하거나 지운 파일과 .meta가 같이 움직였나
- 인스턴스 값 중복: 같은 prefab 인스턴스 값(target, propertyPath)이 한 문서에 둘 이상. 양쪽이 같은 값을 고친 merge가 남긴다
- GUID 중복: head의 .meta 둘이 같은 guid(두 브랜치가 같은 폴더에 새 파일을 만들었을 때)
- merge 드라이버 줄: head의 .gitattributes에 `merge=unityyamlmerge`(누가 `unity vcs merge-setup`을 돌려 커밋했다. 이 드라이버는 같은 인스턴스 값 충돌을 git 충돌 없이 커밋한다)
- PR 없이 main에 들어온 커밋: <base>의 첫 부모 줄에서 `Merge pull request #N`이 아닌 커밋. 처음 PR merge 앞(처음 세팅)과
  지난번 본 자리(refs/harness/main-seen, pr-review가 차례를 마칠 때 옮긴다) 앞은 뺀다. 본 자리가 <base>에 없으면 강제 push다
- 바뀐 asmdef 참조: 판단 재료로만(방향은 docs/architecture.md와 비교한다)
문제가 있으면 종료 코드 1.
"""
import json
import re
import subprocess
import sys

OVERRIDE = re.compile(r"- target: \{fileID: (-?\d+), guid: (\w+)[^\n]*\n\s+propertyPath: ([^\n]+)\n\s+value: ([^\n]*)")
SEEN = "refs/harness/main-seen"
PR_MERGE = re.compile(r"^Merge pull request #\d+ ")


def git(*args):
    return subprocess.run(["git", "-c", "core.quotepath=off", *args], capture_output=True, encoding="utf-8",
                          errors="replace", check=True).stdout


def check_meta(changes):
    problems, by_path = [], {}
    for status, path in changes:
        if path.startswith("Assets/"):
            by_path[path] = status[0]
    for path, status in by_path.items():
        # Unity는 점으로 시작하는 파일을 가져오지 않아 .gitkeep에는 .meta가 없다.
        if status not in "AD" or path.endswith("/.gitkeep"):
            continue
        if path.endswith(".meta"):
            asset = path[:-5]
            # 폴더 .meta는 폴더 안 파일이 같이 바뀌면 정상이다.
            if asset not in by_path and not any(p.startswith(asset + "/") for p in by_path):
                problems.append(f".meta만 {status}: {path}")
        elif by_path.get(path + ".meta") != status:
            problems.append(f"{'더했는데' if status == 'A' else '지웠는데'} .meta가 같이 {status}되지 않음: {path}")
    return problems


def check_duplicate_overrides(head, changes):
    problems = []
    for status, path in changes:
        if not path.endswith((".unity", ".prefab")) or status.startswith("D"):
            continue
        for doc in re.split(r"(?m)^--- ", git("show", f"{head}:{path}")):
            values = {}
            for target, guid, prop, value in OVERRIDE.findall(doc):
                values.setdefault((target, guid, prop.strip()), []).append(value.strip())
            for (target, _, prop), found in values.items():
                if len(found) > 1:
                    problems.append(f"{path}: fileID {target} {prop} 값이 {len(found)}개 ({', '.join(found)})")
    return problems


def check_duplicate_guids(head):
    # 맞는 줄이 없으면 git grep이 1로 끝나므로 check를 쓰지 않는다.
    out = subprocess.run(["git", "-c", "core.quotepath=off", "grep", "-E", "^guid: ", head, "--", "*.meta"],
                         capture_output=True, encoding="utf-8", errors="replace").stdout
    paths = {}
    for line in out.splitlines():
        m = re.match(rf"{re.escape(head)}:(.+):guid: (\w+)", line)
        if m:
            paths.setdefault(m.group(2), []).append(m.group(1))
    return [f"GUID {guid}: {', '.join(found)}" for guid, found in paths.items() if len(found) > 1]


def check_merge_driver(head):
    shown = subprocess.run(["git", "show", f"{head}:.gitattributes"], capture_output=True, encoding="utf-8", errors="replace")
    if shown.returncode != 0:
        return []
    return [f".gitattributes {i}: {line.strip()}" for i, line in enumerate(shown.stdout.splitlines(), 1)
            if re.search(r"\bmerge=unityyamlmerge\b", line) and not line.lstrip().startswith("#")]


def check_main(base):
    seen = subprocess.run(["git", "rev-parse", "--verify", "-q", f"{SEEN}^{{commit}}"], capture_output=True, encoding="utf-8").stdout.strip()
    if seen and subprocess.run(["git", "merge-base", "--is-ancestor", seen, base], capture_output=True).returncode != 0:
        return [f"main 기록이 바뀌었다: 지난번 본 자리 {seen[:7]}가 {base}에 없다(강제 push). 잃은 커밋은 이 클론의 {SEEN}과 팀원 클론에 남아 있다"]
    problems, started = [], bool(seen)
    for line in git("log", "--first-parent", "--reverse", "--format=%h%x09%an%x09%s", f"{seen}..{base}" if seen else base).splitlines():
        short, author, subject = line.split("\t", 2)
        if PR_MERGE.match(subject):
            started = True
        elif started:
            problems.append(f"{short} {author}: {subject}")
    return problems


def asmdef_refs(rev, path):
    return set(json.loads(git("show", f"{rev}:{path}").lstrip("﻿")).get("references", []))


def asmdef_ref_changes(base, head, changes):
    merge_base = git("merge-base", base, head).strip()
    lines = []
    for status, path in changes:
        if not path.endswith(".asmdef"):
            continue
        old = set() if status.startswith("A") else asmdef_refs(merge_base, path)
        new = set() if status.startswith("D") else asmdef_refs(head, path)
        marks = [f"+{r}" for r in sorted(new - old)] + [f"-{r}" for r in sorted(old - new)]
        if marks:
            lines.append(f"{path}: {', '.join(marks)}")
    return lines


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    sys.stdout.reconfigure(encoding="utf-8")
    base, head = sys.argv[1], sys.argv[2]
    changes = [tuple(line.split("\t", 1)) for line in git("diff", "--name-status", "--no-renames", f"{base}...{head}").splitlines()]
    sections = [
        (".meta 짝", check_meta(changes)),
        ("인스턴스 값 중복", check_duplicate_overrides(head, changes)),
        ("GUID 중복", check_duplicate_guids(head)),
        ("merge 드라이버 줄", check_merge_driver(head)),
        ("PR 없이 main에 들어온 커밋", check_main(base)),
    ]
    found = False
    for title, problems in sections:
        print(f"## {title}: {'문제 없음' if not problems else f'{len(problems)}건'}")
        for p in problems:
            print(f"- {p}")
        found = found or bool(problems)
    refs = asmdef_ref_changes(base, head, changes)
    print(f"## 바뀐 asmdef 참조: {len(refs)}개 (docs/architecture.md 의존 방향과 맞는지 본다)")
    for p in refs:
        print(f"- {p}")
    return 1 if found else 0


if __name__ == "__main__":
    sys.dont_write_bytecode = True
    sys.exit(main())
