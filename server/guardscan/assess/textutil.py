"""Text helpers that stay fast on hostile input.

A page or a pasted text is written by someone else. A regular expression with a nested or open-ended quantifier can take
minutes on a crafted string (a 100 KB run of letters, a long dotted name), and a slow regex on the server's event loop
stops every other request. So the helpers here split the text into short tokens or sentences first and only then look at
each piece, which keeps the work linear.
"""

from __future__ import annotations

import re

from ..rules.base import FileCtx
from ..rules.secrets import scan as _secret_scan

EMAIL = re.compile(r"[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}")
_HOST_TOKEN = re.compile(r"[A-Za-z0-9.-]{4,80}")
_SENTENCE_END = re.compile(r"(?<=[.!?])\s+")
INTERNAL_SUFFIXES = (".internal", ".corp", ".intranet", ".lan")


def find_emails(text: str, limit: int = 20) -> list[str]:
    """Email addresses, found token by token so that a long string with no '@' costs nothing."""
    out: list[str] = []
    for token in text.split():
        if "@" not in token or len(token) > 254:
            continue
        m = EMAIL.search(token)
        if m and m.group(0) not in out:
            out.append(m.group(0))
            if len(out) >= limit:
                break
    return out


def find_internal_host(text: str) -> str | None:
    """A host name that only exists inside a network (db.internal, wiki.corp), found without backtracking."""
    for m in _HOST_TOKEN.finditer(text):
        token = m.group(0).lower().strip(".-")
        if token.endswith(INTERNAL_SUFFIXES) and token.count(".") >= 1:
            return token
    return None


def sentences(text: str, size: int = 400, max_chunks: int = 400) -> list[str]:
    """Short pieces of text, for checks that must not be given a huge string."""
    out: list[str] = []
    for part in _SENTENCE_END.split(text):
        for i in range(0, len(part), size):
            out.append(part[i : i + size])
            if len(out) >= max_chunks:
                return out
    return out


def secret_matches(text: str, path: str, max_chars: int = 400_000):  # type: ignore[no-untyped-def]
    """Runs ONLY the secret rule on text (not the other rules that apply to a file of that name). Lines are short pieces."""
    split = re.sub(r"([;{}>,])", r"\1\n", text[:max_chars])
    return list(_secret_scan(FileCtx(path=path, text=split, lines=split.split("\n"))))
