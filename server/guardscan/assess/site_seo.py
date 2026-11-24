"""Search-engine checks for a website that need more than one page: robots.txt, sitemap.xml, canonical addresses, duplicate titles.

Nothing here touches the network: the Scraper fetched the files and this module only reads them. Everything in a file that
someone else wrote is read with `str.find` and plain splitting, never with a regular expression over the whole file and never
with an XML parser (so a hostile sitemap cannot expand entities or nest a million levels deep). Every list is capped.
"""

from __future__ import annotations

import html
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from urllib.parse import urldefrag, urljoin, urlsplit

from ..tools.web import Fetched, Robots, same_site
from .book import FindingBook
from .htmlparse import PageData, host_of

MAX_URLS = 50_000  # the limit of one sitemap file
MAX_LINES = 3000  # lines of robots.txt that are read
AI_BOTS = (
    "gptbot", "chatgpt-user", "oai-searchbot", "claudebot", "claude-web", "anthropic-ai", "google-extended", "ccbot",
    "perplexitybot", "bytespider", "applebot-extended", "cohere-ai", "meta-externalagent",
)
# folders that a page needs in order to look right. Blocking them keeps a search engine from seeing the page as people do.
ASSET_DIRS = ("/css", "/js", "/assets", "/static", "/_next", "/wp-includes", "/wp-content/themes", "/dist", "/build")
STALE_DAYS = 540


# ------------------------------------------------------------------ robots.txt

@dataclass
class Group:
    agents: list[str] = field(default_factory=list)
    rules: list[tuple[str, str]] = field(default_factory=list)  # ("allow" | "disallow", path)


def parse_groups(text: str) -> list[Group]:
    """The groups of a robots.txt: the agents that a block of rules is for, and the rules. Linear, and capped."""
    groups: list[Group] = []
    cur: Group | None = None
    after_agent = False
    for raw in text.splitlines()[:MAX_LINES]:
        key, sep, value = raw.split("#", 1)[0].strip().partition(":")
        if not sep:
            continue
        key, value = key.strip().lower(), value.strip()[:300]
        if key == "user-agent":
            if cur is None or not after_agent:
                cur = Group()
                groups.append(cur)
            cur.agents.append(value.lower())
            after_agent = True
        elif key in {"allow", "disallow"} and cur is not None:
            cur.rules.append((key, value))
            after_agent = False
        elif key != "sitemap":  # a Sitemap line does not end a group
            after_agent = False
    return groups


def _blocks_everything(group: Group) -> bool:
    disallow = any(k == "disallow" and v in {"/", "/*"} for k, v in group.rules)
    allow = any(k == "allow" and v not in {"", "/"} for k, v in group.rules)
    return disallow and not allow


def blocked_ai_bots(groups: list[Group]) -> list[str]:
    out: list[str] = []
    for g in groups:
        if not _blocks_everything(g):
            continue
        for a in g.agents:
            if a in AI_BOTS and a not in out:
                out.append(a)
    return out


def blocked_asset_dirs(groups: list[Group]) -> list[str]:
    out: list[str] = []
    for g in groups:
        if not any(a in {"*", "googlebot"} for a in g.agents):
            continue
        for kind, path in g.rules:
            if kind != "disallow":
                continue
            p = path.lstrip("*").rstrip("*").split("?", 1)[0]
            for d in ASSET_DIRS:
                if (p == d or p.startswith(d + "/")) and d not in out:
                    out.append(d)
    return out


def robots_checks(robots: Robots, book: FindingBook, origin: str, host: str, sitemap_found: bool) -> None:
    where = f"{origin}/robots.txt"
    if robots.status in {404, 410} or (robots.status not in {0, 200} and not robots.disallow_all):
        book.add("seo.robots.missing", "seo", "low", "The site has no robots.txt",
                 "robots.txt is the first file a search engine asks for. Without it nothing is wrong, but you have nowhere to say which folders to skip or where your sitemap is.",
                 "Add a /robots.txt with `User-agent: *`, the folders to skip (if any) and a `Sitemap:` line.", evidence=f"/robots.txt: {robots.status}", location=where)
        return
    if robots.status != 200 or not robots.text:
        return
    groups = parse_groups(robots.text)
    if not robots.sitemaps and sitemap_found:
        book.add("seo.robots.no-sitemap", "seo", "low", "robots.txt does not point to the sitemap",
                 "The site has a sitemap, but robots.txt does not mention it. Search engines usually find it anyway, but a `Sitemap:` line is the sure way.",
                 "Add `Sitemap: https://your-site/sitemap.xml` to robots.txt.", evidence="no Sitemap: line", location=where)
    assets = blocked_asset_dirs(groups)
    if assets:
        book.add("seo.robots.blocks-assets", "seo", "medium", "robots.txt hides the files that make pages look right",
                 "Search engines draw your page to judge it. If they may not read the stylesheets and scripts, they see a broken page and may rank it lower.",
                 "Remove these `Disallow` lines, or allow the style and script files inside them.", evidence="Disallow: " + ", ".join(assets[:4]), location=where)
    far = [s for s in robots.sitemaps if not same_site(host_of(s), host)]
    if far:
        book.add("seo.robots.sitemap-host", "seo", "low", "A Sitemap line points to another website",
                 "A sitemap only counts for the address it is on. A line that names another site is ignored.",
                 "Point the `Sitemap:` line to a file on this site.", evidence=far[0][:120], location=where)
    ai = blocked_ai_bots(groups)
    if ai:
        book.good("robots.txt says which AI crawlers are not welcome (" + ", ".join(ai[:4]) + ")")
    else:
        book.add("seo.robots.ai-policy", "seo", "info", "robots.txt says nothing about AI crawlers",
                 "Companies that train AI models and AI assistants that answer questions read pages with crawlers of their own, such as GPTBot or ClaudeBot. You can allow or block them in robots.txt. Saying nothing means they follow the general rules.",
                 "Decide, and write it down: for example `User-agent: GPTBot` then `Disallow: /` to keep a bot out. Allowing them is a fine choice too.", evidence="no AI crawler is named", location=where)
    if robots.status == 200 and robots.sitemaps and not assets and not far:
        book.good("robots.txt is present and points to the sitemap")


# ------------------------------------------------------------------ sitemap.xml

@dataclass
class Sitemap:
    url: str
    status: int | None = None  # None: the file could not be fetched at all
    kind: str = "none"  # none | urlset | index | invalid | compressed
    urls: list[str] = field(default_factory=list)
    lastmods: list[date] = field(default_factory=list)
    children: int = 0  # how many sitemaps an index lists
    child_urls: list[str] = field(default_factory=list)  # the first few of them
    truncated: bool = False
    sample_broken: list[str] = field(default_factory=list)  # listed pages that did not load (filled by the Scraper)


def _values(text: str, tag: str, limit: int) -> list[str]:
    """The texts between <tag> and </tag>, in order. A linear scan: no regular expression, no XML parser."""
    open_t, close_t = f"<{tag}>", f"</{tag}>"
    out: list[str] = []
    i = 0
    n = len(text)
    while len(out) < limit:
        a = text.find(open_t, i)
        if a < 0:
            break
        b = text.find(close_t, a + len(open_t))
        if b < 0:
            break
        v = text[a + len(open_t):b].strip()
        if v.startswith("<![CDATA["):
            v = v[9:].removesuffix("]]>").strip()
        out.append(html.unescape(v)[:400])
        i = b + len(close_t)
        if i >= n:
            break
    return out


def _day(s: str) -> date | None:
    s = s.strip()[:10]
    if len(s) == 10 and s[4] == "-" and s[7] == "-" and s[:4].isdigit() and s[5:7].isdigit() and s[8:].isdigit():
        try:
            return date(int(s[:4]), int(s[5:7]), int(s[8:]))
        except ValueError:
            return None
    return None


def read_sitemap(f: Fetched | None, url: str) -> Sitemap:
    sm = Sitemap(url=url)
    if f is None:
        return sm
    sm.status, sm.truncated = f.status, f.truncated
    if f.status != 200:
        return sm
    if urlsplit(url).path.lower().endswith(".gz") or "gzip" in (f.header("content-type") or "").lower():
        sm.kind = "compressed"
        return sm
    text = f.text
    head = text[:4000]
    if "<urlset" in head:
        sm.kind = "urlset"
        sm.urls = _values(text, "loc", MAX_URLS)
        sm.lastmods = [d for d in (_day(x) for x in _values(text, "lastmod", MAX_URLS)) if d]
    elif "<sitemapindex" in head:
        sm.kind = "index"
        locs = _values(text, "loc", 5000)
        sm.children, sm.child_urls = len(locs), locs[:3]
    else:
        sm.kind = "invalid"
    return sm


def merge_child(sm: Sitemap, child: Sitemap) -> None:
    """An index lists sitemaps. The first one is read, so there is something to check; the count of listed sitemaps stays."""
    if child.kind == "urlset":
        sm.urls, sm.lastmods = child.urls, child.lastmods


def page_key(u: str) -> str:
    p = urlsplit(urldefrag(u)[0])
    host = (p.hostname or "").lower().removeprefix("www.")
    return f"{host}{p.path.rstrip('/') or '/'}"


def sitemap_checks(sm: Sitemap, robots: Robots | None, book: FindingBook, origin: str, host: str, home_url: str, today: date | None = None) -> None:
    today = today or datetime.now(timezone.utc).date()
    listed_in_robots = bool(robots and robots.sitemaps)
    where = sm.url or f"{origin}/sitemap.xml"
    if sm.status in {404, 410} or sm.status is None:
        if listed_in_robots:
            book.add("seo.sitemap.broken", "seo", "medium", "robots.txt points to a sitemap that does not load",
                     "The Sitemap line in robots.txt names a file that is not there, so search engines get an error where they expected your page list.",
                     "Publish the sitemap at that address, or fix the Sitemap line.", evidence=f"{where}: {sm.status if sm.status else 'could not be read'}", location=where)
        elif sm.status in {404, 410}:
            book.add("seo.sitemap.missing", "seo", "low", "No sitemap",
                     "A sitemap lists the pages you want search engines to find. Small sites can be found without one, bigger sites need it.",
                     "Publish /sitemap.xml and add a `Sitemap:` line to robots.txt.", evidence="/sitemap.xml: 404", location=where)
        return
    if sm.status != 200:
        book.add("seo.sitemap.broken", "seo", "medium", "The sitemap answers with an error",
                 "Search engines that ask for the sitemap get an error instead of your page list.", "Make the sitemap load, or remove the Sitemap line that points to it.",
                 evidence=f"{where}: {sm.status}", location=where)
        return
    if sm.kind == "compressed":
        return  # a .gz sitemap is fine, and is not unpacked here
    if sm.kind == "invalid":
        book.add("seo.sitemap.invalid", "seo", "medium", "The sitemap is not a sitemap",
                 "The address answers, but what comes back is not sitemap XML (often it is the home page, because the server answers every address with a page). Search engines will ignore it.",
                 "Publish a real sitemap (an XML file that starts with `<urlset>`), or answer a missing file with a 404.", evidence=where, location=where)
        return
    if sm.kind == "index":
        book.good(f"The sitemap is an index of {sm.children} sitemap{'s' if sm.children != 1 else ''}")
    elif not sm.urls:
        book.add("seo.sitemap.empty", "seo", "medium", "The sitemap lists no pages",
                 "A sitemap with no addresses in it helps nobody. It usually means the generator broke.", "Regenerate the sitemap so that it lists your pages.", evidence="0 <loc> entries", location=where)
        return
    if not sm.urls:
        return
    far = [u for u in sm.urls if not same_site(host_of(u), host)]
    if far:
        book.add("seo.sitemap.other-host", "seo", "medium", f"The sitemap lists {len(far)} address{'es' if len(far) != 1 else ''} on another website",
                 "A sitemap may only list pages of its own site. Addresses on other hosts are ignored, and a few can make search engines distrust the whole file.",
                 "Remove them, or put them in the sitemap of the site they belong to.", evidence=far[0][:120], location=where)
    if home_url.startswith("https:"):
        plain = [u for u in sm.urls if u.startswith("http:")]
        if plain:
            book.add("seo.sitemap.http", "seo", "low", f"The sitemap lists {len(plain)} plain http address{'es' if len(plain) != 1 else ''}",
                     "The site is served over https, so listing the http versions sends search engines to a redirect and signals mixed-up addresses.", "List the https address of every page.",
                     evidence=plain[0][:120], location=where)
    if len(sm.urls) >= MAX_URLS and not sm.truncated:
        book.add("seo.sitemap.big", "seo", "low", "The sitemap is at its size limit",
                 "One sitemap may hold 50,000 addresses. Beyond that search engines stop reading.", "Split it into several sitemaps and list them in a sitemap index.", evidence=f"{len(sm.urls)} addresses", location=where)
    home_key = page_key(home_url)
    if len(sm.urls) < 500 and not sm.truncated and home_key not in {page_key(u) for u in sm.urls}:
        book.add("seo.sitemap.home-missing", "seo", "info", "The home page is not in the sitemap",
                 "The home page is the page you most want found. It is usually first in the list.", "Add the home page address to the sitemap.", evidence=f"{len(sm.urls)} addresses, none is {home_url}", location=where)
    newest = max(sm.lastmods) if sm.lastmods else None
    if newest is not None and (today - newest).days > STALE_DAYS:
        book.add("seo.sitemap.stale", "seo", "low", "The sitemap has not changed for a long time",
                 "The newest date in the sitemap is old. Either nothing was published since, or the file is not being kept up to date, and search engines then crawl you less often.",
                 "Generate the sitemap automatically when you publish, and fill `<lastmod>` with the real date.", evidence=f"newest lastmod: {newest.isoformat()} ({(today - newest).days} days ago)", location=where)
    elif newest is not None:
        book.good(f"The sitemap lists {len(sm.urls)} page{'s' if len(sm.urls) != 1 else ''}, the newest changed on {newest.isoformat()}")
    else:
        book.good(f"The sitemap lists {len(sm.urls)} page{'s' if len(sm.urls) != 1 else ''}")
    if sm.sample_broken:
        book.add("seo.sitemap.broken-urls", "seo", "medium", "The sitemap lists pages that do not load",
                 "A few addresses from the sitemap were opened as a spot check, and some answered with an error. Search engines waste visits on them and lose trust in the list.",
                 "Remove the dead addresses from the sitemap, or make the pages work.", evidence=", ".join(sm.sample_broken[:3]), location=where)


def sample_urls(sm: Sitemap, host: str, already: set[str], allowed: Callable[[str], bool], limit: int = 3) -> list[str]:
    """Up to `limit` pages of the sitemap to open as a spot check: same site, allowed by robots.txt, not read yet, spread over the list."""
    pool = [u for u in sm.urls[:5000] if u.startswith(("http://", "https://")) and same_site(host_of(u), host) and len(u) < 300 and page_key(u) not in already and allowed(u)]
    if len(pool) <= limit:
        return pool
    step = (len(pool) - 1) / max(1, limit - 1)
    return [pool[round(i * step)] for i in range(limit)]


# ------------------------------------------------------------------ across the pages that were read

def page_set_checks(pages: list[tuple[Fetched, PageData]], book: FindingBook, host: str) -> None:
    by_title: dict[str, list[str]] = {}
    by_desc: dict[str, list[str]] = {}
    for fetched, page in pages:
        path = urlsplit(page.url).path or "/"
        if page.title.strip():
            by_title.setdefault(page.title.strip().lower(), []).append(path)
        d = page.meta.get("description", "").strip().lower()
        if len(d) >= 20:
            by_desc.setdefault(d, []).append(path)
        tag = (fetched.header("x-robots-tag") or "").lower()
        if "noindex" in tag:
            is_home = page is pages[0][1]
            book.add("seo.x-robots-noindex", "seo", "high" if is_home else "info", "A response header asks search engines not to list the page",
                     "An `X-Robots-Tag: noindex` header removes the page from search results, and it is easy to miss because it is not in the page. It often survives from a test version.",
                     "Remove the header if this page should be found.", evidence=f"X-Robots-Tag: {tag[:60]}", location=page.url)
        if page.canonical:
            target = urljoin(page.url, page.canonical)
            if urlsplit(target).hostname and not same_site(urlsplit(target).hostname or "", host):
                book.add("seo.canonical.other-host", "seo", "medium", "The canonical address belongs to another website",
                         "The canonical tag tells search engines which address is the real one. Pointing it at another site hands your page's ranking to that site.",
                         "Point the canonical tag at this page's own address.", evidence=f"canonical: {target[:120]}", location=page.url)
    for label, group, rule in (("title", by_title, "seo.title.duplicate"), ("description", by_desc, "seo.description.duplicate")):
        dup = [(k, v) for k, v in group.items() if len(v) > 1]
        if dup:
            k, v = dup[0]
            book.add(rule, "seo", "low", f"Several pages share the same {label}",
                     f"Search results show the {label} of each page. When pages have the same one, people (and search engines) cannot tell them apart.",
                     f"Give every page its own {label} that says what is on that page.", evidence=f"“{k[:70]}” on {', '.join(v[:3])}", location=page_url_of(pages, v[0]))
    home = pages[0][1] if pages else None
    if home is not None:
        if not home.canonical:
            book.add("seo.canonical.missing", "seo", "low", "The home page has no canonical address",
                     "Without a canonical tag, the same page reached as `www` or without, or with a tracking parameter, can be counted as several pages.",
                     "Add `<link rel=\"canonical\" href=\"https://your-site/\">` to the head.", evidence="rel=canonical: (not set)", location=home.url)
        if home.meta.get("og:title") and not home.meta.get("og:image"):
            book.add("seo.og.incomplete", "seo", "low", "The share preview has no picture",
                     "A link to the page is shared with a title but no image, and posts with a picture get noticed far more.", "Add an `og:image` of about 1200 by 630 pixels.", evidence="og:image: (not set)", location=home.url)


def page_url_of(pages: list[tuple[Fetched, PageData]], path: str) -> str:
    return next((p.url for _, p in pages if (urlsplit(p.url).path or "/") == path), pages[0][1].url if pages else "")


# ------------------------------------------------------------------ the facts that the scorecard shows when a check passes

def site_facts(pages: list[tuple[Fetched, PageData]], robots: Robots | None, sm: Sitemap | None, https: bool) -> dict[str, str]:
    out: dict[str, str] = {}
    if https:
        out["https"] = "The site is served over https"
    if robots is not None and robots.status == 200:
        n = len(robots.disallowed_paths)
        out["robots"] = f"Found. {n} folder{'s' if n != 1 else ''} skipped" + (", sitemap listed" if robots.sitemaps else ", no sitemap line")
    if sm is not None and sm.kind in {"urlset", "index"}:
        if sm.kind == "index":
            out["sitemap"] = f"An index of {sm.children} sitemap{'s' if sm.children != 1 else ''}"
        elif sm.urls:
            newest = f", newest {max(sm.lastmods).isoformat()}" if sm.lastmods else ""
            out["sitemap"] = f"{len(sm.urls)} page{'s' if len(sm.urls) != 1 else ''} listed{newest}"
    if pages:
        home = pages[0][1]
        if home.title.strip():
            out["title"] = f"“{home.title.strip()[:60]}” ({len(home.title.strip())} characters)"
        d = home.meta.get("description", "").strip()
        if d:
            out["description"] = f"{len(d)} characters"
        h1 = [t for lvl, t in home.headings if lvl == 1]
        if len(h1) == 1:
            out["h1"] = f"“{h1[0][:60]}”"
        if "viewport" in home.meta:
            out["viewport"] = "Set for phones"
        if home.canonical:
            out["canonical"] = urljoin(home.url, home.canonical)[:80]
        if "og:title" in home.meta or "og:image" in home.meta:
            out["social"] = "Open Graph tags are set"
        if home.jsonld:
            out["structured"] = "JSON-LD found"
        if home.images:
            with_alt = sum(1 for _, alt in home.images if alt is not None)
            out["alt"] = f"{with_alt} of {len(home.images)} images described"
        if home.lang:
            out["lang"] = f"lang=“{home.lang[:10]}”"
        out["depth"] = f"About {home.words} words on the home page"
        out["indexable"] = "Pages may be listed by search engines"
        out["links"] = f"{len(pages)} page{'s' if len(pages) != 1 else ''} read, none broken"
    return out
