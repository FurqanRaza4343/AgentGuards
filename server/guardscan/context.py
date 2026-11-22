"""Turns a rule match into a Finding: the lines to show, with their real line numbers, the red flags and the decoys."""

from __future__ import annotations

import re

from .guard.inject import HIDDEN_CHARS
from .guard.mask import mask_line
from .rules.base import Match, Range
from .schemas import Context, Finding, Fix, LineRange

PAD = 4
MAX_WINDOW = 28
MAX_LINE = 160


def _display(line: str) -> str:
    """One line as it is shown: secrets masked, invisible characters made visible, tabs expanded, long lines cut."""
    out = mask_line(line.rstrip("\r"))
    out = HIDDEN_CHARS.sub("‹invisible›", out).replace("\t", "    ")
    return out if len(out) <= MAX_LINE else out[: MAX_LINE - 1] + "…"


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:70]


def _clip(ranges: list[Range], lo: int, hi: int) -> list[LineRange]:
    out = []
    for a, b, note in ranges:
        if b < lo or a > hi:
            continue
        out.append(LineRange(start=max(a, lo), end=min(b, hi), note=note.strip()))
    return out


def build_finding(m: Match, file_lines: list[str] | None, owned: bool = False) -> Finding | None:
    """Returns None when there is no honest way to show the evidence."""
    if m.context_lines is not None:
        lines, first = m.context_lines, 1
        window = [(first + i, t) for i, t in enumerate(lines)]
        lo, hi = first, first + len(lines) - 1
    else:
        if file_lines is None or not file_lines:
            return None
        if file_lines[-1] == "":  # the empty piece after the last newline is not a line of the file
            file_lines = file_lines[:-1]
        total = len(file_lines)
        anchors = [a for a, _b, _n in m.flags] + [b for _a, b, _n in m.flags]
        if not anchors or min(anchors) < 1 or max(anchors) > total:
            return None
        lo, hi = min(anchors) - PAD, max(anchors) + PAD
        # pull a decoy into the window when it is near, drop it when it is not
        near: list[Range] = []
        for d in m.decoys:
            nlo, nhi = min(lo, d[0] - 1), max(hi, d[1] + 1)
            if nhi - nlo + 1 <= MAX_WINDOW:
                lo, hi = nlo, nhi
                near.append(d)
        m.decoys = near
        lo, hi = max(1, lo), min(total, hi)
        if hi - lo + 1 > MAX_WINDOW:
            hi = lo + MAX_WINDOW - 1
        window = [(n, file_lines[n - 1]) for n in range(lo, hi + 1)]

    flags = _clip([f for f in m.flags], lo, hi)
    if not flags:
        return None
    decoys = [d for d in _clip(m.decoys, lo, hi) if not any(d.start <= f.end and f.start <= d.end for f in flags)]
    shown = [_display(t) for _n, t in window]
    start, end = flags[0].start, flags[-1].end
    return Finding(
        id=_slug(f"{m.rule}-{m.path}-{start}"),
        category=m.category,  # type: ignore[arg-type]
        severity=m.severity,  # type: ignore[arg-type]
        rule=m.rule,
        title=m.title,
        path=m.path,
        startLine=start,
        endLine=end,
        context=Context(startLine=lo, lines=shown),
        flags=flags,
        decoys=decoys,
        benign=m.benign,
        fix=Fix(summary=m.fix or "Review and fix the problem."),
        evidence=mask_line(m.evidence)[:300],
        owned=owned,
    )
