"""Budgets and the kill switch. A scan may only use so much, and the whole service may only use so much per day."""

from __future__ import annotations

import os
import time
from collections import defaultdict, deque
from dataclasses import dataclass, field


class BudgetExceeded(Exception):
    """A limit was reached. The scan stops and reports what it has."""


@dataclass
class Limits:
    max_download_bytes: int = 50 * 1024 * 1024
    max_unpacked_bytes: int = 80 * 1024 * 1024
    max_files: int = 20_000
    max_file_bytes: int = 1024 * 1024
    max_depth: int = 24
    max_findings: int = 15
    max_benign: int = 2
    max_llm_calls: int = 2
    max_llm_chars: int = 24_000
    max_seconds: float = 120.0
    max_osv_packages: int = 1500


@dataclass
class Budget:
    limits: Limits = field(default_factory=Limits)
    llm_calls: int = 0
    started: float = field(default_factory=time.monotonic)

    def check_time(self) -> None:
        if time.monotonic() - self.started > self.limits.max_seconds:
            raise BudgetExceeded("the scan took too long")

    def spend_llm(self) -> None:
        if self.llm_calls >= self.limits.max_llm_calls:
            raise BudgetExceeded("no model calls left for this scan")
        self.llm_calls += 1


class KillSwitch:
    """A daily cap on model calls for the whole service, and an off switch. In memory, per process."""

    def __init__(self) -> None:
        self._day = ""
        self._count = 0

    def _roll(self) -> None:
        today = time.strftime("%Y-%m-%d", time.gmtime())
        if today != self._day:
            self._day, self._count = today, 0

    @staticmethod
    def disabled() -> bool:
        return os.environ.get("AGENTGUARD_KILL_SWITCH", "").strip().lower() in {"1", "true", "yes", "on"}

    @staticmethod
    def daily_cap() -> int:
        try:
            return int(os.environ.get("AGENTGUARD_DAILY_LLM_CALLS", "200"))
        except ValueError:
            return 200

    def allow_llm(self) -> bool:
        if self.disabled():
            return False
        self._roll()
        return self._count < self.daily_cap()

    def record_llm(self) -> None:
        self._roll()
        self._count += 1


class RateLimiter:
    """A simple sliding-window limit per client, in memory. Cloud Run may run several instances, so this is a first line only."""

    def __init__(self, per_hour: int = 6) -> None:
        self.per_hour = per_hour
        self._hits: dict[str, deque[float]] = defaultdict(deque)

    def allow(self, client: str, now: float | None = None) -> bool:
        now = time.monotonic() if now is None else now
        q = self._hits[client]
        while q and now - q[0] > 3600:
            q.popleft()
        if len(q) >= self.per_hour:
            return False
        q.append(now)
        return True
