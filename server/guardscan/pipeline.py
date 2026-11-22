"""The scan pipeline. Four stages with different powers, supervised by the Guard.

    Scout      reads and checks the address. No tools.
    Retriever  fetches one archive from GitHub through the network policy. Nothing else.
    Auditor    reads the corpus in memory and asks OSV about dependencies. It cannot reach anything else.
    Coach      writes prose. No tools, only masked data.

The Guard sits across all of them: a budget, hidden-content removal, secret masking, and verification of anything a
model wrote. Each step is reported as a log line, so the interface can show the run as it happens."""

from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

from .coach import Coach, CoachUnavailable, NullCoach
from .context import build_finding
from .guard.budget import Budget, BudgetExceeded, KillSwitch, Limits
from .guard.inject import strip_hidden
from .rules import RULES, Match, run_file_rules, scan_repo
from .rules.base import is_agent_file, is_prose
from .rules.deps import matches_from_osv, parse_manifests
from .schemas import Finding, LogLine, Report, Stats
from .tools.extract import LOCK_FILES, ArchiveError, Corpus, corpus_from_dir, read_tarball
from .tools.github import DirSource, FetchError, GithubSource, RepoSource, parse_repo_url
from .tools.osv import OsvClient, Vuln

Event = tuple[str, dict[str, Any]]
RANK = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}

DISCLAIMERS = [
    "This is a public repository analysed in third-party mode: findings are explained without exploit steps and secrets are masked. Report anything real to the maintainers privately, through their security policy.",
    "The scanner only reads files. It never runs, builds or installs anything from the repository.",
    "The rules are heuristics. A finding can be a false positive, and a clean report does not prove that a repository is safe.",
]


@dataclass
class Services:
    source: RepoSource = field(default_factory=GithubSource)
    dir_source: DirSource | None = None  # tests and the demo only
    osv: OsvClient | None = None
    coach: Coach = field(default_factory=NullCoach)
    kill: KillSwitch = field(default_factory=KillSwitch)
    limits: Limits = field(default_factory=Limits)


def _log(text: str, tone: str | None = None, frm: str | None = None, to: str | None = None) -> dict[str, Any]:
    d: dict[str, Any] = {"text": text}
    if tone:
        d["tone"] = tone
    if frm:
        d["from"] = frm
    if to:
        d["to"] = to
    return d


def run_all(files: dict[str, str], budget: Budget) -> list[Match]:
    out: list[Match] = []
    for i, (path, text) in enumerate(files.items()):
        if i % 200 == 0:
            budget.check_time()
        if path.rsplit("/", 1)[-1] in LOCK_FILES or len(text) > 400_000:
            continue
        out.extend(run_file_rules(path, text))
    out.extend(scan_repo(list(files)))
    return out


def select(matches: list[Match], limits: Limits) -> tuple[list[Match], list[Match]]:
    """The findings worth turning into missions, worst first, at most two per rule, plus a couple of safe forms."""
    threats = sorted((m for m in matches if not m.benign), key=lambda m: (RANK.get(m.severity, 2), m.rule, m.path, m.start))
    chosen: list[Match] = []
    per_rule: dict[str, int] = {}
    seen: set[tuple[str, str]] = set()
    for m in threats:
        key = (m.rule, m.path)
        if key in seen or per_rule.get(m.rule, 0) >= 2:
            continue
        seen.add(key)
        per_rule[m.rule] = per_rule.get(m.rule, 0) + 1
        chosen.append(m)
        if len(chosen) >= limits.max_findings:
            break
    benign: list[Match] = []
    rules_seen: set[str] = set()
    for m in sorted((m for m in matches if m.benign), key=lambda m: (m.rule, m.path)):
        if m.rule in rules_seen:
            continue
        rules_seen.add(m.rule)
        benign.append(m)
        if len(benign) >= limits.max_benign:
            break
    return chosen, benign


def summary_line(findings: list[Finding]) -> str:
    counts: dict[str, int] = {}
    for f in findings:
        if not f.benign:
            counts[f.severity] = counts.get(f.severity, 0) + 1
    parts = [f"{counts[s]} {s}" for s in ("critical", "high", "medium", "low", "info") if s in counts]
    return ", ".join(parts) if parts else "nothing to report"


async def scan(url: str, svc: Services) -> AsyncIterator[Event]:
    """Runs a scan and yields ("log", line) events, then ("report", report) or ("error", {"message": ...})."""
    from datetime import datetime, timezone

    budget = Budget(svc.limits)
    trail: list[dict[str, Any]] = []

    def emit(text: str, tone: str | None = None, frm: str | None = None, to: str | None = None) -> Event:
        line = _log(text, tone, frm, to)
        trail.append(line)
        return ("log", line)

    try:
        yield emit("Scout: checking the address you gave", "info", "nova")
        try:
            ref = parse_repo_url(url)
        except FetchError as exc:
            yield ("error", {"message": str(exc)})
            return
        yield emit(f"Scout: {ref.full} is a public GitHub repository. Third-party mode: no exploit steps, secrets masked.", "good", "nova", "data")

        # ---- Retriever
        yield emit("Retriever: downloading one archive from GitHub (two fixed hosts, every hop checked)", "tool", "data")
        try:
            if svc.dir_source is not None:
                corpus: Corpus = await asyncio.to_thread(corpus_from_dir, svc.dir_source.path_for(ref))
                commit = svc.dir_source.commit
            else:
                commit, data = await svc.source.fetch(ref, svc.limits)
                corpus = await asyncio.to_thread(read_tarball, data, svc.limits)
        except (FetchError, ArchiveError) as exc:
            yield ("error", {"message": str(exc)})
            return
        budget.check_time()
        kb = corpus.bytes_read // 1024
        yield emit(f"Retriever: read {len(corpus.files)} text files ({kb} KB) at commit {commit[:7]}. Skipped {sum(corpus.skipped.values())} (binary, vendored or too large). Nothing was executed.", "info", "data", "purchasing")

        # ---- Guard
        hidden = 0
        for path, text in corpus.files.items():
            if is_prose(path) or is_agent_file(path):
                _, removed = strip_hidden(text)
                hidden += len(removed)
        yield emit("Guard: everything read from the repository is data. It is never followed as an instruction.", "good")
        if hidden:
            yield emit(f"Guard: {hidden} case(s) of hidden content (comments, invisible characters) are kept away from any model.", "warn")

        # ---- Auditor
        yield emit(f"Auditor: running {len(RULES)} rules over {len(corpus.files)} files", "tool", "purchasing")
        matches = await asyncio.to_thread(run_all, corpus.files, budget)
        packages = parse_manifests(corpus.files, svc.limits.max_osv_packages)
        if packages and svc.osv is not None:
            yield emit(f"Auditor: asking OSV.dev about {len(packages)} dependencies (names and versions only)", "tool", "purchasing")
            try:
                advisories = await svc.osv.query(packages)
                details: dict[str, Vuln] = {}
                for ids in list(advisories.values())[:8]:
                    for vid in ids[:1]:
                        if vid not in details:
                            details[vid] = await svc.osv.detail(vid)
                matches.extend(matches_from_osv(advisories, details))
                yield emit(f"Auditor: {len(advisories)} dependencies have published advisories", "warn" if advisories else "good", "purchasing")
            except RuntimeError as exc:
                yield emit(f"Auditor: OSV was not available ({exc}). Dependencies were not checked.", "warn", "purchasing")
        elif packages:
            yield emit("Auditor: dependency check skipped (no OSV client configured)", "info", "purchasing")
        budget.check_time()

        threats, benign = select(matches, svc.limits)
        findings: list[Finding] = []
        for m in [*threats, *benign]:
            text = corpus.files.get(m.path)
            f = build_finding(m, text.split("\n") if text is not None else None)
            if f is not None:
                findings.append(f)
        yield emit(f"Auditor: {len([f for f in findings if not f.benign])} findings ({summary_line(findings)})", "warn" if threats else "good", "purchasing", "finance")
        for f in [x for x in findings if not x.benign][:8]:
            yield emit(f"  [{f.severity}] {f.title} ({f.path}:{f.startLine})", "info")

        # ---- Coach
        real = [f for f in findings if not f.benign]
        if real:
            from .verify import verify_prose

            try:
                raw = await svc.coach.enrich(real, budget)
                kept = 0
                for f in real:
                    p = verify_prose(f, raw.get(f.id))
                    if p is not None:
                        f.prose = p
                        kept += 1
                yield emit(f"Coach: wrote prose for {kept} of {len(real)} findings. Anything that could not be verified was dropped.", "good", "finance")
            except CoachUnavailable as exc:
                yield emit(f"Coach: no model this time ({exc}). The game uses its own wording.", "info", "finance")
            except BudgetExceeded as exc:
                yield emit(f"Coach: stopped ({exc}). The game uses its own wording.", "info", "finance")
            except Exception:  # a model or network failure must never lose the scan
                yield emit("Coach: the model failed. The game uses its own wording.", "warn", "finance")
        else:
            yield emit("Coach: nothing to explain", "info", "finance")

        done = emit("Done. Your missions are built from these findings, in your browser.", "good")
        report = Report(
            repo=ref.full,
            commit=commit,
            generatedAt=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            stats=Stats(files=len(corpus.files), bytes=corpus.bytes_read, skipped=sum(corpus.skipped.values())),
            findings=findings,
            runLog=[LogLine.model_validate(line) for line in trail],
            disclaimers=DISCLAIMERS,
        )
        yield done
        yield ("report", report.model_dump(by_alias=True, exclude_none=True))
    except BudgetExceeded as exc:
        yield ("error", {"message": f"The scan stopped: {exc}."})
    except Exception:
        yield ("error", {"message": "The scan failed unexpectedly. Nothing was stored."})


async def scan_dir(path: str, repo: str, commit: str = "0" * 40, svc: Services | None = None) -> dict[str, Any]:
    """Scans a local directory and returns the report as a dict. For the demo repository and for tests."""
    import os

    svc = svc or Services()
    owner, _, name = repo.partition("/")
    full = os.path.abspath(path)
    if not os.path.isdir(full):
        raise ValueError(f"{path} is not a directory")
    if not owner or not name:
        raise ValueError("--repo must look like owner/name")
    svc.dir_source = DirSource(os.path.dirname(full), commit, exact_path=full)
    result: dict[str, Any] | None = None
    async for kind, data in scan(f"github.com/{repo}", svc):
        if kind == "report":
            result = data
        elif kind == "error":
            raise RuntimeError(data["message"])
    assert result is not None
    return result
