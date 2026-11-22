"""Repository-level checks: things that are missing. They look at the list of files, not at one file."""

from __future__ import annotations

import re

from .base import Match

SECURITY_POLICY = re.compile(r"(?i)^(?:\.github/|docs/)?security(?:\.md|\.rst|\.txt)?$")
DEPENDENCY_BOT = re.compile(r"(?i)^(?:\.github/dependabot\.ya?ml|renovate\.json5?|\.renovaterc(?:\.json)?|\.github/renovate\.json5?)$")
MANIFESTS = re.compile(r"(?i)(?:^|/)(?:package\.json|requirements[\w.-]*\.txt|pyproject\.toml|Cargo\.toml|go\.mod|pom\.xml|build\.gradle|Gemfile|composer\.json)$")
ROOT = "(repository root)"


def _listing(paths: list[str], missing: str) -> list[str]:
    """The top of the file tree, followed by a line that says what is missing. It is the evidence for an absence."""
    tops = sorted({(p.split("/", 1)[0] + "/") if "/" in p else p for p in paths}, key=lambda s: (not s.endswith("/"), s.lower()))[:14]
    return [*tops, missing]


def _absence(rule: str, severity: str, title: str, paths: list[str], missing: str, note: str, fix: str) -> Match:
    lines = _listing(paths, missing)
    n = len(lines)
    return Match(
        rule=rule,
        category="hygiene",
        severity=severity,
        title=title,
        path=ROOT,
        start=n,
        end=n,
        flags=[(n, n, note)],
        decoys=[(1, 1, "An ordinary file or folder at the top of the repository.")] if n > 2 else [],
        fix=fix,
        evidence=missing,
        context_lines=lines,
    )


def scan_repo(paths: list[str]) -> list[Match]:
    out: list[Match] = []
    if not any(SECURITY_POLICY.match(p) for p in paths):
        out.append(_absence(
            "hygiene.no-security-policy", "low", "The project has no security policy", paths, "(no SECURITY.md in this list)",
            "There is no SECURITY.md, so nobody knows how to report a problem privately.",
            "Add a SECURITY.md that says how to report a vulnerability privately, and turn on private vulnerability reporting.",
        ))
    if any(MANIFESTS.search(p) for p in paths) and not any(DEPENDENCY_BOT.match(p) for p in paths):
        out.append(_absence(
            "hygiene.no-dependency-updates", "low", "Nothing keeps the dependencies up to date", paths, "(no dependabot.yml or renovate.json in this list)",
            "The project has dependencies, but no bot proposes updates, so known fixes reach it late or never.",
            "Add a dependabot.yml or a Renovate configuration so that updates arrive as pull requests.",
        ))
    return out
