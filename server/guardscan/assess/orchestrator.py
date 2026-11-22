"""The Orchestrator. Nova plans the work, three specialists do it at the same time, and Nova turns the results into questions.

    Nova (orchestrator)  reads the request, sends one task to each specialist, collects what they found, writes the questions.
    Scraper / Reader     data:        fetches the pages (site) or parses the pasted profile.
    Security / Privacy   purchasing:  headers, cookies, certificate and page source (site) or private details (profile).
    Content / Impact     finance:     titles, headings, accessibility (site) or how the profile reads (profile).

The specialists run concurrently and hand work to each other through futures (the Security specialist waits for the home
page, the Content specialist waits for all the pages), so the order of the log is the real order of events.
Every log line says who speaks, who receives (the browser flies a message between the two robots), and what state the
speaker is in, so the 3D stage can show what is happening. Passive, polite, read-only.
"""

from __future__ import annotations

import asyncio
import re
from collections.abc import AsyncIterator, Callable
from contextlib import suppress
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urldefrag, urlsplit

from ..guard.budget import Budget, BudgetExceeded, KillSwitch, Limits
from ..schemas import LogLine
from ..tools.github import FetchError
from ..tools.web import Fetched, Robots, TlsProblem, WebFetcher, parse_site_input, same_site
from . import profile as prof
from .book import FindingBook
from .htmlparse import PageData, host_of, parse_html
from .models import AFinding, AgentSummary, AssessReport, AssessStats, SearchInfo
from .nova import Brief, Nova, NovaUnavailable, NullNova, fallback, prepare_untrusted, verify
from .search import SearchUnavailable, SearxClient
from .site_content import check_page_basics
from .site_security import check_headers, check_pages, check_robots, check_security_txt, check_transport

Event = tuple[str, dict[str, Any]]
RANK = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}
MAX_PAGES = 6
SKIP_EXT = (".pdf", ".zip", ".gz", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".css", ".js", ".mp4", ".mp3", ".xml", ".ico", ".woff", ".woff2", ".exe", ".dmg", ".json", ".txt")
STATE_CHANGING = re.compile(r"(?i)(logout|log-out|signout|sign-out|delete|remove|unsubscribe|checkout|cart|add-to|callback|oauth|admin|wp-login|download)")
PRIORITY = ["about", "contact", "pricing", "product", "service", "privacy", "blog", "login", "signin", "signup", "team", "careers"]

SITE_DISCLAIMERS = [
    "Passive checks only: a few ordinary page requests, robots.txt obeyed, nothing submitted, no hidden paths tried and no scripts run.",
    "AgentGuard cannot prove who owns a site, so every finding explains what and why without steps to attack it. If you find a real problem on a site that is not yours, tell its owner privately.",
    "The checks are heuristics. A clean report does not prove that a site is safe or that its pages are good.",
]
PROFILE_DISCLAIMERS = [
    "This is the text you pasted. Nothing was fetched from LinkedIn or any other site, and nothing was stored.",
    "Contact details are replaced before any excerpt is sent to a language model. Suggestions are starting points: never claim results or skills that are not yours.",
    "The checks are general guidance, not hiring advice. A different reader may weigh things differently.",
]


class AssessError(Exception):
    """The analysis could not run. The message is safe to show."""


@dataclass
class AssessServices:
    make_fetcher: Callable[[], WebFetcher] = WebFetcher
    search: SearxClient | None = None
    nova: Nova = field(default_factory=NullNova)
    kill: KillSwitch = field(default_factory=KillSwitch)
    limits: Limits = field(default_factory=Limits)
    pace: float = 0.0  # seconds between the visible steps of a profile run, so a fast local run can still be followed


class Hub:
    """Collects the events from the concurrent specialists in the order they happen."""

    def __init__(self) -> None:
        self.q: asyncio.Queue[Event | None] = asyncio.Queue()
        self.trail: list[dict[str, Any]] = []

    def log(self, text: str, tone: str | None = None, frm: str | None = None, to: str | None = None, state: str | None = None, task: str | None = None) -> None:
        line: dict[str, Any] = {"text": text}
        for k, v in (("tone", tone), ("from", frm), ("to", to), ("state", state), ("task", task)):
            if v is not None:
                line[k] = v
        self.trail.append(line)
        self.q.put_nowait(("log", line))

    def put(self, kind: str, data: dict[str, Any]) -> None:
        self.q.put_nowait((kind, data))

    def close(self) -> None:
        self.q.put_nowait(None)


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


def _sorted(findings: list[AFinding]) -> list[AFinding]:
    return sorted(findings, key=lambda f: (RANK[f.severity], f.area, f.id))


def _summary(agent: str, role: str, task: str, book: FindingBook, text: str) -> AgentSummary:
    return AgentSummary(id=agent, role=role, task=task, summary=text, findingIds=book.ids)  # type: ignore[arg-type]


def choose_links(page: PageData, host: str, robots: Robots, limit: int = MAX_PAGES - 1) -> list[str]:
    """Pages worth reading: the same site, plain page addresses, not state-changing, allowed by robots.txt, most useful first."""
    seen: set[str] = {urldefrag(page.url)[0].rstrip("/")}
    cands: list[tuple[int, int, str]] = []
    for i, link in enumerate(page.links):
        href = urldefrag(link.href)[0]
        parts = urlsplit(href)
        if parts.scheme not in {"http", "https"} or not same_site(parts.hostname or "", host):
            continue
        path = parts.path or "/"
        if path.lower().endswith(SKIP_EXT) or STATE_CHANGING.search(path) or len(href) > 300:
            continue
        key = href.rstrip("/")
        if key in seen or not robots.allows(href):
            continue
        seen.add(key)
        score = next((n for n, w in enumerate(PRIORITY) if w in path.lower()), len(PRIORITY))
        cands.append((score, i, href))
    cands.sort()
    return [h for _, _, h in cands[:limit]]


def brand_of(title: str, host: str) -> str:
    for part in re.split(r"\s[|–—:•·-]\s", title):
        part = part.strip()
        if 3 <= len(part) <= 60:
            return part
    labels = [x for x in host.split(".") if x and x != "www"]
    if len(labels) >= 3 and labels[-2] in {"co", "com", "org", "net", "gov", "edu", "ac"} and len(labels[-1]) == 2:
        return labels[-3]  # shop.co.uk -> shop
    return labels[-2] if len(labels) >= 2 else (labels[0] if labels else host)


# ====================================================================== website

class _SiteRun:
    def __init__(self, hub: Hub, web: WebFetcher, svc: AssessServices, budget: Budget, start: str) -> None:
        self.hub, self.web, self.svc, self.budget, self.start = hub, web, svc, budget, start
        parts = urlsplit(start)
        self.host = (parts.hostname or "").lower()
        self.origin = f"{parts.scheme}://{parts.netloc}"
        loop = asyncio.get_running_loop()
        self.robots_f: asyncio.Future[Robots | None] = loop.create_future()
        self.home_f: asyncio.Future[Fetched | None] = loop.create_future()
        self.pages_f: asyncio.Future[list[tuple[Fetched, PageData]]] = loop.create_future()
        self.books = {"data": FindingBook("data"), "purchasing": FindingBook("purchasing"), "finance": FindingBook("finance")}
        self.sitemap_status: int | None = None
        self.tls_problem: str | None = None
        self.search_info = SearchInfo(used=False, note="No search server is configured, so the discoverability check was skipped.")
        self.summaries: dict[str, AgentSummary] = {}
        self.stats = AssessStats()

    def _release(self) -> None:
        for f, v in ((self.robots_f, None), (self.home_f, None), (self.pages_f, [])):
            if not f.done():
                f.set_result(v)  # type: ignore[arg-type]

    # ---- Scraper (data)
    async def scraper(self) -> None:
        h, book = self.hub, self.books["data"]
        try:
            h.log("Scraper: reading robots.txt first, to see what the site allows", "tool", "data", state="working", task="Reading robots.txt")
            try:
                robots = await self.web.robots(self.origin)
            except TlsProblem as exc:
                self.tls_problem = str(exc)
                h.log("Scraper: the site's security certificate was not accepted, so no page can be read.", "bad", "data", "nova", state="fail", task="Certificate not accepted")
                self.summaries["data"] = _summary("data", "Scraper", "Read the pages", book, "The certificate was not accepted, so no page could be read.")
                return
            self.robots_f.set_result(robots)
            if not robots.allows(self.start):
                h.log("Scraper: robots.txt asks automated tools not to read this page, so the Scraper stops here.", "warn", "data", "nova", state="fail", task="Blocked by robots.txt")
                raise AssessError(f"robots.txt on {self.host} asks automated tools not to read this page, so AgentGuard did not.")
            note = {200: "found", 0: "not reachable"}.get(robots.status, f"answered {robots.status}")
            h.log(f"Scraper: robots.txt {note}. Reading the home page.", "info", "data", state="working", task="Reading the home page")
            try:
                home = await self.web.get(self.start, site_host=self.host)
            except TlsProblem as exc:
                self.tls_problem = str(exc)
                h.log("Scraper: the site's security certificate was not accepted, so no page can be read.", "bad", "data", "nova", state="fail", task="Certificate not accepted")
                self.summaries["data"] = _summary("data", "Scraper", "Read the pages", book, "The certificate was not accepted, so no page could be read.")
                return
            except FetchError as exc:
                raise AssessError(str(exc)) from exc
            if home.status >= 400:
                raise AssessError(f"The site answered {home.status} for its home page, so there was nothing to read.")
            if not home.is_html:
                raise AssessError("That address did not return a web page (it was not HTML).")
            page = await asyncio.to_thread(parse_html, home.text, home.url)  # in a thread: a hostile page must not stall other requests
            self.home_f.set_result(home)
            kb = max(1, len(home.body) // 1024)
            h.log(f"Scraper: home page {home.status}, {kb} KB, {_plural(len(page.links), 'link')}, {page.words} words. Passing the headers to Security.", "good", "data", "purchasing", state="working", task="Reading linked pages")
            pages: list[tuple[Fetched, PageData]] = [(home, page)]
            candidates = choose_links(page, self.host, robots)
            broken: list[str] = []
            for i, url in enumerate(candidates, 1):
                self.budget.check_time()
                path = urlsplit(url).path or "/"
                try:
                    r = await self.web.get(url, site_host=self.host)
                except FetchError as exc:
                    h.log(f"Scraper: {path} could not be read ({exc})", "warn", "data", state="working", task=f"Reading page {i + 1} of {len(candidates) + 1}")
                    broken.append(path)
                    continue
                if r.status >= 400:
                    broken.append(f"{path} ({r.status})")
                    h.log(f"Scraper: {path} answered {r.status}", "warn", "data", state="working", task=f"Reading page {i + 1} of {len(candidates) + 1}")
                    continue
                if not r.is_html:
                    continue
                pages.append((r, await asyncio.to_thread(parse_html, r.text, r.url)))
                h.log(f"Scraper: {path} {r.status}, {max(1, len(r.body) // 1024)} KB", "info", "data", state="working", task=f"Reading page {i + 1} of {len(candidates) + 1}")
            # a sitemap tells search engines which pages exist
            try:
                sm = await self.web.get(robots.sitemaps[0] if robots.sitemaps and same_site(host_of(robots.sitemaps[0]), self.host) else f"{self.origin}/sitemap.xml", max_bytes=50_000, site_host=self.host, accept="application/xml,text/xml,*/*;q=0.5")
                self.sitemap_status = sm.status
            except FetchError:
                self.sitemap_status = None
            if broken:
                book.add("content.broken-links", "content", "medium", f"{_plural(len(broken), 'page')} linked from the home page did not load",
                         "Visitors and search engines who follow these links land on an error. Broken links make a site look abandoned.",
                         "Fix or remove the links, or redirect the old addresses to the right pages.", evidence=", ".join(broken[:4]), location=self.start)
            self.stats = AssessStats(pages=len(pages), bytes=sum(len(f.body) for f, _ in pages), words=sum(p.words for _, p in pages))
            self.pages_f.set_result(pages)
            h.log(f"Scraper: {_plural(len(pages), 'page')} read. Handing the pages to Content and Security.", "good", "data", "finance", state="working", task="Handing over the pages")
            h.log(f"Scraper: done. {_plural(len(book.items), 'finding')} of its own (links). Sending them to Nova.", "good", "data", "nova", state="success", task="Done")
            self.summaries["data"] = _summary("data", "Scraper", "Read the pages", book, f"Read {_plural(len(pages), 'page')} ({self.stats.words} words) and checked links.")
        except AssessError:
            raise
        except asyncio.CancelledError:
            raise
        except Exception:
            h.log("Scraper: something went wrong while reading the site.", "bad", "data", "nova", state="fail", task="Failed")
            raise AssessError("The pages could not be read.")
        finally:
            self._release()

    # ---- Security (purchasing)
    async def security(self) -> None:
        h, book = self.hub, self.books["purchasing"]
        try:
            h.log("Security: waiting for the home page, then reading its headers, cookies and certificate.", "info", "purchasing", state="thinking", task="Waiting for the home page")
            home = await self.home_f
            h.log("Security: checking headers, cookies and the certificate", "tool", "purchasing", state="working", task="Checking headers and cookies")
            if home is not None:
                check_headers(home, book)
            probe = None
            if self.start.startswith("https:") and home is not None:
                try:
                    probe = await self.web.get(f"http://{self.host}/", follow=False, max_bytes=20_000, site_host=self.host)
                except FetchError:
                    probe = None  # port 80 closed: nothing to redirect
            check_transport(home, probe, self.tls_problem, book, self.host)
            if home is not None:
                h.log("Security: looking for a security.txt and reading what robots.txt reveals", "tool", "purchasing", state="working", task="Checking security.txt")
                try:
                    sec = await self.web.get(f"{self.origin}/.well-known/security.txt", max_bytes=20_000, site_host=self.host, accept="text/plain,*/*;q=0.5")
                    check_security_txt(sec.status, book, self.host)
                except FetchError:
                    pass
                robots = await self.robots_f
                if robots is not None:
                    check_robots(robots, book, self.host)
            h.log("Security: waiting for the Scraper's pages to check forms, scripts and page source", "info", "purchasing", state="thinking", task="Waiting for the pages")
            pages = await self.pages_f
            if pages:
                h.log(f"Security: checking forms, scripts and source on {_plural(len(pages), 'page')}", "tool", "purchasing", state="working", task="Checking forms and source")
                await asyncio.to_thread(check_pages, pages, book, self.host)
            real = [f for f in book.items if f.severity != "info"]
            worst = min((RANK[f.severity] for f in book.items), default=9)
            h.log(f"Security: done. {_plural(len(book.items), 'finding')}. Sending them to Nova.", "warn" if worst <= 1 else "good", "purchasing", "nova", state="alert" if worst <= 1 else "success", task="Done")
            self.summaries["purchasing"] = _summary("purchasing", "Security", "Check security", book, f"{_plural(len(real), 'issue')} to fix" + (f", {_plural(len(book.strengths), 'thing')} already done well" if book.strengths else "") + ".")
        except asyncio.CancelledError:
            raise
        except Exception:
            h.log("Security: a check failed, so its results are partial.", "warn", "purchasing", "nova", state="fail", task="Partial results")
            self.summaries["purchasing"] = _summary("purchasing", "Security", "Check security", book, "Some checks could not run.")

    # ---- Content (finance)
    async def content(self) -> None:
        h, book = self.hub, self.books["finance"]
        try:
            h.log("Content: waiting for the Scraper's pages.", "info", "finance", state="thinking", task="Waiting for the pages")
            pages = await self.pages_f
            if not pages:
                h.log("Content: there were no pages to read.", "warn", "finance", "nova", state="fail", task="No pages")
                self.summaries["finance"] = _summary("finance", "Content", "Review the content", book, "There were no pages to read.")
                return
            h.log(f"Content: reviewing titles, headings, images, forms and links on {_plural(len(pages), 'page')}", "tool", "finance", state="working", task="Reviewing the pages")
            def review() -> None:
                for i, (fetched, page) in enumerate(pages):
                    check_page_basics(fetched, page, book, is_home=(i == 0))

            await asyncio.to_thread(review)
            robots = await self.robots_f
            if self.sitemap_status in {404, 410} and not (robots and robots.sitemaps):
                book.add("seo.sitemap.missing", "seo", "low", "No sitemap", "A sitemap lists the pages you want search engines to find. Small sites can be found without one, bigger sites need it.",
                         "Publish /sitemap.xml and add a `Sitemap:` line to robots.txt.", evidence="/sitemap.xml: 404", location=f"{self.origin}/sitemap.xml")
            await self._brand_search(pages[0][1], book)
            real = [f for f in book.items if f.severity != "info"]
            h.log(f"Content: done. {_plural(len(book.items), 'finding')}. Sending them to Nova.", "good", "finance", "nova", state="success", task="Done")
            self.summaries["finance"] = _summary("finance", "Content", "Review the content", book, f"{_plural(len(real), 'improvement')} for search, phones and accessibility.")
        except asyncio.CancelledError:
            raise
        except Exception:
            h.log("Content: a check failed, so its results are partial.", "warn", "finance", "nova", state="fail", task="Partial results")
            self.summaries["finance"] = _summary("finance", "Content", "Review the content", book, "Some checks could not run.")

    async def _brand_search(self, home: PageData, book: FindingBook) -> None:
        if self.svc.search is None:
            return
        brand = brand_of(home.title, self.host)
        self.hub.log(f"Content: asking the search engine what it shows for “{brand}” (only the name leaves this server)", "tool", "finance", state="working", task="Searching the web")
        try:
            results = await self.svc.search.search(brand, 10)
        except SearchUnavailable as exc:
            self.search_info = SearchInfo(used=False, note=f"The search server was not used: {exc}.", queries=[])
            self.hub.log(f"Content: search was not available ({exc})", "warn", "finance")
            return
        self.search_info = SearchInfo(used=True, note=f"Searched for the site's name and found {len(results)} results.", queries=[brand])
        if len(results) < 4:
            return
        pos = next((i for i, r in enumerate(results, 1) if same_site(r.host, self.host)), None)
        if pos is None:
            book.add("discoverability.brand", "discoverability", "medium", f"Searching for “{brand}” does not show your site in the first results",
                     "If people search for your name and do not find you, you lose visitors who already want you. The search engine used here may differ from Google, so treat this as a prompt to check.",
                     "Make sure the title and main heading contain your name, add structured data, and get the site listed in your profiles and directories.", evidence=f"{len(results)} results, none from {self.host}", location="Web search")
        else:
            book.good(f"Searching for “{brand}” shows your site as result {pos}")


async def _site(hub: Hub, url_text: str, svc: AssessServices, budget: Budget) -> AssessReport:
    hub.log("Nova: reading the address and planning the work", "info", "nova", state="thinking", task="Planning")
    try:
        start = parse_site_input(url_text)
    except FetchError as exc:
        raise AssessError(str(exc)) from exc
    host = (urlsplit(start).hostname or "").lower()
    hub.log(f"Nova: {host} is a public website. Passive checks only: ordinary page requests, robots.txt obeyed, nothing submitted.", "good", "nova", state="working", task="Orchestrating")
    async with svc.make_fetcher() as web:
        run = _SiteRun(hub, web, svc, budget, start)
        hub.log("Nova → Scraper: read the home page and the pages it links to (at most six, robots.txt allowing)", "tool", "nova", "data")
        hub.log("Nova → Security: check headers, cookies, certificate, security.txt, and the source of every page", "tool", "nova", "purchasing")
        hub.log("Nova → Content: review titles, headings, images, forms, links and search visibility", "tool", "nova", "finance")
        tasks = [asyncio.create_task(run.scraper()), asyncio.create_task(run.security()), asyncio.create_task(run.content())]
        try:
            await asyncio.gather(*tasks)
        except BaseException:
            for t in tasks:
                t.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            raise
        pages = run.pages_f.result() if run.pages_f.done() else []
    findings = _sorted([f for b in run.books.values() for f in b.items])
    strengths = [s for b in run.books.values() for s in b.strengths]
    if pages:
        home = pages[0][1]
        text = " ".join(home.visible_text.split())[:1500]
        headings = "; ".join(t for _, t in home.headings[:8])
        raw = f"Title: {home.title}\nDescription: {home.meta.get('description', '')}\nHeadings: {headings}\nText: {text}"
        facts = prepare_untrusted(raw, host, 3200)
        corpus = raw
    else:
        facts, corpus = "(no page content was read)", ""
    brief = Brief(kind="site", target=host, role="", facts=facts, corpus=corpus, findings=findings, strengths=strengths)
    questions, improvements, used = await _nova_step(hub, svc, budget, brief)
    agents = [AgentSummary(id="nova", role="Orchestrator", task="Plan, delegate, ask", summary=f"{_plural(len(questions), 'question')} and {_plural(len(improvements), 'improvement')}" + (" written with Gemini." if used else " written from templates."), findingIds=[])]
    agents += [run.summaries[k] for k in ("data", "purchasing", "finance") if k in run.summaries]
    hub.log("Done. The report is ready.", "good")
    return AssessReport(
        kind="site", target=host, generatedAt=_now(), stats=run.stats, agents=agents, findings=findings, strengths=list(dict.fromkeys(strengths)),
        questions=questions, improvements=improvements, search=run.search_info, model=used,
        runLog=[LogLine.model_validate(line) for line in hub.trail], disclaimers=SITE_DISCLAIMERS,
    )


# ====================================================================== profile

class _ProfileRun:
    def __init__(self, hub: Hub, svc: AssessServices, budget: Budget, text: str, role: str) -> None:
        self.hub, self.svc, self.budget, self.text, self.role = hub, svc, budget, text, role
        self.profile_f: asyncio.Future[prof.Profile | None] = asyncio.get_running_loop().create_future()
        self.books = {"data": FindingBook("data"), "purchasing": FindingBook("purchasing"), "finance": FindingBook("finance")}
        self.summaries: dict[str, AgentSummary] = {}
        self.search_info = SearchInfo(used=False, note="No target role was given, so the keyword comparison with job pages was skipped." if not role else "No search server is configured, so the keyword comparison was skipped.")

    async def _pace(self) -> None:
        if self.svc.pace:
            await asyncio.sleep(self.svc.pace)

    async def reader(self) -> None:
        h, book = self.hub, self.books["data"]
        try:
            h.log("Reader: reading the pasted text and finding its sections", "tool", "data", state="working", task="Reading your text")
            await self._pace()
            p = prof.parse_profile(self.text)
            self.profile_f.set_result(p)
            found = ", ".join(p.sections) or "no clear sections"
            h.log(f"Reader: {p.words} words. Sections found: {found}." + (f" Headline: “{p.headline[:70]}”" if p.headline else " No headline found."), "good", "data", "purchasing", state="working", task="Checking structure")
            await self._pace()
            prof.reader_checks(p, book)
            h.log(f"Reader: done. {_plural(len(book.items), 'finding')}. Sending them to Nova.", "good", "data", "nova", state="success", task="Done")
            self.summaries["data"] = _summary("data", "Reader", "Read the profile", book, f"Found {len(p.sections)} sections and {len(book.items)} things to complete.")
        finally:
            if not self.profile_f.done():
                self.profile_f.set_result(None)

    async def privacy(self) -> None:
        h, book = self.hub, self.books["purchasing"]
        try:
            h.log("Privacy: waiting for the Reader to split the text.", "info", "purchasing", state="thinking", task="Waiting for the Reader")
            p = await self.profile_f
            if p is None:
                return
            h.log("Privacy: looking for phone numbers, emails, ID numbers, addresses and shortened links", "tool", "purchasing", state="working", task="Looking for private details")
            await self._pace()
            prof.privacy_checks(p, book)
            h.log("Privacy: looking for secrets and text written for AI screening tools", "tool", "purchasing", state="working", task="Checking for hidden text")
            await self._pace()
            worst = min((RANK[f.severity] for f in book.items), default=9)
            h.log(f"Privacy: done. {_plural(len(book.items), 'finding')}. Sending them to Nova.", "warn" if worst <= 1 else "good", "purchasing", "nova", state="alert" if worst <= 1 else "success", task="Done")
            self.summaries["purchasing"] = _summary("purchasing", "Privacy", "Protect the person", book, f"{_plural(len([f for f in book.items if f.severity != 'info']), 'issue')} to fix." if book.items else "Nothing private is exposed.")
        except asyncio.CancelledError:
            raise
        except Exception:
            h.log("Privacy: a check failed, so its results are partial.", "warn", "purchasing", "nova", state="fail", task="Partial results")

    async def impact(self) -> None:
        h, book = self.hub, self.books["finance"]
        try:
            h.log("Impact: waiting for the Reader to split the text.", "info", "finance", state="thinking", task="Waiting for the Reader")
            p = await self.profile_f
            if p is None:
                return
            h.log("Impact: reading the headline, About and experience for clarity, numbers and buzzwords", "tool", "finance", state="working", task="Reading for impact")
            await self._pace()
            prof.impact_checks(p, book)
            if self.role and self.svc.search is not None:
                queries = [f"{self.role} job requirements skills", f"{self.role} required skills job description"]
                h.log(f"Impact: asking the search engine what hiring pages for “{self.role}” ask for (only the role leaves this server)", "tool", "finance", state="working", task="Searching job pages")
                snippets: list[str] = []
                try:
                    for q in queries:
                        snippets += [f"{r.title}. {r.snippet}" for r in await self.svc.search.search(q, 20)]
                    ranked = prof.keyword_gap_counts(self.text, snippets)
                    gap = [w for w, _ in ranked]
                    prof.keyword_findings(self.role, gap, book, dict(ranked), len(snippets))
                    self.search_info = SearchInfo(used=True, note=f"Compared the profile with {len(snippets)} search results for the role.", queries=queries)
                    h.log(f"Impact: {len(snippets)} results read. " + (f"{_plural(len(gap), 'skill')} that several of them mention {'is' if len(gap) == 1 else 'are'} not in the profile." if gap else "No skill that several of them mention is missing from the profile."), "good" if not gap else "warn", "finance")
                except SearchUnavailable as exc:
                    self.search_info = SearchInfo(used=False, note=f"The search server was not used: {exc}.", queries=[])
                    h.log(f"Impact: search was not available ({exc})", "warn", "finance")
            elif self.role:
                h.log("Impact: no search server is configured, so the keyword comparison is skipped.", "info", "finance")
            else:
                h.log("Impact: no target role was given, so the keyword comparison is skipped.", "info", "finance")
            h.log(f"Impact: done. {_plural(len(book.items), 'finding')}. Sending them to Nova.", "good", "finance", "nova", state="success", task="Done")
            self.summaries["finance"] = _summary("finance", "Impact", "Sharpen the writing", book, f"{_plural(len([f for f in book.items if f.severity != 'info']), 'improvement')} to how it reads.")
        except asyncio.CancelledError:
            raise
        except Exception:
            h.log("Impact: a check failed, so its results are partial.", "warn", "finance", "nova", state="fail", task="Partial results")


async def _profile(hub: Hub, text: str, role: str | None, svc: AssessServices, budget: Budget) -> AssessReport:
    hub.log("Nova: reading what you pasted and planning the work", "info", "nova", state="thinking", task="Planning")
    try:
        clean = prof.clean_input(text)
    except prof.ProfileError as exc:
        raise AssessError(str(exc)) from exc
    target_role = prof.clean_role(role)
    hub.log("Nova: this is text you pasted yourself. Nothing is fetched from LinkedIn or any other site.", "good", "nova", state="working", task="Orchestrating")
    run = _ProfileRun(hub, svc, budget, clean, target_role)
    hub.log("Nova → Reader: split the text into headline, About, experience and skills, and see what is missing", "tool", "nova", "data")
    hub.log("Nova → Privacy: look for private details, secrets and text aimed at AI screening tools", "tool", "nova", "purchasing")
    hub.log("Nova → Impact: judge how it reads, and compare with what hiring pages ask for" + (f" (“{target_role}”)" if target_role else ""), "tool", "nova", "finance")
    tasks = [asyncio.create_task(run.reader()), asyncio.create_task(run.privacy()), asyncio.create_task(run.impact())]
    try:
        await asyncio.gather(*tasks)
    except BaseException:
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        raise
    findings = _sorted([f for b in run.books.values() for f in b.items])
    strengths = [s for b in run.books.values() for s in b.strengths]
    p = run.profile_f.result()
    facts_raw = f"Headline: {p.headline if p else ''}\nAbout:\n{(p.about if p else '')[:1500]}\nExperience:\n{(p.experience if p else '')[:1800]}\nSkills: {', '.join(p.skills[:25]) if p else ''}"
    facts = prepare_untrusted(prof.redact_for_model(facts_raw), "profile", 4200)
    brief = Brief(kind="profile", target="a professional profile", role=target_role, facts=facts, corpus=clean, findings=findings, strengths=strengths)
    questions, improvements, used = await _nova_step(hub, svc, budget, brief)
    agents = [AgentSummary(id="nova", role="Orchestrator", task="Plan, delegate, ask", summary=f"{_plural(len(questions), 'question')} and {_plural(len(improvements), 'improvement')}" + (" written with Gemini." if used else " written from templates."), findingIds=[])]
    agents += [run.summaries[k] for k in ("data", "purchasing", "finance") if k in run.summaries]
    hub.log("Done. The report is ready.", "good")
    return AssessReport(
        kind="profile", target="Pasted profile" + (f" · {target_role}" if target_role else ""), generatedAt=_now(),
        stats=AssessStats(pages=0, bytes=len(clean.encode("utf-8")), words=len(clean.split())), agents=agents, findings=findings,
        strengths=list(dict.fromkeys(strengths)), questions=questions, improvements=improvements, search=run.search_info, model=used,
        runLog=[LogLine.model_validate(line) for line in hub.trail], disclaimers=PROFILE_DISCLAIMERS,
    )


# ====================================================================== Nova writes the questions

async def _nova_step(hub: Hub, svc: AssessServices, budget: Budget, brief: Brief):  # type: ignore[no-untyped-def]
    hub.log(f"Nova: collecting {_plural(len(brief.findings), 'finding')} from the three specialists and writing questions", "info", "nova", state="thinking", task="Writing questions")
    used = False
    questions: list = []
    improvements: list = []
    try:
        batch = await svc.nova.write(brief, budget)
        questions, improvements = verify(batch, brief.findings, brief.corpus)
        if len(questions) < 3:
            raise NovaUnavailable("the model's answer did not pass the checks")
        used = True
        kept = f"{len(questions)} of {len(batch.questions)} questions and {len(improvements)} of {len(batch.improvements)} rewrites passed the checks"
        hub.log(f"Nova: Gemini wrote the questions. {kept}; anything that quoted text not on the page, or contained links or code, was dropped.", "good", "nova")
    except NovaUnavailable as exc:
        hub.log(f"Nova: no model this time ({exc}). The questions come from templates.", "info", "nova")
    except BudgetExceeded as exc:
        hub.log(f"Nova: stopped ({exc}). The questions come from templates.", "info", "nova")
    except Exception:  # a model or network failure must never lose the analysis
        hub.log("Nova: the model failed. The questions come from templates.", "warn", "nova")
    if not used:
        questions, improvements = fallback(brief.kind, brief.findings)
    hub.log(f"Nova: {_plural(len(questions), 'question')} and {_plural(len(improvements), 'improvement')} are ready.", "good", "nova", state="success", task="Done")
    return questions, improvements, used


# ====================================================================== entry point

async def assess(kind: str, payload: dict[str, Any], svc: AssessServices) -> AsyncIterator[Event]:
    """Runs an analysis and yields ("log", line) events, then ("report", report) or ("error", {"message": ...})."""
    hub = Hub()
    budget = Budget(svc.limits)

    async def main() -> None:
        try:
            async with asyncio.timeout(svc.limits.max_seconds):  # nothing runs longer than the budget, whatever a site does
                if kind == "site":
                    report = await _site(hub, str(payload.get("url", "")), svc, budget)
                elif kind == "profile":
                    report = await _profile(hub, str(payload.get("text", "")), payload.get("role"), svc, budget)
                else:
                    raise AssessError("Unknown kind of analysis.")
            hub.put("report", report.model_dump(by_alias=True, exclude_none=True))
        except TimeoutError:
            hub.put("error", {"message": "The analysis took too long and was stopped."})
        except AssessError as exc:
            hub.put("error", {"message": str(exc)})
        except BudgetExceeded as exc:
            hub.put("error", {"message": f"The analysis stopped: {exc}."})
        except asyncio.CancelledError:
            raise
        except Exception:
            hub.put("error", {"message": "The analysis failed unexpectedly. Nothing was stored."})
        finally:
            hub.close()

    task = asyncio.create_task(main())
    try:
        while (event := await hub.q.get()) is not None:
            yield event
    finally:
        task.cancel()
        with suppress(asyncio.CancelledError, Exception):
            await task
