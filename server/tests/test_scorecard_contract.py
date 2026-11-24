"""The scorecards live in the browser (src/assess/scorecard.ts) and name rules that this server (and the browser's own export
reader) produce. A misspelt rule id would make a check silently pass, so every rule that a scorecard names must exist."""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RULE = re.compile(r"""['"]((?:seo|web|a11y|content|profile|discoverability)\.[a-z0-9.\-]*[a-z0-9*])['"]""")


def rules_in(paths: list[Path]) -> set[str]:
    out: set[str] = set()
    for p in paths:
        out |= {m.group(1) for m in RULE.finditer(p.read_text(encoding="utf-8"))}
    return out


def test_every_rule_that_a_scorecard_names_exists_somewhere() -> None:
    wanted = {r for r in rules_in([ROOT / "src" / "assess" / "scorecard.ts"])}
    assert len(wanted) > 40  # the pattern really found the table
    produced = rules_in(sorted((ROOT / "server" / "guardscan" / "assess").glob("*.py")) + [ROOT / "src" / "assess" / "linkedinExport.ts", ROOT / "src" / "assess" / "linkedinUrl.ts"])
    missing = []
    for r in sorted(wanted):
        ok = any(p.startswith(r[:-1]) for p in produced) if r.endswith("*") else r in produced
        if not ok:
            missing.append(r)
    assert missing == [], f"the scorecard names rules that nothing produces: {missing}"
