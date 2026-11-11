"""harness-core 문서 점검 (커밋 전 검사). 원본: dev-wiki _harness/packs/core/git/checks/docs.py

문서를 수명으로 나눠 본다(규칙은 rules.md와 docs-<수준>.md).
- 현재 상태: 어느 폴더든 AGENTS.md, CLAUDE.md, GLOSSARY.md, 뿌리 README.md, .claude/rules/, 아래 둘이 아닌 docs/ 문서
  막음: 끊긴 링크, 없는 경로(백틱 안 `폴더/...`, 첫 폴더가 저장소에 있을 때만), `파일:줄`(`:줄-줄`, `#L줄`)의 줄이 파일 밖,
        GLOSSARY.md `_Avoid_`(와 옛 형식 docs/retired.txt)의 버린 표현, 제목의 날짜,
        크기(AGENTS.md 200줄, 그 밖 500줄이나 4만 자, 뿌리부터 그 폴더까지 AGENTS.md 합계 32 KiB),
        폴더 AGENTS.md 옆에 @AGENTS.md CLAUDE.md가 없음, CLAUDE.md에 @ 줄 밖의 내용, 현재 상태 문서 자리에 단 기록 표시
  알림: 본문의 날짜, 300줄 넘음, UTF-8이 아님
- 진행 중: docs/changes/<폴더>/(README.md와 archive/ 제외). 링크와 경로만 막는다. 300줄 넘음, tasks.md 할 일이 다 끝남은 알림
- 기록: docs/adr/(README.md 제외), docs/changes/archive/, docs/archive/, docs/decisions.md(옛 형식), 첫 줄이 <!-- doc: log -->
  내용은 검사하지 않는다. ADR은 파일 이름(NNNN-slug.md)과 번호 겹침만 막고, ADR 200줄, 다른 기록 1000줄은 알림
문서 수준이 light(AGENTS.md "값" 표)면 링크, 경로, 줄, 크기, 기록 표시만 막고 나머지는 알림으로 낮춘다.
코드 블록(``` 또는 ~~~, 인용 안 포함)과 줄 끝에 <!-- doc-check:ignore: 이유 -->를 단 줄은 건너뛴다. 닫히지 않은 울타리는 코드로 보지 않는다.
harness 블록(<!-- harness-<묶음>:start --> ~ end, apply가 묶음 규칙에서 만들어 다시 쓴다)도 줄 검사를 건너뛴다(크기는 센다).
블록의 경로는 이 저장소 파일이 아니라 규칙이 말하는 자리(docs/archive/ 등)다. 닫히지 않은 블록은 블록으로 보지 않는다.
이유 없는 표시는 받지 않는다(그 줄도 검사하고 알린다): 검사를 끄는 표시는 왜인지 남아야 리뷰에서 보인다.
버린 표현과 날짜는 인라인 코드와 링크 대상 밖에서만 찾는다. 정식 용어(`**용어**:`) 안에 든 버린 말은 걸지 않는다.
--staged는 인덱스(이번 커밋에 들어갈 내용)를 본다. 작업 트리에만 있는 링크 대상은 없는 것으로 본다.
지우거나 이름을 바꾼 파일이 있으면 모든 문서의 링크와 경로를 다시 본다. 코드를 바꾼 커밋에 그 폴더를 맡은
시스템 문서(`- 폴더:` 줄)가 없으면 알린다.

사용:
  python docs.py [저장소]            모든 문서
  python docs.py --staged [저장소]   이번 커밋에 들어간 문서
문제가 있으면 종료 코드 1.
"""
import os
import posixpath
import re
import subprocess
import sys
from urllib.parse import unquote

sys.stdout.reconfigure(encoding="utf-8")
sys.dont_write_bytecode = True  # 원본과 설치본 폴더에 __pycache__를 남기지 않는다
# <플러그인>/lib. 저장소 사본(.githooks/harness-core/, team 묶음)도 같은 모양으로 둔다
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "lib"))
from project import level_info  # noqa: E402

LINK = re.compile(r"\[[^\]]*\]\(\s*<?([^)#\s>]+\.md)>?(#[^)]*)?\s*\)")
LINK_TARGET = re.compile(r"\]\([^)]*\)")
TICK = re.compile(r"`([^`\s]+)`")
CODE_SPAN = re.compile(r"(`+)(.+?)\1")
LINE_REF = re.compile(r"^(.+\.\w+)(?::(\d+)(?:-(\d+))?(?::\d+)?|#L(\d+)(?:-L?(\d+))?)$")
DATE = re.compile(r"\b20\d\d-\d\d-\d\d\b")
HEADING = re.compile(r"^#{1,6}\s")
QUOTE = re.compile(r"^ {0,3}(?:>\s?)*")
FENCE = re.compile(r"^ {0,3}(?:>\s?)*(`{3,}|~{3,})")
BOLD = re.compile(r"^\s*[-*]?\s*\*\*(.+?)\*\*")
AVOID = re.compile(r"^\s*[-*]?\s*_Avoid_\s*:\s*(.+)$")
IMPORT = re.compile(r"^\s*@\S+\s*$")
CHECKBOX = re.compile(r"^\s*[-*]\s+\[([ xX])\]")
FOLDER_LINE = re.compile(r"^\s*-\s*폴더\s*:\s*(.*)$")
ADR_NAME = re.compile(r"^(\d{4})-[a-z0-9][a-z0-9-]*\.md$")
IGNORE = re.compile(r"<!--\s*doc-check:ignore\b([^>]*)-->")
BLOCK = re.compile(r"^\s*<!--\s*harness-([\w-]+):(start|end)\s*-->\s*$")
LOG_MARK = "<!-- doc: log -->"
LOG_DOCS = ("docs/decisions.md",)
LOG_DIRS = ("docs/archive/", "docs/changes/archive/")
GUIDES = ("docs/adr/README.md", "docs/changes/README.md")
SPECIAL = ("AGENTS.md", "CLAUDE.md", "GLOSSARY.md")
CURRENT_SPOTS = ("README.md", "docs/overview.md", "docs/architecture.md", "docs/tasks.md")
LIMIT_AGENTS = 200
LONG = 300
LIMIT = 500
LIMIT_CHARS = 40000      # Claude는 폴더 CLAUDE.md(와 그 @가져오기)와 경로 규칙 파일을 4만 자에서 자른다
CODEX_BYTES = 32 * 1024  # Codex는 뿌리부터 시작 폴더까지 AGENTS.md를 합쳐 32 KiB에서 자른다
LONG_CHANGE = 300
LONG_ADR = 200
LONG_LOG = 1000
HARD = {"링크", "경로", "줄", "크기", "기록 표시"}  # light에서도 막는 것
STANDARD = HARD | {"버린 표현", "제목 날짜", "ADR", "폴더 규칙", "CLAUDE.md"}
QUIET = ("본문 날짜", "긴 문서")  # 태그 없이 알리는 것


def git_bytes(root, *args):
    r = subprocess.run(["git", "-c", "core.quotepath=off", *args], cwd=root, capture_output=True)
    return r.stdout or b""


def git(root, *args):
    return git_bytes(root, *args).decode("utf-8", "replace")


def base(rel):
    return rel.rsplit("/", 1)[-1]


def parent(rel):
    return rel.rsplit("/", 1)[0] if "/" in rel else ""


def is_doc(rel):
    return rel.endswith(".md") and (base(rel) in SPECIAL or rel == "README.md" or rel.startswith(("docs/", ".claude/rules/")))


def is_current_spot(rel):
    return base(rel) in SPECIAL or rel in CURRENT_SPOTS or rel.startswith(("docs/systems/", ".claude/rules/"))


class Tree:
    """검사할 내용. --staged면 인덱스, 아니면 작업 트리(추적 파일과 무시되지 않은 새 파일)."""

    def __init__(self, root, staged):
        self.root, self.staged = root, staged
        if staged:
            self.files = set(git(root, "ls-files", "--cached").splitlines())
            self.untracked = set(git(root, "ls-files", "--others", "--exclude-standard").splitlines())
        else:
            listed = git(root, "ls-files", "--cached", "--others", "--exclude-standard").splitlines()
            self.files = {f for f in listed if os.path.isfile(os.path.join(root, f))}
            self.untracked = set()
        self.files.discard("")
        self.dirs = {d for f in self.files for d in self._parents(f)}
        self.untracked_dirs = {d for f in self.untracked for d in self._parents(f)}
        self.top = {f.split("/")[0] for f in self.files}
        self._raw = {}
        self._lower = None

    @staticmethod
    def _parents(rel):
        parts = rel.split("/")[:-1]
        return ["/".join(parts[:i]) for i in range(1, len(parts) + 1)]

    def raw(self, rel):
        if rel not in self._raw:
            if self.staged and rel in self.files:
                data = git_bytes(self.root, "show", f":{rel}")
            else:
                try:
                    with open(os.path.join(self.root, rel), "rb") as f:
                        data = f.read()
                except OSError:
                    data = b""
            self._raw[rel] = data[3:] if data.startswith(b"\xef\xbb\xbf") else data
        return self._raw[rel]

    def text(self, rel):
        return self.raw(rel).decode("utf-8", "replace")

    def utf8(self, rel):
        try:
            self.raw(rel).decode("utf-8")
            return True
        except UnicodeDecodeError:
            return False

    def locate(self, rel):
        """ok, untracked(--staged에서 작업 트리에만 있음), case(대소문자만 다름), missing."""
        rel = rel.strip("/")
        if rel in self.files or rel in self.dirs or rel in ("", "."):
            return "ok"
        if self.staged and (rel in self.untracked or rel in self.untracked_dirs):
            return "untracked"
        # Windows와 macOS 디스크는 대소문자를 가리지 않아 아래 디스크 확인을 통과하지만, Linux 클론에서는 끊긴다
        if self.actual(rel):
            return "case"
        # 무시된 파일(빌드 결과 등)이나 저장소 밖은 작업 트리에서 찾는다
        return "ok" if os.path.exists(os.path.join(self.root, rel)) else "missing"

    def actual(self, rel):
        """대소문자만 다른 실제 이름(git에 적힌 이름). 없으면 None."""
        if self._lower is None:
            self._lower = {}
            for p in sorted(self.files | self.dirs | self.untracked | self.untracked_dirs):
                self._lower.setdefault(p.lower(), p)
        return self._lower.get(rel.strip("/").lower())


def code_lines(lines):
    """코드 블록에 든 줄 번호(0부터). 닫히지 않은 울타리는 코드로 보지 않는다."""
    out, i = set(), 0
    while i < len(lines):
        m = FENCE.match(lines[i])
        if not m:
            i += 1
            continue
        mark = m.group(1)
        close = re.compile(re.escape(mark[0]) + "{%d,}" % len(mark))
        end = next((j for j in range(i + 1, len(lines)) if close.fullmatch(QUOTE.sub("", lines[j]).strip())), None)
        if end is None:
            i += 1
            continue
        out.update(range(i, end + 1))
        i = end + 1
    return out


def block_lines(lines):
    """harness 블록에 든 줄 번호(0부터, 표식 줄 포함). 닫히지 않은 블록은 블록으로 보지 않는다."""
    out, start = set(), {}
    for i, line in enumerate(lines):
        m = BLOCK.match(line)
        if not m:
            continue
        if m.group(2) == "start":
            start[m.group(1)] = i
        elif m.group(1) in start:
            out.update(range(start.pop(m.group(1)), i + 1))
    return out


def prose(line):
    """인라인 코드와 링크 대상을 뺀 글."""
    return LINK_TARGET.sub("]", CODE_SPAN.sub(" ", line))


def kind(rel, text):
    first = next((l.strip() for l in text.splitlines() if l.strip()), "")
    if rel in LOG_DOCS or rel.startswith(LOG_DIRS):
        return "log"
    if first == LOG_MARK:
        return "marked" if is_current_spot(rel) else "log"
    if rel in GUIDES:
        return "current"
    if rel.startswith("docs/adr/"):
        return "adr" if "/" not in rel[len("docs/adr/"):] else "log"
    if rel.startswith("docs/changes/"):
        return "change"
    return "current"


def avoided_terms(tree):
    """GLOSSARY.md의 `_Avoid_: 말, 말` 줄과 옛 형식 docs/retired.txt(`버린 말 | 쓸 말`)."""
    terms, canon = [], set()
    for rel in sorted(tree.files):
        if base(rel) != "GLOSSARY.md":
            continue
        current = ""
        for line in tree.text(rel).splitlines():
            m = BOLD.match(line)
            if m:
                current = m.group(1).strip().rstrip(":").strip()
                if current:
                    canon.add(current)
            a = AVOID.match(line)
            if a:
                for t in re.split(r"[,，]", a.group(1)):
                    t = t.strip().strip("_*`").strip().rstrip(".。;:!?").strip()
                    if t:
                        terms.append((t, current))
    if "docs/retired.txt" in tree.files:
        for line in tree.text("docs/retired.txt").splitlines():
            if line.strip() and not line.startswith("#"):
                t, _, n = line.partition("|")
                if t.strip():
                    terms.append((t.strip(), n.strip()))
    out = []
    for t, n in terms:
        # 영문 말은 낱말 단위(bill이 billing에 걸리지 않게), 한글 말은 조사가 붙으므로 부분 일치
        if re.fullmatch(r"[A-Za-z0-9 _.'-]+", t):
            pattern = re.compile(r"(?<![A-Za-z0-9_])" + re.escape(t) + r"(?![A-Za-z0-9_])", re.I)
        else:
            pattern = re.compile(re.escape(t))
        # '대시'를 버렸어도 정식 용어 '대시 쿨다운'은 건다면 안 된다
        shield = [re.compile(re.escape(c), re.I) for c in sorted(canon, key=len, reverse=True) if c.lower() != t.lower() and pattern.search(c)]
        out.append((t, n, pattern, shield))
    return out


def check_refs(tree, rel, number, line, raw_line):
    found, where = [], f"{rel}:{number}"
    here = parent(rel)
    for target, _ in LINK.findall(line):
        if target.startswith("http"):
            continue
        t = unquote(target)
        path = posixpath.normpath(t.lstrip("/") if t.startswith("/") else posixpath.join(here, t))
        state = tree.locate(path)
        if state == "missing":
            found.append(("링크", f"{where}: {target} 없음"))
        elif state == "untracked":
            found.append(("링크", f"{where}: {target}는 작업 트리에만 있다. 같이 스테이지한다"))
        elif state == "case":
            found.append(("링크", f"{where}: {target}의 대소문자가 실제 이름 {tree.actual(path)}와 다르다. Linux 클론에서는 끊긴다"))
    for token in TICK.findall(raw_line):
        token = token.rstrip(".,)")
        # <이름>, *, ..., {값}은 자리표시다. 첫 폴더가 저장소에 없으면 경로가 아니라고 본다(origin/main 같은 것).
        if "/" not in token or any(m in token for m in ("<", "*", "...", "{")) or token.split("/")[0] not in tree.top:
            continue
        m = LINE_REF.match(token)
        path = posixpath.normpath(m.group(1) if m else token)
        state = tree.locate(path)
        if state == "missing":
            found.append(("경로", f"{where}: {path} 없음"))
        elif state == "untracked":
            found.append(("경로", f"{where}: {path}는 작업 트리에만 있다. 같이 스테이지한다"))
        elif state == "case":
            found.append(("경로", f"{where}: {path}의 대소문자가 실제 이름 {tree.actual(path)}와 다르다. Linux 클론에서는 끊긴다"))
        elif m and path in tree.files:
            last = max(int(g) for g in m.groups()[1:] if g)
            n = len(tree.text(path).splitlines())
            if last > n:
                found.append(("줄", f"{where}: {token} (파일은 {n}줄)"))
    return found


def check_doc(tree, rel, text, doc_kind, terms, refs_only=False):
    """(태그, 내용) 목록. 태그로 막을지 알릴지 나중에 정한다."""
    found = []
    lines = text.splitlines()
    code = code_lines(lines) | block_lines(lines)
    current = doc_kind in ("current", "marked")
    body_dates = 0
    for i, raw_line in enumerate(lines):
        if i in code:
            continue
        ignore = IGNORE.search(raw_line)
        if ignore and ignore.group(1).strip(" :-"):
            continue
        if ignore:
            found.append(("무시 표시", f"{rel}:{i + 1}: 이유가 없어 이 줄도 검사한다. <!-- doc-check:ignore: 이유 -->로 쓴다"))
        number, no_code = i + 1, CODE_SPAN.sub(" ", raw_line)
        if doc_kind in ("current", "marked", "change"):
            found += check_refs(tree, rel, number, no_code, raw_line)
        if not current or refs_only:
            continue
        where, words = f"{rel}:{number}", prose(raw_line)
        if base(rel) != "GLOSSARY.md":
            for term, note, pattern, shield in terms:
                masked = words
                for s in shield:
                    masked = s.sub(" ", masked)
                if pattern.search(masked):
                    found.append(("버린 표현", f"{where}: '{term}'" + (f" -> {note}" if note else "")))
        if DATE.search(words):
            if HEADING.match(raw_line):
                found.append(("제목 날짜", f"{where}: 바뀐 이력은 커밋과 docs/adr/가 맡는다. 제목에서 뺀다"))
            else:
                body_dates += 1
    if refs_only:
        return found
    if not tree.utf8(rel):
        found.append(("인코딩", f"{rel}: UTF-8이 아니다. UTF-8로 저장한다"))
    if doc_kind == "change":
        if len(lines) > LONG_CHANGE:
            found.append(("긴 문서", f"{rel}: {len(lines)}줄. 진행 중 문서는 1~2쪽으로 쓴다(proposal은 왜와 무엇만, 결정은 ADR로)"))
        if base(rel) == "tasks.md":
            boxes = [m.group(1) for m in map(CHECKBOX.match, lines) if m]
            if boxes and all(b != " " for b in boxes):
                found.append(("변경 끝남", f"{parent(rel)}: tasks.md 할 일이 다 끝났다. 현재 상태 문서가 다 고쳐졌는지 보고 docs/changes/archive/로 옮긴다"))
    if doc_kind in ("log", "adr"):
        limit = LONG_ADR if doc_kind == "adr" else LONG_LOG
        if len(lines) > limit:
            how = "ADR은 결정 하나를 1~2쪽으로 쓴다" if doc_kind == "adr" else "docs/archive/로 옮기고 새 파일로 이어 쓴다"
            found.append(("긴 문서", f"{rel}: {len(lines)}줄. {how}"))
    if not current:
        return found
    if doc_kind == "marked":
        found.append(("기록 표시", f"{rel}: 현재 상태 문서 자리라 <!-- doc: log -->를 달 수 없다. 지난 일은 docs/archive/나 다른 기록 문서로 옮긴다"))
    if body_dates:
        found.append(("본문 날짜", f"{rel}: 본문에 날짜 {body_dates}곳. 현재 상태 문서라면 이력은 커밋과 ADR로 옮긴다"))
    if base(rel) == "AGENTS.md":
        limit = LIMIT_AGENTS
        how = ("폴더에만 해당하는 규칙을 그 폴더의 AGENTS.md로 옮긴다" if "/" not in rel
               else "더 아래 폴더의 AGENTS.md나 시스템 문서로 나눈다")
    else:
        limit, how = LIMIT, "시스템 문서나 하위 문서로 나눈다"
    if len(lines) > limit:
        found.append(("크기", f"{rel}: {len(lines)}줄 (한도 {limit}). {how}"))
    elif limit == LIMIT and len(lines) > LONG:
        found.append(("긴 문서", f"{rel}: {len(lines)}줄. 나눌 때다({LIMIT}줄이 넘으면 막는다)"))
    if len(text) > LIMIT_CHARS:
        why = ("Claude는 넘는 부분을 읽지 않는다" if base(rel) in ("AGENTS.md", "CLAUDE.md")
               else "한 번에 읽기에 길다")
        found.append(("크기", f"{rel}: {len(text)}자 (한도 {LIMIT_CHARS}). {why}. {how}"))
    if base(rel) == "AGENTS.md":
        chain = [a for a in [posixpath.join(d, "AGENTS.md") if d else "AGENTS.md" for d in [""] + Tree._parents(rel)] if a in tree.files]
        total = sum(len(tree.raw(a)) for a in chain)
        if total > CODEX_BYTES:
            found.append(("크기", f"{rel}: 뿌리부터 이 폴더까지 AGENTS.md 합계 {total}바이트 (한도 {CODEX_BYTES}). Codex는 넘는 부분을 읽지 않는다"))
        if "/" in rel:
            # Claude는 폴더의 AGENTS.md를 직접 읽지 않는다. 같은 폴더의 CLAUDE.md(@AGENTS.md)가 있어야 그 폴더를 만질 때 읽힌다
            # (2026-11-09 헤드리스 세션으로 확인: 연결 파일이 있는 폴더만 읽혔다).
            shim = posixpath.join(parent(rel), "CLAUDE.md")
            state = tree.locate(shim)
            if state == "untracked":
                found.append(("폴더 규칙", f"{rel}: 옆의 CLAUDE.md가 작업 트리에만 있다. 같이 스테이지한다"))
            elif shim not in tree.files or "@AGENTS.md" not in tree.text(shim):
                found.append(("폴더 규칙", f"{rel}: 같은 폴더에 `@AGENTS.md` 한 줄짜리 CLAUDE.md가 없어 Claude가 읽지 않는다"))
    if base(rel) == "CLAUDE.md":
        # 코드 블록 안의 @는 가져오지 않으므로 코드 블록도 내용으로 센다
        extra = [l for l in lines if l.strip() and not IMPORT.match(l) and not HEADING.match(l) and not l.strip().startswith("<!--")]
        if extra:
            found.append(("CLAUDE.md", f"{rel}: @ 줄 밖에 {len(extra)}줄. 같은 폴더의 AGENTS.md로 옮긴다(Codex와 다른 도구는 CLAUDE.md를 읽지 않는다)"))
    return found


def check_adr(names):
    found, seen = [], {}
    for rel in sorted(names):
        m = ADR_NAME.match(base(rel))
        if not m:
            found.append(("ADR", f"{rel}: 이름은 NNNN-<영문 소문자와 ->.md"))
            continue
        if m.group(1) in seen:
            found.append(("ADR", f"{rel}: 번호 {m.group(1)}가 {seen[m.group(1)]}와 겹친다. 나중에 들어온 쪽을 다음 번호로 바꾼다"))
        seen.setdefault(m.group(1), rel)
    return found


def owners(tree):
    """docs/systems/ 문서의 `- 폴더:` 줄 -> [(폴더, 문서)]."""
    out = []
    for rel in sorted(tree.files):
        if not (rel.startswith("docs/systems/") and rel.endswith(".md")) or base(rel) == "_template.md":
            continue
        for line in tree.text(rel).splitlines()[:30]:
            m = FOLDER_LINE.match(line)
            if not m:
                continue
            # 백틱 경로만 읽는다(채우지 않은 틀의 안내 글을 폴더로 읽지 않게)
            for p in re.findall(r"`([^`]+)`", m.group(1)):
                p = p.strip().strip("/")
                if p and not any(c in p for c in "<*{") and not p.startswith(("http", "-")):
                    out.append((p, rel))
            break
    return out


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    staged = "--staged" in sys.argv
    root = os.path.abspath(args[0] if args else ".")
    tree = Tree(root, staged)
    level, unknown = level_info(tree.text("AGENTS.md") if "AGENTS.md" in tree.files else "")
    terms = avoided_terms(tree)

    changed, moved = set(), False
    if staged:
        for line in git(root, "diff", "--cached", "--name-status", "-M").splitlines():
            parts = line.split("\t")
            if len(parts) < 2:
                continue
            status = parts[0][:1]
            moved = moved or status in "DR"
            changed.update(parts[1:])
        targets = sorted(p for p in changed if is_doc(p) and p in tree.files)
        rest = sorted(p for p in tree.files if is_doc(p) and p not in changed) if moved else []
    else:
        targets, rest = sorted(p for p in tree.files if is_doc(p)), []

    found, counts = [], {"current": 0, "change": 0}
    for rel in targets:
        text = tree.text(rel)
        k = kind(rel, text)
        if k in ("current", "marked", "change"):
            counts["change" if k == "change" else "current"] += 1
        found += check_doc(tree, rel, text, k, terms)
    for rel in rest:
        # 지우거나 옮긴 파일을 가리키는 다른 문서. 링크와 경로만 다시 본다
        text = tree.text(rel)
        k = kind(rel, text)
        if k in ("current", "marked", "change"):
            found += check_doc(tree, rel, text, k, terms, refs_only=True)
    if not staged or any(p.startswith("docs/adr/") for p in changed):
        adr = [r for r in tree.files if r.startswith("docs/adr/") and r.endswith(".md") and r not in GUIDES
               and "/" not in r[len("docs/adr/"):]]
        found += check_adr(adr)
    if staged:
        code = [p for p in changed if not is_doc(p) and not p.startswith("docs/")]
        # 코드를 바꾸지 않은 커밋은 시스템 문서를 다 읽지 않는다(문서마다 git show라 문서 수에 비례해 느려진다)
        for folder, doc in owners(tree) if code else []:
            touched = [p for p in code if p == folder or p.startswith(folder + "/")]
            if touched and doc not in changed:
                found.append(("시스템 문서", f"{folder}/ 아래 {len(touched)}개 파일이 바뀌었는데 {doc}는 이 커밋에 없다. 동작이 바뀌었으면 같이 고친다"))

    block = HARD if level == "light" else STANDARD
    problems = [f"[{tag}] {msg}" for tag, msg in found if tag in block]
    notes = [msg if tag in QUIET else f"[{tag}] {msg}" for tag, msg in found if tag not in block]
    if unknown:
        notes.insert(0, f"AGENTS.md \"값\" 표의 문서 수준 '{unknown}'를 몰라 standard로 봤다. standard나 light로 고친다")
    for n in notes:
        print(f"[알림] {n}")
    if staged and not problems:
        return 0
    for p in problems:
        print(p)
    print(f"[harness-core] 문서 수준 {level}, 현재 상태 문서 {counts['current']}개, 진행 중 문서 {counts['change']}개, 문제 {len(problems)}개")
    if problems and staged:
        print("[harness-core] 고친 뒤 다시 커밋한다. 일부러 남긴 줄이면 줄 끝에 <!-- doc-check:ignore: 이유 -->를 달고 보고에 적는다.")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
