"""Masking: a secret that the scanner finds is never shown, stored or sent to a model in clear text."""

from __future__ import annotations

import re

# Well-known secret formats. The group named "s" is the part that gets masked.
KNOWN_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("aws-access-key", re.compile(r"(?<![A-Za-z0-9])(?P<s>(?:AKIA|ASIA)[0-9A-Z]{16})(?![A-Za-z0-9])")),
    ("github-token", re.compile(r"(?<![A-Za-z0-9_])(?P<s>(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{50,255}))")),
    ("google-api-key", re.compile(r"(?<![A-Za-z0-9_-])(?P<s>AIza[0-9A-Za-z_-]{35})(?![A-Za-z0-9_-])")),
    ("slack-token", re.compile(r"(?<![A-Za-z0-9])(?P<s>xox[baprs]-[A-Za-z0-9-]{10,72})")),
    ("stripe-key", re.compile(r"(?<![A-Za-z0-9])(?P<s>(?:sk|rk)_live_[A-Za-z0-9]{16,99})")),
    ("private-key", re.compile(r"(?P<s>-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----)")),
]

# name = "value" where the name says it is a secret
ASSIGNMENT = re.compile(
    r"""(?ix)
    (?P<name>[A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9_.-]*)
    (?P<nq>["']?)(?P<sep>\s*[:=]\s*)
    (?P<q>["'])(?P<s>[^"'\n]{8,200})(?P=q)
    """
)

PLACEHOLDER = re.compile(
    r"(?i)^(?:x{4,}|\*{4,}|<.*>|\$\{.*\}|\{\{.*\}\}|%\(.*\)s|your[_-].*|changeme|change[_-]me|example.*|placeholder.*|dummy.*|test.*|todo.*|none|null|"
    r"password|secret|token|123456.*|abc123.*|insert.*|replace.*|\.\.\.+)$"
)


def mask_secret(value: str) -> str:
    """Keeps the first four characters, masks the rest. Short values are masked completely."""
    if len(value) <= 8:
        return "*" * len(value)
    return value[:4] + "*" * min(len(value) - 4, 24)


def looks_like_placeholder(value: str) -> bool:
    v = value.strip()
    return bool(PLACEHOLDER.match(v)) or len(set(v)) <= 3


def mask_line(line: str) -> str:
    """Masks every secret in one line of text."""
    out = line
    for _name, pat in KNOWN_PATTERNS:
        out = pat.sub(lambda m: m.group(0).replace(m.group("s"), mask_secret(m.group("s")) if "PRIVATE KEY" not in m.group("s") else m.group("s")), out)

    def repl(m: re.Match[str]) -> str:
        value = m.group("s")
        if looks_like_placeholder(value) or "*" in value:
            return m.group(0)
        return f'{m.group("name")}{m.group("nq")}{m.group("sep")}{m.group("q")}{mask_secret(value)}{m.group("q")}'

    return ASSIGNMENT.sub(repl, out)


def mask_text(text: str) -> str:
    return "\n".join(mask_line(line) for line in text.split("\n"))
