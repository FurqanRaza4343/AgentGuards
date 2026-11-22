"""Known vulnerabilities of dependencies, from OSV.dev (a public, free database). Vulnerability ids come only from here."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

import httpx

from ..guard.netpolicy import PolicyError, check_url, guarded_transport

OSV_HOST = "api.osv.dev"
VULN_ID = re.compile(r"^[A-Za-z]{2,10}-[A-Za-z0-9-]{3,40}$")
URL_OR_MARKUP = re.compile(r"(?i)https?://\S+|www\.\S+|!?\[[^\]]*\]\([^)]*\)|[`*_#<>]|\s{2,}")
CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f​-‏‪-‮⁠-⁤﻿]")


@dataclass(frozen=True)
class Package:
    ecosystem: str  # PyPI, npm, crates.io
    name: str
    version: str
    path: str  # the file it was read from
    line: int  # 1-based line of the package in that file
    end_line: int


@dataclass(frozen=True)
class Vuln:
    id: str
    summary: str
    severity: str  # critical | high | medium | low


def clean_summary(text: str, limit: int = 140) -> str:
    """OSV text is data from outside: no links, no markup, no control characters, short."""
    t = CONTROL.sub("", text or "")
    t = URL_OR_MARKUP.sub(" ", t).strip()
    t = re.sub(r"\s+", " ", t)
    return t if len(t) <= limit else t[: limit - 1].rstrip() + "…"


def severity_of(raw: dict[str, Any]) -> str:
    sev = str((raw.get("database_specific") or {}).get("severity", "")).upper()
    return {"CRITICAL": "critical", "HIGH": "high", "MODERATE": "medium", "MEDIUM": "medium", "LOW": "low"}.get(sev, "medium")


class OsvClient:
    """Queries OSV through the network policy, with only api.osv.dev reachable."""

    def __init__(self, client_factory=None) -> None:  # type: ignore[no-untyped-def]
        self._factory = client_factory or (lambda: httpx.AsyncClient(transport=guarded_transport(), timeout=httpx.Timeout(20.0, connect=8.0), follow_redirects=False))

    async def _request(self, client: httpx.AsyncClient, method: str, url: str, **kw: Any) -> Any:
        try:
            check_url(url, allowed_hosts={OSV_HOST})
            resp = await client.request(method, url, headers={"User-Agent": "agentguard-scanner/1.0"}, **kw)
        except PolicyError as exc:
            raise RuntimeError(f"refused by the network policy: {exc}") from exc
        except httpx.HTTPError as exc:
            raise RuntimeError(f"could not reach OSV ({exc.__class__.__name__})") from exc
        if resp.status_code != 200 or len(resp.content) > 2_000_000:
            raise RuntimeError(f"OSV answered {resp.status_code}")
        return resp.json()

    async def query(self, packages: list[Package]) -> dict[Package, list[str]]:
        """Returns, for each package that has advisories, the ids of those advisories."""
        found: dict[Package, list[str]] = {}
        async with self._factory() as client:
            for i in range(0, len(packages), 500):
                chunk = packages[i : i + 500]
                body = {"queries": [{"package": {"name": p.name, "ecosystem": p.ecosystem}, "version": p.version} for p in chunk]}
                data = await self._request(client, "POST", f"https://{OSV_HOST}/v1/querybatch", json=body)
                for pkg, result in zip(chunk, data.get("results", []), strict=False):
                    ids = [v["id"] for v in (result or {}).get("vulns", []) if isinstance(v, dict) and VULN_ID.match(str(v.get("id", "")))]
                    if ids:
                        found[pkg] = ids[:5]
        return found

    async def detail(self, vuln_id: str) -> Vuln:
        if not VULN_ID.match(vuln_id):
            raise RuntimeError("not a valid vulnerability id")
        async with self._factory() as client:
            raw = await self._request(client, "GET", f"https://{OSV_HOST}/v1/vulns/{vuln_id}")
        return Vuln(id=vuln_id, summary=clean_summary(str(raw.get("summary") or raw.get("details") or "")), severity=severity_of(raw))
