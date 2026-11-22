"""Reading a public website the way a polite visitor would: a few ordinary GET requests, nothing else.

What this module does and does not do:
  - GET only. No forms are submitted, no JavaScript runs, no logins, no probing of hidden paths.
  - Every request goes through the network policy (public DNS names only, every DNS answer checked, the connection is
    pinned to the address that was checked) and again on every redirect.
  - robots.txt is read first and obeyed. The user agent says who we are, so a site owner can block us there.
  - A redirect to a different site is refused: this tool must not become a way to reach other people's sites.
  - Bodies are size-capped while they stream, and the number of requests per scan is small (see ORCHESTRATOR limits).
"""

from __future__ import annotations

import asyncio
import ssl
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from urllib.robotparser import RobotFileParser

import httpx

from ..guard.netpolicy import PolicyError, check_public_url, guarded_transport
from .github import FetchError

USER_AGENT = "AgentGuardBot/1.0 (passive website check; obeys robots.txt)"
ROBOT_TOKEN = "AgentGuardBot"
HTML_TYPES = ("text/html", "application/xhtml+xml")


class TlsProblem(FetchError):
    """The TLS certificate was not accepted. The message is safe to show."""


@dataclass
class Fetched:
    url: str
    status: int
    headers: list[tuple[str, str]]
    body: bytes
    truncated: bool = False
    tls: dict[str, object] | None = None
    redirects: list[str] = field(default_factory=list)
    elapsed_ms: int = 0

    def header(self, name: str) -> str | None:
        n = name.lower()
        for k, v in self.headers:
            if k.lower() == n:
                return v
        return None

    def header_all(self, name: str) -> list[str]:
        n = name.lower()
        return [v for k, v in self.headers if k.lower() == n]

    @property
    def content_type(self) -> str:
        return (self.header("content-type") or "").split(";")[0].strip().lower()

    @property
    def is_html(self) -> bool:
        return self.content_type in HTML_TYPES

    @property
    def text(self) -> str:
        charset = "utf-8"
        ct = self.header("content-type") or ""
        if "charset=" in ct.lower():
            charset = ct.lower().split("charset=", 1)[1].split(";")[0].strip().strip("\"'") or "utf-8"
        try:
            return self.body.decode(charset, errors="replace")
        except LookupError:
            return self.body.decode("utf-8", errors="replace")


@dataclass
class Robots:
    """What robots.txt says about us. `status` is the HTTP status of the file, or 0 if it could not be fetched."""

    status: int = 0
    parser: RobotFileParser | None = None
    disallow_all: bool = False
    text: str = ""
    sitemaps: list[str] = field(default_factory=list)

    def allows(self, url: str) -> bool:
        if self.disallow_all:
            return False
        return True if self.parser is None else self.parser.can_fetch(ROBOT_TOKEN, url)

    @property
    def disallowed_paths(self) -> list[str]:
        out: list[str] = []
        for line in self.text.splitlines():
            key, _, value = line.partition(":")
            if key.strip().lower() == "disallow" and value.strip().startswith("/"):
                out.append(value.split("#")[0].strip())
        return out


def same_site(a: str, b: str) -> bool:
    strip = lambda h: h[4:] if h.startswith("www.") else h  # noqa: E731
    return strip(a.lower()) == strip(b.lower())


def parse_site_input(text: str) -> str:
    """Turns what a person typed ("example.com", "https://example.com/about") into a checked https URL."""
    t = text.strip()
    if not t or len(t) > 300 or any(c in t for c in "\r\n\t\x00 "):
        raise FetchError("that does not look like a website address")
    if "://" not in t:
        t = "https://" + t
    try:
        return check_public_url(t).url
    except PolicyError as exc:
        raise FetchError(f"that address cannot be scanned: {exc}") from exc


def _tls_info(resp: httpx.Response) -> dict[str, object] | None:
    try:
        stream = resp.extensions.get("network_stream")
        ssl_obj = stream.get_extra_info("ssl_object") if stream is not None else None
        if ssl_obj is None:
            return None
        info: dict[str, object] = {"version": ssl_obj.version()}
        cert = ssl_obj.getpeercert()
        if cert and "notAfter" in cert:
            expires = datetime.fromtimestamp(ssl.cert_time_to_seconds(str(cert["notAfter"])), tz=timezone.utc)
            info["expires"] = expires.strftime("%Y-%m-%d")
            info["daysLeft"] = (expires - datetime.now(timezone.utc)).days
        return info
    except Exception:  # TLS details are a bonus; never fail a fetch because of them
        return None


class WebFetcher:
    def __init__(self, client_factory=None, delay: float = 0.25, total_timeout: float = 30.0) -> None:  # type: ignore[no-untyped-def]
        self._factory = client_factory or (lambda: httpx.AsyncClient(transport=guarded_transport(), timeout=httpx.Timeout(15.0, connect=8.0), follow_redirects=False))
        self._client: httpx.AsyncClient | None = None
        self._gate = asyncio.Semaphore(2)
        self._delay = delay
        self._total_timeout = total_timeout

    async def __aenter__(self) -> "WebFetcher":
        self._client = self._factory()
        return self

    async def __aexit__(self, *exc: object) -> None:
        if self._client is not None:
            await self._client.aclose()

    async def get(self, url: str, *, max_bytes: int = 1_000_000, site_host: str | None = None, follow: bool = True, accept: str = "text/html,*/*;q=0.5") -> Fetched:
        """GET with manual redirects. Raises FetchError (or TlsProblem) with a message that is safe to show.

        The whole request, redirects included, must finish within `total_timeout` seconds. The per-read timeout alone would
        let a server that sends one byte every few seconds hold the connection for as long as it likes."""
        try:
            async with asyncio.timeout(self._total_timeout):
                return await self._get(url, max_bytes=max_bytes, site_host=site_host, follow=follow, accept=accept)
        except TimeoutError as exc:
            raise FetchError("the site took too long to answer") from exc

    async def _get(self, url: str, *, max_bytes: int, site_host: str | None, follow: bool, accept: str) -> Fetched:
        assert self._client is not None, "use `async with WebFetcher()`"
        redirects: list[str] = []
        started = time.monotonic()
        for _hop in range(5):
            try:
                checked = check_public_url(url)
            except PolicyError as exc:
                raise FetchError(f"refused by the network policy: {exc}") from exc
            if site_host and not same_site(checked.host, site_host):
                raise FetchError(f"the site redirects to another address ({checked.host}); scan that address instead")
            async with self._gate:
                try:
                    async with self._client.stream("GET", url, headers={"User-Agent": USER_AGENT, "Accept": accept, "Accept-Language": "en"}) as resp:
                        if resp.status_code in {301, 302, 303, 307, 308} and follow:
                            location = resp.headers.get("location", "")
                            if not location:
                                raise FetchError("the site sent a redirect without a destination")
                            redirects.append(url)
                            url = str(httpx.URL(url).join(location))
                            continue
                        body = bytearray()
                        truncated = False
                        async for chunk in resp.aiter_bytes():
                            body.extend(chunk)
                            if len(body) > max_bytes:
                                truncated = True
                                del body[max_bytes:]
                                break
                        result = Fetched(
                            url=url,
                            status=resp.status_code,
                            headers=list(resp.headers.multi_items()),
                            body=bytes(body),
                            truncated=truncated,
                            tls=_tls_info(resp) if url.startswith("https:") else None,
                            redirects=redirects,
                            elapsed_ms=int((time.monotonic() - started) * 1000),
                        )
                except PolicyError as exc:
                    raise FetchError(f"refused by the network policy: {exc}") from exc
                except httpx.ConnectError as exc:
                    cause = exc.__cause__ or exc.__context__
                    if isinstance(cause, ssl.SSLError) or "CERTIFICATE" in str(exc).upper():
                        raise TlsProblem("the site's TLS certificate was not accepted (expired, for another name, or not trusted)") from exc
                    raise FetchError("could not connect to the site") from exc
                except httpx.TimeoutException as exc:
                    raise FetchError("the site took too long to answer") from exc
                except httpx.HTTPError as exc:
                    raise FetchError(f"could not read the site ({exc.__class__.__name__})") from exc
            await asyncio.sleep(self._delay)
            return result
        raise FetchError("too many redirects")

    async def robots(self, origin: str) -> Robots:
        """Reads robots.txt. A missing file (4xx) allows everything, a server error disallows everything, as RFC 9309 says."""
        try:
            r = await self.get(origin.rstrip("/") + "/robots.txt", max_bytes=100_000, site_host=httpx.URL(origin).host, accept="text/plain,*/*;q=0.5")
        except TlsProblem:
            raise
        except FetchError:
            return Robots(status=0)
        if 500 <= r.status < 600:
            return Robots(status=r.status, disallow_all=True)
        if r.status != 200 or r.is_html:
            return Robots(status=r.status)
        text = r.text
        parser = RobotFileParser()
        parser.parse(text.splitlines())
        sitemaps = [line.split(":", 1)[1].strip() for line in text.splitlines() if line.lower().startswith("sitemap:")][:5]
        return Robots(status=200, parser=parser, text=text, sitemaps=sitemaps)
