"""All the rules. Importing a module registers its rules."""

from __future__ import annotations

from . import agents, ci, code, docker, secrets  # noqa: F401  (imported for their @rule decorators)
from .base import RULES, FileCtx, Match, RuleDef
from .hygiene import scan_repo

__all__ = ["RULES", "FileCtx", "Match", "RuleDef", "run_file_rules", "scan_repo"]


def run_file_rules(path: str, text: str) -> list[Match]:
    """Runs every rule that applies to one file."""
    ctx = FileCtx(path=path, text=text, lines=text.split("\n"))
    out: list[Match] = []
    for r in RULES:
        if r.applies(path):
            out.extend(r.scan(ctx))
    return out
