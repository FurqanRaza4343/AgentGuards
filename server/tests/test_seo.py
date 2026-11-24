"""Search-engine checks: robots.txt, the sitemap, canonical addresses and duplicate titles, and a whole run on the planted site."""

from __future__ import annotations

import time
from datetime import date

import pytest

from guardscan.assess.book import FindingBook
from guardscan.assess.htmlparse import parse_html
from guardscan.assess.orchestrator import AssessServices, assess
from guardscan.assess.site_seo import (
    Sitemap,
    blocked_ai_bots,
    blocked_asset_dirs,
    merge_child,
    page_set_checks,
    parse_groups,
    read_sitemap,
    robots_checks,
    sample_urls,
    site_facts,
    sitemap_checks,
)
from guardscan.demo_site import mock_client_factory
from guardscan.tools.web import Fetched, Robots, WebFetcher

ORIGIN = "https://shop.example"
HOST = "shop.example"
TODAY = date(2026, 11, 22)


def book() -> FindingBook:
    return FindingBook("finance")


def rules(b: FindingBook) -> set[str]:
    return {f.rule for f in b.items}


def robots_of(text: str, status: int = 200) -> Robots:
    sitemaps = [ln.split(":", 1)[1].strip() for ln in text.splitlines() if ln.lower().startswith("sitemap:")]
    return Robots(status=status, text=text, sitemaps=sitemaps)


def xml(body: str, url: str = f"{ORIGIN}/sitemap.xml", status: int = 200, truncated: bool = False) -> Fetched:
    return Fetched(url=url, status=status, headers=[("Content-Type", "application/xml")], body=body.encode(), truncated=truncated)


def urlset(*entries: str) -> str:
    items = "".join(f"<url><loc>{e}</loc></url>" if "<lastmod>" not in e else f"<url>{e}</url>" for e in entries)
    return f'<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">{items}</urlset>'


# ------------------------------------------------------------------ robots.txt

def test_groups_follow_the_user_agent_lines() -> None:
    g = parse_groups("User-agent: GPTBot\nUser-agent: CCBot\nDisallow: /\n\n# a comment\nUser-agent: *\nDisallow: /tmp/ # why\nSitemap: https://a.example/s.xml\nAllow: /tmp/ok\n")
    assert [x.agents for x in g] == [["gptbot", "ccbot"], ["*"]]
    assert g[1].rules == [("disallow", "/tmp/"), ("allow", "/tmp/ok")]  # a Sitemap line does not end the group
    assert blocked_ai_bots(g) == ["gptbot", "ccbot"]


def test_an_ai_bot_that_is_allowed_somewhere_is_not_called_blocked() -> None:
    g = parse_groups("User-agent: GPTBot\nDisallow: /\nAllow: /blog/\n")
    assert blocked_ai_bots(g) == []


def test_blocked_style_folders_are_found_for_everyone_and_for_google() -> None:
    g = parse_groups("User-agent: *\nDisallow: /wp-includes/\nDisallow: /private\n\nUser-agent: Googlebot\nDisallow: /assets/*\n\nUser-agent: Bingbot\nDisallow: /css/\n")
    assert blocked_asset_dirs(g) == ["/wp-includes", "/assets"]  # Bingbot's own group is not the general rule


def test_a_missing_robots_file_is_a_small_finding_and_a_good_one_is_a_strength() -> None:
    b = book()
    robots_checks(Robots(status=404), b, ORIGIN, HOST, sitemap_found=False)
    assert rules(b) == {"seo.robots.missing"} and next(iter(b.items)).severity == "low"
    ok = book()
    robots_checks(robots_of(f"User-agent: *\nDisallow: /admin/\nUser-agent: GPTBot\nDisallow: /\nSitemap: {ORIGIN}/sitemap.xml\n"), ok, ORIGIN, HOST, sitemap_found=True)
    assert ok.items == [] and any("AI crawlers" in s for s in ok.strengths) and any("points to the sitemap" in s for s in ok.strengths)


def test_robots_findings_for_a_site_with_a_sitemap_it_never_mentions() -> None:
    b = book()
    robots_checks(robots_of("User-agent: *\nDisallow: /js/\nSitemap: https://elsewhere.example/s.xml\n"), b, ORIGIN, HOST, sitemap_found=True)
    assert {"seo.robots.blocks-assets", "seo.robots.sitemap-host", "seo.robots.ai-policy"} <= rules(b)
    assert "seo.robots.no-sitemap" not in rules(b)  # a Sitemap line exists, it is only on another host
    b2 = book()
    robots_checks(robots_of("User-agent: *\nDisallow: /admin/\n"), b2, ORIGIN, HOST, sitemap_found=True)
    assert "seo.robots.no-sitemap" in rules(b2)
    b3 = book()
    robots_checks(robots_of("User-agent: *\nDisallow: /admin/\n"), b3, ORIGIN, HOST, sitemap_found=False)
    assert "seo.robots.no-sitemap" not in rules(b3)  # nothing to point to


def test_an_unreachable_robots_file_says_nothing() -> None:
    b = book()
    robots_checks(Robots(status=0), b, ORIGIN, HOST, sitemap_found=False)
    assert b.items == []


# ------------------------------------------------------------------ the sitemap

def test_a_urlset_is_read_with_its_dates_and_cdata() -> None:
    sm = read_sitemap(xml(urlset(f"{ORIGIN}/", f"<![CDATA[{ORIGIN}/a?x=1&amp;y=2]]>", f"{ORIGIN}/b</loc><lastmod>2026-10-02</lastmod><loc>")), f"{ORIGIN}/sitemap.xml")
    assert sm.kind == "urlset" and sm.urls[0] == f"{ORIGIN}/" and sm.urls[1] == f"{ORIGIN}/a?x=1&y=2"
    assert sm.lastmods == [date(2026, 10, 2)]


def test_an_index_counts_its_children_and_the_first_is_read() -> None:
    idx = '<sitemapindex xmlns="x"><sitemap><loc>https://shop.example/s1.xml</loc></sitemap><sitemap><loc>https://shop.example/s2.xml</loc></sitemap></sitemapindex>'
    sm = read_sitemap(xml(idx), f"{ORIGIN}/sitemap.xml")
    assert sm.kind == "index" and sm.children == 2 and sm.child_urls[0].endswith("/s1.xml")
    merge_child(sm, read_sitemap(xml(urlset(f"{ORIGIN}/a", f"{ORIGIN}/b")), f"{ORIGIN}/s1.xml"))
    assert len(sm.urls) == 2
    b = book()
    sitemap_checks(sm, robots_of(f"Sitemap: {ORIGIN}/sitemap.xml"), b, ORIGIN, HOST, f"{ORIGIN}/", TODAY)
    assert any("index of 2" in s for s in b.strengths)


def test_a_page_that_answers_instead_of_a_sitemap_is_called_invalid() -> None:
    sm = read_sitemap(xml("<!doctype html><html><body>Welcome</body></html>"), f"{ORIGIN}/sitemap.xml")
    assert sm.kind == "invalid"
    b = book()
    sitemap_checks(sm, None, b, ORIGIN, HOST, f"{ORIGIN}/", TODAY)
    assert rules(b) == {"seo.sitemap.invalid"}


def test_missing_broken_and_empty_sitemaps() -> None:
    gone = read_sitemap(xml("nope", status=404), f"{ORIGIN}/sitemap.xml")
    b = book()
    sitemap_checks(gone, robots_of("User-agent: *\n"), b, ORIGIN, HOST, f"{ORIGIN}/", TODAY)
    assert rules(b) == {"seo.sitemap.missing"}
    b2 = book()
    sitemap_checks(gone, robots_of(f"Sitemap: {ORIGIN}/sitemap.xml\n"), b2, ORIGIN, HOST, f"{ORIGIN}/", TODAY)
    assert rules(b2) == {"seo.sitemap.broken"}  # robots.txt promises one that is not there
    b3 = book()
    sitemap_checks(read_sitemap(None, f"{ORIGIN}/sitemap.xml"), None, b3, ORIGIN, HOST, f"{ORIGIN}/", TODAY)
    assert b3.items == []  # not reachable at all: nothing is claimed
    b4 = book()
    sitemap_checks(read_sitemap(xml(urlset()), f"{ORIGIN}/sitemap.xml"), None, b4, ORIGIN, HOST, f"{ORIGIN}/", TODAY)
    assert rules(b4) == {"seo.sitemap.empty"}


def test_a_sitemap_with_the_usual_mistakes() -> None:
    old = f"{ORIGIN}/old</loc><lastmod>2023-01-01</lastmod><loc>"
    sm = read_sitemap(xml(urlset(f"{ORIGIN}/a", "https://other.example/x", "http://shop.example/b", old)), f"{ORIGIN}/sitemap.xml")
    sm.sample_broken = ["/gone (404)"]
    b = book()
    sitemap_checks(sm, None, b, ORIGIN, HOST, f"{ORIGIN}/", TODAY)
    assert rules(b) == {"seo.sitemap.other-host", "seo.sitemap.http", "seo.sitemap.home-missing", "seo.sitemap.stale", "seo.sitemap.broken-urls"}
    assert next(f for f in b.items if f.rule == "seo.sitemap.other-host").severity == "medium"


def test_a_healthy_sitemap_has_no_finding_and_says_how_fresh_it_is() -> None:
    sm = read_sitemap(xml(urlset(f"{ORIGIN}/", f"{ORIGIN}/a</loc><lastmod>2026-11-01</lastmod><loc>")), f"{ORIGIN}/sitemap.xml")
    b = book()
    sitemap_checks(sm, robots_of(f"Sitemap: {ORIGIN}/sitemap.xml"), b, ORIGIN, HOST, f"{ORIGIN}/", TODAY)
    assert b.items == [] and any("2026-11-01" in s for s in b.strengths)


def test_the_spot_check_picks_spread_out_pages_that_robots_allows_and_that_were_not_read() -> None:
    sm = Sitemap(url=f"{ORIGIN}/sitemap.xml", kind="urlset", urls=[f"{ORIGIN}/p{i}" for i in range(20)] + ["https://other.example/x", f"{ORIGIN}/private/z"])
    picks = sample_urls(sm, HOST, {"shop.example/p0"}, lambda u: "/private/" not in u)
    assert len(picks) == 3 and "https://other.example/x" not in picks and f"{ORIGIN}/p0" not in picks and f"{ORIGIN}/private/z" not in picks
    assert picks[0] != picks[-1]


def test_a_hostile_sitemap_is_read_in_linear_time() -> None:
    nasty = "<urlset>" + "<url><loc>" * 200_000 + "</urlset>"  # an opening tag that never closes, many times over
    big = "<urlset>" + "<url><loc>https://shop.example/a</loc><lastmod>2026-01-01</lastmod></url>" * 14_000
    for text in (nasty, big, "<urlset>" + "<![CDATA[" * 100_000 + "<loc>x"):
        t = time.monotonic()
        sm = read_sitemap(xml(text, truncated=len(text) > 1_000_000), f"{ORIGIN}/sitemap.xml")
        assert time.monotonic() - t < 3 and len(sm.urls) <= 50_000


# ------------------------------------------------------------------ across the pages

def page(url: str, head: str) -> tuple[Fetched, object]:
    html = f"<!doctype html><html lang='en'><head>{head}</head><body><h1>x</h1></body></html>"
    return Fetched(url=url, status=200, headers=[("Content-Type", "text/html")], body=html.encode()), parse_html(html, url)


def test_duplicate_titles_and_a_canonical_that_points_elsewhere_are_found() -> None:
    pages = [
        page(f"{ORIGIN}/", "<title>Shop</title><meta name='description' content='The best shop in town, with a very long description'>"),
        page(f"{ORIGIN}/a", "<title>Shop</title><link rel='canonical' href='https://rival.example/a'><meta name='description' content='The best shop in town, with a very long description'>"),
    ]
    b = book()
    page_set_checks(pages, b, HOST)  # type: ignore[arg-type]
    assert {"seo.title.duplicate", "seo.description.duplicate", "seo.canonical.other-host", "seo.canonical.missing"} <= rules(b)


def test_a_noindex_header_on_the_home_page_is_high() -> None:
    fetched, p = page(f"{ORIGIN}/", "<title>Shop</title><link rel='canonical' href='/'>")
    fetched.headers.append(("X-Robots-Tag", "noindex, nofollow"))
    b = book()
    page_set_checks([(fetched, p)], b, HOST)  # type: ignore[list-item]
    assert next(f for f in b.items if f.rule == "seo.x-robots-noindex").severity == "high"


def test_a_share_preview_without_a_picture_is_low() -> None:
    _, p = page(f"{ORIGIN}/", "<title>Shop</title><link rel='canonical' href='/'><meta property='og:title' content='Shop'>")
    f = Fetched(url=f"{ORIGIN}/", status=200, headers=[], body=b"")
    b = book()
    page_set_checks([(f, p)], b, HOST)  # type: ignore[list-item]
    assert rules(b) == {"seo.og.incomplete"}


def test_facts_describe_what_passes() -> None:
    fetched, p = page(f"{ORIGIN}/", "<title>Shop for shoes</title><link rel='canonical' href='/'><meta name='viewport' content='width=device-width'><meta name='description' content='Shoes for everyone'>")
    sm = read_sitemap(xml(urlset(f"{ORIGIN}/")), f"{ORIGIN}/sitemap.xml")
    facts = site_facts([(fetched, p)], robots_of("User-agent: *\nDisallow: /a/\nSitemap: x\n"), sm, True)  # type: ignore[list-item]
    assert facts["title"].startswith("“Shop for shoes”") and facts["sitemap"].startswith("1 page listed") and facts["robots"].startswith("Found. 1 folder skipped, sitemap listed")
    assert facts["viewport"] == "Set for phones" and facts["canonical"] == f"{ORIGIN}/" and facts["https"]


# ------------------------------------------------------------------ a whole run on the planted site

async def run_site() -> dict:
    svc = AssessServices(make_fetcher=lambda: WebFetcher(mock_client_factory(), delay=0))
    report = None
    async for event, data in assess("site", {"url": "https://brightside-bakery.example/"}, svc):
        if event == "report":
            report = data
        if event == "error":
            raise AssertionError(data["message"])
    assert report is not None
    return report


@pytest.mark.asyncio
async def test_the_planted_site_shows_its_robots_and_sitemap_problems() -> None:
    report = await run_site()
    found = {f["rule"] for f in report["findings"]}
    assert {"seo.robots.blocks-assets", "seo.robots.ai-policy", "seo.sitemap.other-host", "seo.sitemap.http", "seo.sitemap.stale", "seo.sitemap.broken-urls",
            "seo.title.length", "seo.canonical.missing"} <= found
    assert "seo.sitemap.missing" not in found and "seo.robots.missing" not in found
    assert report["facts"]["robots"].startswith("Found. 3 folders skipped, sitemap listed") and report["facts"]["sitemap"].startswith("7 pages listed, newest 2023-02-01")
    broken = next(f for f in report["findings"] if f["rule"] == "seo.sitemap.broken-urls")
    assert "/old-menu" in broken["evidence"] or "/offers" in broken["evidence"]
    assert any("sitemap" in line["text"].lower() for line in report["runLog"])
