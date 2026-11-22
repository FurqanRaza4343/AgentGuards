"""Dependencies: read the manifests and lock files, ask OSV about each package, and turn the answers into matches."""

from __future__ import annotations

import json
import posixpath
import re

from ..tools.osv import Package, Vuln
from .base import Match

REQ = re.compile(r"^\s*(?P<name>[A-Za-z0-9][A-Za-z0-9._-]*)\s*==\s*(?P<version>[0-9][A-Za-z0-9.+!_-]*)")
NPM_KEY = re.compile(r'^\s*"(?P<key>node_modules/[^"]+)"\s*:\s*\{')
SEVERITY_RANK = {"critical": 0, "high": 1, "medium": 2, "low": 3}


def _requirements(path: str, lines: list[str]) -> list[Package]:
    out = []
    for n, line in enumerate(lines, start=1):
        m = REQ.match(line)
        if m:
            out.append(Package("PyPI", m.group("name"), m.group("version"), path, n, n))
    return out


def _npm_lock(path: str, text: str, lines: list[str]) -> list[Package]:
    try:
        data = json.loads(text)
    except ValueError:
        return []
    packages = data.get("packages") if isinstance(data, dict) else None
    if not isinstance(packages, dict):
        return []
    where = {m.group("key"): n for n, line in enumerate(lines, start=1) if (m := NPM_KEY.match(line))}
    out = []
    for key, info in packages.items():
        if not key or not isinstance(info, dict) or "version" not in info or info.get("link"):
            continue
        name = key.rsplit("node_modules/", 1)[-1]
        n = where.get(key, 1)
        out.append(Package("npm", name, str(info["version"]), path, n, n))
    return out


def _toml_packages(path: str, lines: list[str], ecosystem: str, registry_only: bool) -> list[Package]:
    """Reads [[package]] blocks from Cargo.lock or poetry.lock."""
    out: list[Package] = []
    name = version = source = None
    name_line = version_line = 0

    def flush() -> None:
        if name and version and (not registry_only or (source and source.startswith("registry+"))):
            out.append(Package(ecosystem, name, version, path, name_line, max(name_line, version_line)))

    for n, line in enumerate(lines, start=1):
        if line.strip() == "[[package]]":
            flush()
            name = version = source = None
            continue
        m = re.match(r'^\s*(name|version|source)\s*=\s*"([^"]*)"', line)
        if not m:
            continue
        key, value = m.groups()
        if key == "name":
            name, name_line = value, n
        elif key == "version":
            version, version_line = value, n
        else:
            source = value
    flush()
    return out


def parse_manifests(files: dict[str, str], limit: int = 1500) -> list[Package]:
    """Finds the packages a repository depends on. Capped, and de-duplicated by name and version."""
    found: dict[tuple[str, str, str], Package] = {}
    for path, text in files.items():
        base = posixpath.basename(path)
        lines = text.split("\n")
        pkgs: list[Package] = []
        if re.match(r"(?i)^requirements[\w.-]*\.txt$", base):
            pkgs = _requirements(path, lines)
        elif base == "package-lock.json":
            pkgs = _npm_lock(path, text, lines)
        elif base == "Cargo.lock":
            pkgs = _toml_packages(path, lines, "crates.io", registry_only=True)
        elif base == "poetry.lock":
            pkgs = _toml_packages(path, lines, "PyPI", registry_only=False)
        for p in pkgs:
            found.setdefault((p.ecosystem, p.name, p.version), p)
            if len(found) >= limit:
                return list(found.values())
    return list(found.values())


def matches_from_osv(advisories: dict[Package, list[str]], details: dict[str, Vuln], max_matches: int = 4) -> list[Match]:
    """One match per vulnerable package, worst first."""
    out: list[Match] = []
    for pkg, ids in advisories.items():
        known = [details[i] for i in ids if i in details]
        top = min(known, key=lambda v: SEVERITY_RANK.get(v.severity, 2)) if known else None
        vid = top.id if top else ids[0]
        summary = (top.summary if top and top.summary else "a security problem that newer versions fix")
        more = f" ({len(ids) - 1} more advisories apply)" if len(ids) > 1 else ""
        out.append(Match(
            rule="deps.osv-advisory",
            category="dependency",
            severity=top.severity if top else "medium",
            title="A dependency has a known security advisory",
            path=pkg.path,
            start=pkg.line,
            end=pkg.end_line,
            flags=[(pkg.line, pkg.end_line, f"{pkg.name} {pkg.version} matches the published advisory {vid}: {summary}{more}.")],
            fix=f"Update {pkg.name} to a version that fixes {vid}, run the tests, then merge.",
            evidence=f"{pkg.name} {pkg.version} ({vid})",
        ))
    out.sort(key=lambda m: SEVERITY_RANK.get(m.severity, 2))
    return out[:max_matches]
