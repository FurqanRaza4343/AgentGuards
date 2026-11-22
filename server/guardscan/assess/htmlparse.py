"""A forgiving HTML reader built on the standard library. It never runs scripts and never follows a link.

It collects only what the checks need: the head metadata, headings, images, links, scripts, forms, inline script text,
comments, and the text a person can see (separately from text that is hidden with the `hidden` attribute or inline CSS).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit

MAX_HTML = 400_000  # characters of one page that are parsed
MAX_DEPTH = 400  # open elements that are tracked at once
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}
SKIP_TEXT = {"script", "style", "noscript", "template", "head", "title", "svg"}
HIDDEN_STYLE = re.compile(r"(?i)display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?:px|em|rem|%)?\s*(?:;|$)|opacity\s*:\s*0(?:\.0+)?\s*(?:;|$)|(?:left|top|text-indent)\s*:\s*-\d{3,}px|height\s*:\s*0(?:px)?\s*;[^\"]*overflow\s*:\s*hidden")
GENERIC_LINK_TEXT = {"click here", "here", "read more", "more", "learn more", "link", "this", "click", "details"}
INPUT_NEEDS_LABEL = {"text", "email", "password", "search", "tel", "url", "number", "date", "file", "", "textarea", "select"}


@dataclass
class Link:
    href: str
    text: str
    rel: str = ""


@dataclass
class Script:
    src: str | None
    integrity: bool
    inline: str = ""


@dataclass
class Form:
    action: str
    method: str
    inputs: list[tuple[str, str]] = field(default_factory=list)  # (type, name)

    @property
    def has_password(self) -> bool:
        return any(t == "password" for t, _ in self.inputs)


@dataclass
class PageData:
    url: str
    title: str = ""
    lang: str = ""
    meta: dict[str, str] = field(default_factory=dict)
    canonical: str = ""
    headings: list[tuple[int, str]] = field(default_factory=list)
    images: list[tuple[str, str | None]] = field(default_factory=list)  # (src, alt or None if the attribute is missing)
    links: list[Link] = field(default_factory=list)
    scripts: list[Script] = field(default_factory=list)
    stylesheets: list[str] = field(default_factory=list)
    iframes: list[str] = field(default_factory=list)
    forms: list[Form] = field(default_factory=list)
    comments: list[str] = field(default_factory=list)
    visible_text: str = ""
    hidden_text: list[str] = field(default_factory=list)
    inputs_without_label: int = 0
    controls_without_name: int = 0  # buttons and links with no text, label or alt
    jsonld: bool = False
    favicon: bool = False

    @property
    def words(self) -> int:
        return len(self.visible_text.split())


class _Reader(HTMLParser):
    def __init__(self, url: str) -> None:
        super().__init__(convert_charrefs=True)
        self.page = PageData(url=url)
        self._stack: list[tuple[str, bool]] = []  # (tag, hidden)
        self._text: list[str] = []
        self._hidden: list[str] = []
        self._title = False
        self._title_buf: list[str] = []
        self._script: Script | None = None
        self._script_buf: list[str] = []
        self._heading: tuple[int, list[str]] | None = None
        self._link: tuple[Link, list[str], bool] | None = None  # (link, text parts, has accessible name)
        self._button: tuple[list[str], bool] | None = None
        self._labels_for: set[str] = set()
        self._label_depth = 0
        self._form: Form | None = None
        self._inputs: list[tuple[str, str, bool, bool]] = []  # (type, id, labelled by attribute, inside a label)

    # ---- helpers
    def _is_hidden(self) -> bool:
        return any(h for _, h in self._stack)

    def handle_comment(self, data: str) -> None:
        self.page.comments.append(data.strip()[:600])

    def handle_starttag(self, tag: str, attrs_list: list[tuple[str, str | None]]) -> None:
        a = {k.lower(): (v or "") for k, v in attrs_list}
        p = self.page
        if tag == "html":
            p.lang = a.get("lang", "")
        elif tag == "title":
            self._title = True
        elif tag == "meta":
            key = (a.get("name") or a.get("property") or a.get("http-equiv") or "").lower()
            if key and "content" in a:
                p.meta.setdefault(key, a["content"])
            elif "charset" in a:
                p.meta.setdefault("charset", a["charset"])
        elif tag == "link":
            rel = a.get("rel", "").lower()
            href = a.get("href", "")
            if "canonical" in rel:
                p.canonical = href
            if "icon" in rel:
                p.favicon = True
            if "stylesheet" in rel and href:
                p.stylesheets.append(urljoin(p.url, href))
        elif tag == "script":
            self._script = Script(src=urljoin(p.url, a["src"]) if a.get("src") else None, integrity=bool(a.get("integrity")))
            self._script_buf = []
            if a.get("type", "").lower() == "application/ld+json":
                p.jsonld = True
        elif tag == "img":
            src = a.get("src", "")
            p.images.append((urljoin(p.url, src) if src else "", a.get("alt") if "alt" in a else None))
            if self._link is not None and (a.get("alt") or "").strip():
                self._link = (self._link[0], self._link[1], True)
        elif tag == "iframe" and a.get("src"):
            p.iframes.append(urljoin(p.url, a["src"]))
        elif tag == "form":
            self._form = Form(action=urljoin(p.url, a.get("action", "")) if a.get("action") else p.url, method=(a.get("method") or "get").lower())
            p.forms.append(self._form)
        elif tag in {"input", "textarea", "select"}:
            kind = (a.get("type") or ("textarea" if tag == "textarea" else "select" if tag == "select" else "text")).lower()
            if self._form is not None:
                self._form.inputs.append((kind, a.get("name", "")))
            if kind in INPUT_NEEDS_LABEL and kind != "hidden":
                named = bool(a.get("aria-label") or a.get("aria-labelledby") or a.get("title"))
                self._inputs.append((kind, a.get("id", ""), named, self._label_depth > 0))
            if kind in {"submit", "button"} and not (a.get("value") or a.get("aria-label") or a.get("title")):
                p.controls_without_name += 1
        elif tag == "label":
            self._label_depth += 1
            if a.get("for"):
                self._labels_for.add(a["for"])
        elif tag == "a":
            href = a.get("href", "")
            self._link = (Link(href=urljoin(p.url, href) if href and not href.startswith(("#", "javascript:", "mailto:", "tel:")) else href, text="", rel=a.get("rel", "")), [], bool(a.get("aria-label") or a.get("title")))
        elif tag == "button":
            self._button = ([], bool(a.get("aria-label") or a.get("title")))
        elif tag in {"h1", "h2", "h3", "h4", "h5", "h6"}:
            self._heading = (int(tag[1]), [])

        if tag in VOID or len(self._stack) >= MAX_DEPTH:
            return  # a page nested thousands of levels deep is not a page: stop tracking, keep reading
        style = a.get("style", "")
        hidden = "hidden" in a or bool(HIDDEN_STYLE.search(style[:500]))
        self._stack.append((tag, hidden))

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        if tag not in VOID and self._stack and self._stack[-1][0] == tag:
            self._stack.pop()

    def handle_endtag(self, tag: str) -> None:
        p = self.page
        if tag == "title":
            self._title = False
            p.title = " ".join("".join(self._title_buf).split())[:300]
        elif tag == "script" and self._script is not None:
            self._script.inline = "".join(self._script_buf)[:6000] if not self._script.src else ""
            p.scripts.append(self._script)
            self._script = None
        elif tag == "label":
            self._label_depth = max(0, self._label_depth - 1)
        elif tag == "form":
            self._form = None
        elif tag == "a" and self._link is not None:
            link, parts, named = self._link
            link.text = " ".join("".join(parts).split())[:160]
            p.links.append(link)
            if not link.text and not named and link.href and not link.href.startswith("#"):
                p.controls_without_name += 1
            self._link = None
        elif tag == "button" and self._button is not None:
            parts, named = self._button
            if not "".join(parts).strip() and not named:
                p.controls_without_name += 1
            self._button = None
        elif self._heading is not None and tag == f"h{self._heading[0]}":
            text = " ".join("".join(self._heading[1]).split())
            p.headings.append((self._heading[0], text[:200]))
            self._heading = None
        # close the nearest open element of this name
        for i in range(len(self._stack) - 1, -1, -1):
            if self._stack[i][0] == tag:
                del self._stack[i:]
                break

    def handle_data(self, data: str) -> None:
        if self._title:
            self._title_buf.append(data)
        if self._script is not None:
            self._script_buf.append(data)
            return
        top_tags = {t for t, _ in self._stack}
        if top_tags & SKIP_TEXT:
            return
        if self._link is not None:
            self._link[1].append(data)
        if self._button is not None:
            self._button[0].append(data)
        if self._heading is not None:
            self._heading[1].append(data)
        text = data.strip()
        if not text:
            return
        (self._hidden if self._is_hidden() else self._text).append(text)


def parse_html(html: str, url: str) -> PageData:
    reader = _Reader(url)
    try:
        reader.feed(html[:MAX_HTML])
        reader.close()
    except Exception:  # a page that breaks the parser still gets what was read so far
        pass
    p = reader.page
    p.visible_text = " ".join(reader._text)[:60_000]  # noqa: SLF001
    p.hidden_text = [t[:300] for t in reader._hidden][:40]  # noqa: SLF001
    p.inputs_without_label = sum(1 for _kind, iid, named, inside in reader._inputs if not (named or inside or (iid and iid in reader._labels_for)))  # noqa: SLF001
    return p


def host_of(url: str) -> str:
    return (urlsplit(url).hostname or "").lower()
