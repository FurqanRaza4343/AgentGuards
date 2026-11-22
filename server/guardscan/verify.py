"""Checks the prose a language model wrote about a finding before it is used.

The model only writes short sentences. It never chooses a line number, a vulnerability id, a point value or an option,
and anything in its answer that is not backed by the finding is dropped. A dropped field falls back to a template,
so a bad answer can only make a mission plainer, never wrong.
"""

from __future__ import annotations

import re
from typing import Any

from .guard.inject import find_injections
from .guard.mask import mask_line
from .schemas import Finding, Prose

LIMITS = {"situation": (20, 280), "say": (10, 170), "consequence": (20, 280), "lesson": (20, 240), "question": (15, 200), "answer": (15, 320)}
URLISH = re.compile(r"(?i)https?://|www\.|\bftp://|!\[|\]\(|<[a-z/][^>]*>|```|\b[a-z0-9.-]+\.(?:com|org|net|io|dev|sh|xyz)/")
EXPLOIT = re.compile(r"(?i)\b(?:payload|proof[- ]of[- ]concept|\bpoc\b|reverse shell|one-liner|exploit (?:it|this|the|code|steps)|to exploit)\b")
VULN_ID = re.compile(r"\b(?:CVE-\d{4}-\d{3,7}|GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}|PYSEC-\d{4}-\d+|RUSTSEC-\d{4}-\d{4})\b", re.I)
BACKTICKED = re.compile(r"`([^`\n]{1,80})`")
LINE_NUMBER = re.compile(r"(?i)\blines?\s+(\d+)(?:\s*(?:-|to|and)\s*(\d+))?")


def _haystack(f: Finding) -> str:
    return "\n".join([f.path, f.rule, f.title, f.evidence, f.fix.summary, *f.context.lines, *(r.note for r in f.flags), *(r.note for r in f.decoys)])


def verify_field(name: str, value: Any, f: Finding, allowed_ids: set[str]) -> str | None:
    """Returns the cleaned text, or None when the field must be dropped."""
    if not isinstance(value, str):
        return None
    text = re.sub(r"\s+", " ", value).strip()
    lo, hi = LIMITS[name]
    if not (lo <= len(text) <= hi):
        return None
    if URLISH.search(text) or EXPLOIT.search(text):
        return None
    if mask_line(text) != text:  # something in it looks like a secret
        return None
    if find_injections(text):  # the model repeated text that talks to an AI
        return None
    hay = _haystack(f)
    for token in BACKTICKED.findall(text):
        if token not in hay:
            return None  # an identifier that is not in the finding
    for vid in VULN_ID.findall(text):
        if vid.upper() not in {a.upper() for a in allowed_ids}:
            return None  # a vulnerability id that did not come from OSV
    first, last = f.context.startLine, f.context.startLine + len(f.context.lines) - 1
    for a, b in LINE_NUMBER.findall(text):
        for n in (a, b):
            if n and not (first <= int(n) <= last):
                return None  # a line number that is not on screen
    return text


def verify_prose(f: Finding, raw: dict[str, Any] | None, allowed_ids: set[str] | None = None) -> Prose | None:
    """Keeps the fields that pass, drops the rest. Returns None when nothing is left."""
    if not raw:
        return None
    ids = allowed_ids or set(re.findall(VULN_ID, f.evidence)) | set(VULN_ID.findall(" ".join(r.note for r in f.flags)))
    kept: dict[str, str] = {}
    for name in LIMITS:
        if name in raw:
            ok = verify_field(name, raw[name], f, ids)
            if ok is not None:
                kept[name] = ok
    return Prose(**kept) if kept else None
