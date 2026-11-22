"""Secrets written into files. The value is masked before it goes anywhere."""

from __future__ import annotations

import re
from collections.abc import Iterable

from ..guard.mask import ASSIGNMENT, KNOWN_PATTERNS, looks_like_placeholder, mask_line
from .base import MAX_LINE, FileCtx, Match, any_file, decoy_ranges, is_test_path, rule, short

ENV_READ = re.compile(r"(?i)\b(os\.environ|os\.getenv|process\.env|getenv\(|System\.getenv|env::var|ENV\[|secrets\.[A-Z_]+|\$\{\{\s*secrets\.|vault|secret[_ ]?manager)")

SEVERITY = {
    "private-key": "critical",
    "aws-access-key": "critical",
    "github-token": "critical",
    "stripe-key": "critical",
    "google-api-key": "high",
    "slack-token": "high",
    "assignment": "medium",
}
TITLE = {
    "private-key": "A private key is stored in the repository",
    "aws-access-key": "A cloud access key is written in the code",
    "github-token": "A GitHub token is written in the code",
    "stripe-key": "A live payment key is written in the code",
    "google-api-key": "An API key is written in the code",
    "slack-token": "A chat token is written in the code",
    "assignment": "A password or token is assigned in the code",
}


def _kind_of(line: str, in_test: bool) -> str | None:
    for kind, pat in KNOWN_PATTERNS:
        if pat.search(line):
            return kind
    m = ASSIGNMENT.search(line)
    if m and not in_test:
        value = m.group("s")
        if not looks_like_placeholder(value) and not ENV_READ.search(line) and "*" not in value and "example" not in value.lower():
            return "assignment"
    return None


@rule("secret.hardcoded", "secret", "critical", any_file)
def scan(ctx: FileCtx) -> Iterable[Match]:
    in_test = is_test_path(ctx.path)
    found = 0
    for n, line in enumerate(ctx.lines, start=1):
        if len(line) > MAX_LINE:
            continue
        kind = _kind_of(line, in_test)
        if kind is None:
            continue
        # a test fixture may hold a fake key; only real-looking known formats count there
        if in_test and kind == "assignment":
            continue
        masked = mask_line(short(line))
        yield Match(
            rule="secret.hardcoded",
            category="secret",
            severity=SEVERITY[kind],
            title=TITLE[kind],
            path=ctx.path,
            start=n,
            end=n,
            flags=[(n, n, "A secret is written into the file. Anyone who can read the repository, now or in its history, can use it.")],
            decoys=decoy_ranges(ctx.lines, ENV_READ, "This reads a value from the environment or a secret manager, which is the safe way to do it. Nothing to fix here.", {n}),
            fix="Revoke the secret and create a new one first, because git keeps history. Then read it from the environment or a secret manager.",
            evidence=masked,
        )
        found += 1
        if found >= 3:
            return
