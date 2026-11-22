"""Reading a public website politely: the address rules, redirects, size caps, robots.txt, and the .env reader."""

from __future__ import annotations

import httpx
import pytest

from guardscan import envfile
from guardscan.guard.netpolicy import PolicyError, check_public_url
from guardscan.tools.github import FetchError
from guardscan.tools.web import TlsProblem, WebFetcher, parse_site_input, same_site


def fetcher(handler, delay: float = 0.0) -> WebFetcher:  # type: ignore[no-untyped-def]
    return WebFetcher(lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=False), delay=delay)


# ------------------------------------------------------------------ the address a person types

@pytest.mark.parametrize("text,expected", [
    ("example.com", "https://example.com"),
    ("https://www.example.com/about", "https://www.example.com/about"),
    ("  http://example.org/path?x=1 ", "http://example.org/path?x=1"),
])
def test_parse_site_input_accepts_normal_addresses(text: str, expected: str) -> None:
    assert parse_site_input(text) == expected


@pytest.mark.parametrize("text", [
    "127.0.0.1", "http://169.254.169.254/latest/meta-data", "http://[::1]/", "10.0.0.5", "http://2130706433/",
    "localhost", "http://intranet/", "printer.local", "api.internal", "http://user:pw@example.com/", "example.com:8080",
    "file:///etc/passwd", "ftp://example.com", "http://exa mple.com", "", "a" * 400,
])
def test_parse_site_input_refuses_internal_and_odd_addresses(text: str) -> None:
    with pytest.raises(FetchError):
        parse_site_input(text)


def test_check_public_url_is_only_relaxed_by_the_test_override(monkeypatch: pytest.MonkeyPatch) -> None:
    with pytest.raises(PolicyError):
        check_public_url("http://127.0.0.1:8787/")
    monkeypatch.setenv("AGENTGUARD_ALLOW_PRIVATE_NETWORK", "1")
    assert check_public_url("http://127.0.0.1:8787/").port == 8787


def test_same_site_ignores_a_leading_www() -> None:
    assert same_site("www.example.com", "example.com") and same_site("EXAMPLE.com", "www.example.com")
    assert not same_site("example.com", "example.org") and not same_site("evil-example.com", "example.com")


# ------------------------------------------------------------------ fetching

async def test_a_page_is_read_with_its_headers_and_an_honest_user_agent() -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.headers["user-agent"])
        return httpx.Response(200, headers={"Content-Type": "text/html; charset=utf-8", "Set-Cookie": "a=1"}, content=b"<html><title>x</title></html>")

    async with fetcher(handler) as web:
        r = await web.get("https://example.com/")
    assert r.status == 200 and r.is_html and "<title>x</title>" in r.text and r.header("set-cookie") == "a=1"
    assert seen == [seen[0]] and seen[0].startswith("AgentGuardBot/") and "robots.txt" in seen[0]


async def test_redirects_are_followed_inside_the_same_site_only() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "example.com":
            return httpx.Response(301, headers={"Location": "https://www.example.com/home"})
        return httpx.Response(200, content=b"ok", headers={"Content-Type": "text/html"})

    async with fetcher(handler) as web:
        r = await web.get("https://example.com/", site_host="example.com")
    assert r.url == "https://www.example.com/home" and r.redirects == ["https://example.com/"]

    def away(request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"Location": "https://other-site.example/"})

    async with fetcher(away) as web:
        with pytest.raises(FetchError, match="another address"):
            await web.get("https://example.com/", site_host="example.com")


async def test_a_redirect_to_a_private_address_is_refused() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"Location": "http://169.254.169.254/latest/meta-data/"})

    async with fetcher(handler) as web:
        with pytest.raises(FetchError, match="network policy"):
            await web.get("https://example.com/")


async def test_redirect_loops_stop() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"Location": "https://example.com/again"})

    async with fetcher(handler) as web:
        with pytest.raises(FetchError, match="too many redirects"):
            await web.get("https://example.com/")


async def test_the_body_is_capped_while_it_streams() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"x" * 50_000, headers={"Content-Type": "text/html"})

    async with fetcher(handler) as web:
        r = await web.get("https://example.com/", max_bytes=1000)
    assert r.truncated and len(r.body) == 1000


async def test_a_certificate_problem_is_reported_as_one_not_as_a_crash() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("[SSL: CERTIFICATE_VERIFY_FAILED] certificate has expired")

    async with fetcher(handler) as web:
        with pytest.raises(TlsProblem):
            await web.get("https://example.com/")


async def test_timeouts_and_connection_errors_become_safe_messages() -> None:
    def slow(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("took too long")

    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    async with fetcher(slow) as web:
        with pytest.raises(FetchError, match="too long"):
            await web.get("https://example.com/")
    async with fetcher(down) as web:
        with pytest.raises(FetchError, match="could not connect"):
            await web.get("https://example.com/")


# ------------------------------------------------------------------ robots.txt

def robots_handler(status: int, body: str = ""):  # type: ignore[no-untyped-def]
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, content=body.encode(), headers={"Content-Type": "text/plain"})

    return handler


async def test_robots_rules_are_obeyed_for_our_user_agent() -> None:
    txt = "User-agent: *\nDisallow: /private/\nSitemap: https://example.com/sitemap.xml\n\nUser-agent: AgentGuardBot\nDisallow: /nobots/\n"
    async with fetcher(robots_handler(200, txt)) as web:
        robots = await web.robots("https://example.com")
    assert robots.allows("https://example.com/") and not robots.allows("https://example.com/nobots/page")
    assert robots.sitemaps == ["https://example.com/sitemap.xml"]


async def test_a_missing_robots_file_allows_everything_and_a_server_error_allows_nothing() -> None:
    async with fetcher(robots_handler(404)) as web:
        assert (await web.robots("https://example.com")).allows("https://example.com/anything")
    async with fetcher(robots_handler(503)) as web:
        assert not (await web.robots("https://example.com")).allows("https://example.com/")


async def test_disallowing_everything_for_every_robot_blocks_us() -> None:
    async with fetcher(robots_handler(200, "User-agent: *\nDisallow: /\n")) as web:
        assert not (await web.robots("https://example.com")).allows("https://example.com/")


# ------------------------------------------------------------------ the .env reader

def test_env_parse_handles_quotes_comments_and_export(tmp_path) -> None:  # type: ignore[no-untyped-def]
    values = envfile.parse('# comment\nA=1\nexport B="two words"\nC=\'x\'\n\nbad line\n9X=no\nD=a=b\n')
    assert values == {"A": "1", "B": "two words", "C": "x", "D": "a=b"}


def test_env_load_sets_only_what_is_not_set_and_returns_names_not_values(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:  # type: ignore[no-untyped-def]
    f = tmp_path / ".env"
    f.write_text("AG_TEST_ONE=secret-one\nAG_TEST_TWO=secret-two\nAG_TEST_EMPTY=\n", encoding="utf-8")
    monkeypatch.setenv("AG_TEST_TWO", "already")
    monkeypatch.delenv("AG_TEST_ONE", raising=False)
    names = envfile.load_env(f)
    import os

    assert names == ["AG_TEST_ONE"] and os.environ["AG_TEST_ONE"] == "secret-one" and os.environ["AG_TEST_TWO"] == "already"
    assert "AG_TEST_EMPTY" not in os.environ
    monkeypatch.delenv("AG_TEST_ONE", raising=False)


def test_env_is_found_in_a_parent_folder_and_a_huge_file_is_ignored(tmp_path) -> None:  # type: ignore[no-untyped-def]
    (tmp_path / ".env").write_text("X=1\n", encoding="utf-8")
    deep = tmp_path / "a" / "b"
    deep.mkdir(parents=True)
    assert envfile.find_env(deep) == tmp_path / ".env"
    (tmp_path / ".env").write_text("X=" + "1" * 70_000, encoding="utf-8")
    assert envfile.load_env(tmp_path / ".env") == []


def test_gemini_keys_are_collected_in_order_without_duplicates(monkeypatch: pytest.MonkeyPatch) -> None:
    for n in ("GEMINI_API_KEY", "GEMINI_API_KEY2", "GEMINI_API_KEY3", "GOOGLE_API_KEY"):
        monkeypatch.delenv(n, raising=False)
    monkeypatch.setenv("GEMINI_API_KEY", "k1")
    monkeypatch.setenv("GEMINI_API_KEY2", "k2")
    monkeypatch.setenv("GOOGLE_API_KEY", "k1")
    assert envfile.gemini_keys() == ["k1", "k2"]
