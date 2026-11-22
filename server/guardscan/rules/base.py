"""Rule plumbing. A rule reads one file and returns matches. A match says which lines are the red flags and which are look-alikes."""

from __future__ import annotations

import posixpath
import re
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field

Range = tuple[int, int, str]  # (first line, last line, note); lines are 1-based and inclusive

PROSE_EXT = {".md", ".markdown", ".txt", ".rst", ".html", ".htm", ".adoc"}
CODE_EXT = {".py", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".go", ".rs", ".java", ".kt", ".rb", ".php", ".cs", ".c", ".cc", ".cpp", ".h", ".sh", ".bash"}
MAX_LINE = 1000  # longer lines are minified output, not something a person reviews


@dataclass
class Match:
    rule: str
    category: str
    severity: str
    title: str
    path: str
    start: int
    end: int
    flags: list[Range]
    decoys: list[Range] = field(default_factory=list)
    fix: str = ""
    evidence: str = ""
    benign: bool = False
    # for an absence (no SECURITY.md): the lines to show, instead of lines of a file
    context_lines: list[str] | None = None


@dataclass(frozen=True)
class FileCtx:
    path: str
    text: str
    lines: list[str]

    @property
    def name(self) -> str:
        return posixpath.basename(self.path)

    @property
    def ext(self) -> str:
        return posixpath.splitext(self.path)[1].lower()


ScanFn = Callable[[FileCtx], Iterable[Match]]


@dataclass(frozen=True)
class RuleDef:
    id: str
    category: str
    severity: str
    applies: Callable[[str], bool]
    scan: ScanFn


RULES: list[RuleDef] = []


def rule(rule_id: str, category: str, severity: str, applies: Callable[[str], bool]) -> Callable[[ScanFn], ScanFn]:
    def deco(fn: ScanFn) -> ScanFn:
        RULES.append(RuleDef(rule_id, category, severity, applies, fn))
        return fn

    return deco


# ------------------------------------------------------------------ path helpers

def is_workflow(path: str) -> bool:
    return bool(re.match(r"^\.github/workflows/[^/]+\.ya?ml$", path))


def is_dockerfile(path: str) -> bool:
    base = posixpath.basename(path).lower()
    return base == "dockerfile" or base.startswith("dockerfile.") or base.endswith(".dockerfile")


def is_prose(path: str) -> bool:
    return posixpath.splitext(path)[1].lower() in PROSE_EXT


def is_code(path: str) -> bool:
    return posixpath.splitext(path)[1].lower() in CODE_EXT


def is_test_path(path: str) -> bool:
    p = path.lower()
    if re.search(r"(^|/)(tests?|__tests__|spec|fixtures?|examples?|samples?|testdata|mocks?)(/|$)", p):
        return True
    # test files that live next to the code
    return bool(re.search(r"(^|/)(test_[^/]*\.py|[^/]*_test\.(py|go|rs|js|ts)|[^/]*\.(test|spec)\.(js|jsx|ts|tsx|mjs)|conftest\.py)$", p))


AGENT_FILES = re.compile(
    r"(?i)(^|/)(agents\.md|claude\.md|gemini\.md|\.cursorrules|\.windsurfrules|copilot-instructions\.md|skill\.md)$|(^|/)\.cursor/rules/|(^|/)\.claude/|(^|/)\.gemini/"
)


def is_agent_file(path: str) -> bool:
    return bool(AGENT_FILES.search(path))


def any_file(_: str) -> bool:
    return True


# ------------------------------------------------------------------ line helpers

def short(line: str, n: int = 160) -> str:
    s = line.strip()
    return s if len(s) <= n else s[: n - 1] + "…"


def find_lines(lines: list[str], pattern: re.Pattern[str]) -> list[int]:
    """1-based numbers of the lines that match a pattern (skipping minified lines)."""
    return [i for i, line in enumerate(lines, start=1) if len(line) <= MAX_LINE and pattern.search(line)]


def decoy_ranges(lines: list[str], pattern: re.Pattern[str], note: str, avoid: set[int], limit: int = 1) -> list[Range]:
    out: list[Range] = []
    for n in find_lines(lines, pattern):
        if n in avoid:
            continue
        out.append((n, n, note))
        if len(out) >= limit:
            break
    return out
