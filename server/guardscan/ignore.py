"""Accepted findings for the CLI and CI, every one with a written reason.

The pattern comes from Obscura's deny.toml, where an accepted advisory must carry a reason. A line is:

    RULE_GLOB  PATH_GLOB  -- the reason

A line without a reason is an error. An entry that matches nothing is reported as stale, so the list cannot rot.
This is for scanning your own checkout in CI. The web service never reads an ignore file from a repository it scans,
because a repository could use that to hide its own problems.
"""

from __future__ import annotations

from dataclasses import dataclass
from fnmatch import fnmatchcase
from typing import Any


class IgnoreError(ValueError):
    pass


@dataclass(frozen=True)
class Ignore:
    rule: str
    path: str
    reason: str
    line: int

    def matches(self, finding: dict[str, Any]) -> bool:
        return fnmatchcase(finding["rule"], self.rule) and fnmatchcase(finding["path"], self.path)


def parse(text: str) -> list[Ignore]:
    out: list[Ignore] = []
    for n, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        head, sep, reason = line.partition(" -- ")
        parts = head.split()
        if not sep or len(reason.strip()) < 8:
            raise IgnoreError(f"line {n}: every accepted finding needs a reason, written as '-- why'")
        if len(parts) != 2:
            raise IgnoreError(f"line {n}: expected 'RULE_GLOB PATH_GLOB -- reason'")
        out.append(Ignore(parts[0], parts[1], reason.strip(), n))
    return out


def apply(findings: list[dict[str, Any]], ignores: list[Ignore]) -> tuple[list[dict[str, Any]], list[tuple[dict[str, Any], Ignore]], list[Ignore]]:
    """Returns (kept, ignored with the entry that matched, entries that matched nothing)."""
    kept: list[dict[str, Any]] = []
    ignored: list[tuple[dict[str, Any], Ignore]] = []
    used: set[int] = set()
    for f in findings:
        hit = next((i for i in ignores if i.matches(f)), None)
        if hit:
            ignored.append((f, hit))
            used.add(hit.line)
        else:
            kept.append(f)
    return kept, ignored, [i for i in ignores if i.line not in used]
