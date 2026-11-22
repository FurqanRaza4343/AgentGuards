"""A small helper that every specialist uses to record what it found."""

from __future__ import annotations

from ..guard.mask import mask_text
from ..schemas import AgentId
from .models import AFinding, Area

PREFIX = {"data": "d", "purchasing": "p", "finance": "c", "nova": "n"}


class FindingBook:
    """Findings of one specialist. The same rule found on several pages is ONE finding that says how many pages it affects,
    so a site with twenty pages does not produce twenty copies of "no meta description"."""

    def __init__(self, by: AgentId) -> None:
        self.by = by
        self.items: list[AFinding] = []
        self.strengths: list[str] = []
        self._pages: dict[str, list[str]] = {}

    def add(self, rule: str, area: Area, severity: str, title: str, detail: str, fix: str, *, evidence: str = "", location: str = "") -> AFinding:
        same = next((f for f in self.items if f.rule == rule), None)
        if same is not None:
            seen = self._pages.setdefault(rule, [same.location])
            if location and location not in seen:
                seen.append(location)
                same.location = f"{seen[0]} and {len(seen) - 1} other page{'s' if len(seen) > 2 else ''}"[:200]
            return same
        f = AFinding(
            id=f"{PREFIX[self.by]}{len(self.items) + 1}",
            area=area,
            severity=severity,  # type: ignore[arg-type]
            rule=rule,
            title=title,
            detail=detail,
            fix=fix,
            evidence=mask_text(evidence)[:220],
            location=location[:200],
            by=self.by,
        )
        self.items.append(f)
        return f

    def good(self, text: str) -> None:
        if text not in self.strengths:
            self.strengths.append(text)

    @property
    def ids(self) -> list[str]:
        return [f.id for f in self.items]
