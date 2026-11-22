"""Web search through a SearXNG instance that the operator configures (SEARXNG_URL). Optional.

What leaves the service: a short query that the service builds itself (a site's own name, or the target role a person
typed). Never a pasted profile and never a person's name. The operator chooses the instance, so it may be on
localhost; that is the one place where the network policy for user-supplied addresses does not apply, because no user
input ever becomes an address here.

What comes back is untrusted data: results are shortened, stripped of control characters, and dropped if they talk to
an AI reader. Nothing in a result is ever fetched or followed.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from urllib.parse import urlsplit

import httpx

from ..guard.inject import HIDDEN_CHARS, find_injections

CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")


class SearchUnavailable(Exception):
    """No search happened. Not an error: the report says so and goes on."""


@dataclass(frozen=True)
class SearchResult:
    title: str
    url: str
    snippet: str

    @property
    def host(self) -> str:
        return (urlsplit(self.url).hostname or "").lower()


def _clean(text: object, limit: int) -> str:
    t = HIDDEN_CHARS.sub("", CONTROL.sub(" ", str(text or "")))
    return " ".join(t.split())[:limit]


class SearxClient:
    def __init__(self, base_url: str, client_factory=None, timeout: float = 10.0) -> None:  # type: ignore[no-untyped-def]
        parts = urlsplit(base_url)
        if parts.scheme not in {"http", "https"} or not parts.hostname or parts.username or parts.password:
            raise ValueError("SEARXNG_URL must be a plain http(s) address")
        self._base = base_url.rstrip("/")
        self._factory = client_factory or (lambda: httpx.AsyncClient(timeout=timeout, follow_redirects=False, headers={"User-Agent": "AgentGuard/1.0", "Accept": "application/json"}))

    @classmethod
    def from_env(cls) -> "SearxClient | None":
        url = os.environ.get("SEARXNG_URL", "").strip()
        if not url:
            return None
        try:
            return cls(url)
        except ValueError:
            return None

    async def search(self, query: str, limit: int = 10) -> list[SearchResult]:
        q = _clean(query, 120)
        if len(q) < 2:
            raise SearchUnavailable("the query was empty")
        try:
            async with self._factory() as client:
                resp = await client.get(f"{self._base}/search", params={"q": q, "format": "json", "language": "en", "safesearch": "1"})
        except httpx.HTTPError as exc:
            raise SearchUnavailable(f"the search server could not be reached ({exc.__class__.__name__})") from exc
        if resp.status_code == 403:
            raise SearchUnavailable("the search server does not allow JSON results (enable `json` under search.formats in its settings)")
        if resp.status_code != 200:
            raise SearchUnavailable(f"the search server answered {resp.status_code}")
        try:
            raw = resp.json().get("results", [])
        except ValueError as exc:
            raise SearchUnavailable("the search server did not answer with JSON") from exc
        out: list[SearchResult] = []
        for item in raw if isinstance(raw, list) else []:
            if not isinstance(item, dict):
                continue
            url = _clean(item.get("url"), 300)
            parts = urlsplit(url)
            if parts.scheme not in {"http", "https"} or not parts.hostname:
                continue  # an address with no host (an engine's redirect link, for example) tells us nothing
            title, snippet = _clean(item.get("title"), 160), _clean(item.get("content"), 300)
            if find_injections(f"{title}\n{snippet}"):
                continue  # a result that talks to an AI reader is not passed on
            out.append(SearchResult(title, url, snippet))
            if len(out) >= limit:
                break
        return out
