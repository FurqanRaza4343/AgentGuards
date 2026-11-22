"""The Content specialist for a website: does a visitor, a search engine and a screen reader understand the pages?

Every check reads the pages that the Scraper already fetched. Nothing here touches the network.
"""

from __future__ import annotations

from ..tools.web import Fetched
from .book import FindingBook
from .htmlparse import GENERIC_LINK_TEXT, PageData


def check_page_basics(fetched: Fetched, page: PageData, book: FindingBook, *, is_home: bool) -> None:
    loc = page.url
    title = page.title.strip()
    if not title:
        book.add("seo.title.missing", "seo", "high" if is_home else "medium", "The page has no title",
                 "The title is the headline in search results and in browser tabs. Without it, search engines make one up and visitors cannot tell tabs apart.",
                 "Add a `<title>` of 30 to 60 characters that says what the page is and who it is for.", evidence="<title> is empty or missing", location=loc)
    elif len(title) > 65 or len(title) < 10:
        book.add("seo.title.length", "seo", "low", "The page title is too " + ("long" if len(title) > 65 else "short"),
                 "Search results cut titles at about 60 characters. Very short titles waste the most visible line you have.",
                 "Aim for 30 to 60 characters, with the most important words first.", evidence=f"“{title[:90]}” ({len(title)} characters)", location=loc)

    desc = page.meta.get("description", "").strip()
    if not desc:
        book.add("seo.description.missing", "seo", "medium" if is_home else "low", "The page has no description",
                 "The description is the grey text under the title in search results. Without one, a search engine picks random text from the page.",
                 "Add `<meta name=\"description\" content=\"...\">` of 70 to 160 characters that makes someone want to click.", evidence="meta description: (not set)", location=loc)
    elif len(desc) < 50 or len(desc) > 170:
        book.add("seo.description.length", "seo", "low", "The page description is the wrong length",
                 "Search results show about 155 characters. Much shorter says too little, much longer is cut off.", "Rewrite it to 70 to 160 characters.", evidence=f"{desc[:100]} ({len(desc)} characters)", location=loc)

    h1s = [t for lvl, t in page.headings if lvl == 1]
    if not h1s:
        book.add("seo.h1.missing", "seo", "medium" if is_home else "low", "The page has no main heading",
                 "A single H1 tells visitors, screen readers and search engines what the page is about.", "Add one `<h1>` that states the page's purpose in plain words.", evidence="No <h1> found", location=loc)
    elif len(h1s) > 1:
        book.add("seo.h1.multiple", "accessibility", "low", f"The page has {len(h1s)} main headings",
                 "Several H1s blur what the page is about, for people using screen readers most of all.", "Keep one H1 and make the others H2 or lower.", evidence="; ".join(h1s[:3])[:150], location=loc)

    levels = [lvl for lvl, _ in page.headings]
    if any(b - a > 1 for a, b in zip(levels, levels[1:])):
        book.add("a11y.heading-order", "accessibility", "low", "Headings skip levels",
                 "Screen reader users jump between headings. A jump from H2 to H4 makes the outline confusing.", "Do not skip levels: H1, then H2, then H3.", evidence="Heading levels: " + " ".join(f"h{n}" for n in levels[:12]), location=loc)

    if not page.lang:
        book.add("a11y.lang.missing", "accessibility", "low", "The page does not say which language it is in",
                 "Screen readers pick a voice and pronunciation from the `lang` attribute, and translators use it too.", "Add `lang=\"en\"` (or your language) to the `<html>` tag.", evidence="<html> has no lang", location=loc)

    if "viewport" not in page.meta:
        book.add("seo.viewport.missing", "seo", "medium" if is_home else "low", "The page is not set up for phones",
                 "Without a viewport tag, phones show a tiny zoomed-out desktop page. Search engines rank mobile-friendly pages higher.", "Add `<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">`.", evidence="meta viewport: (not set)", location=loc)

    robots_meta = page.meta.get("robots", "").lower()
    if "noindex" in robots_meta:
        book.add("seo.noindex", "seo", "high" if is_home else "info", "The page asks search engines not to list it",
                 "A noindex rule removes the page from search results. That is right for private pages and a costly mistake on a public one (it often survives from a test version).", "Remove `noindex` if this page should be found.", evidence=f"robots: {robots_meta[:60]}", location=loc)

    missing_alt = [src for src, alt in page.images if alt is None and src]
    if missing_alt:
        book.add("a11y.img-alt", "accessibility", "medium" if len(missing_alt) > 3 else "low", f"{len(missing_alt)} image{'s' if len(missing_alt) != 1 else ''} without a text description",
                 "People who cannot see the image (and search engines) rely on the alt text. Decorative images should have an empty `alt=\"\"`.", "Describe what each image shows in a few words.", evidence=", ".join(s[-60:] for s in missing_alt[:2]), location=loc)

    if page.inputs_without_label:
        book.add("a11y.form-label", "accessibility", "medium", f"{page.inputs_without_label} form field{'s' if page.inputs_without_label != 1 else ''} without a label",
                 "A placeholder disappears when you type and is not read as a label by every screen reader, so people do not know what a field is for.", "Give each field a `<label for=...>`.", evidence=f"{page.inputs_without_label} unlabeled inputs", location=loc)

    vague = [lk.text for lk in page.links if lk.text.strip().lower().rstrip(".!") in GENERIC_LINK_TEXT]
    if len(vague) >= 2:
        book.add("a11y.link-text", "accessibility", "low", "Links say “click here” or “read more”",
                 "Screen reader users often list all links on a page. A list of “read more, read more” says nothing, and search engines use link text to understand the target.", "Make link text say where it goes: “Read the pricing guide”.", evidence=", ".join(sorted(set(vague))[:3]), location=loc)

    if page.controls_without_name:
        book.add("a11y.control-name", "accessibility", "medium", f"{page.controls_without_name} button or link with no name",
                 "An icon-only button with no text or aria-label is announced as just “button”, so a screen reader user cannot tell what it does.", "Add visible text or an `aria-label`.", evidence=f"{page.controls_without_name} unnamed controls", location=loc)

    if is_home:
        if page.words < 150:
            book.add("content.thin", "content", "medium", "The home page says very little",
                     f"Only about {page.words} words of text were found. Visitors and search engines need enough words to learn what you offer, for whom and why you.",
                     "Write a clear first screen: what you do, who it is for, and one next step. Aim for a few hundred words overall.", evidence=f"{page.words} words", location=loc)
        if not page.meta.get("og:title") and not page.meta.get("og:image"):
            book.add("seo.social-preview", "seo", "low", "Shared links have no preview card",
                     "Without Open Graph tags, a link to the page looks bare when it is shared on social networks and messaging apps.", "Add `og:title`, `og:description` and `og:image` meta tags.", evidence="og:* tags: (not set)", location=loc)
        if not page.favicon:
            book.add("seo.favicon", "seo", "info", "No site icon", "A site icon makes the tab and bookmarks recognisable.", "Add `<link rel=\"icon\" href=\"/favicon.ico\">`.", evidence="rel=icon: (not set)", location=loc)
        if not page.jsonld:
            book.add("seo.structured-data", "seo", "info", "No structured data",
                     "Structured data (schema.org JSON-LD) tells search engines who you are, so they can show richer results.", "Add an Organization or Person block as `application/ld+json`.", evidence="ld+json: (not set)", location=loc)
        if len(fetched.body) > 400_000 or len(page.scripts) > 20:
            book.add("content.weight", "content", "low", "The home page is heavy",
                     f"The HTML alone is {len(fetched.body) // 1024} KB with {len(page.scripts)} scripts. Heavy pages load slowly on phones, and slow pages lose visitors.", "Remove what is not needed, defer the rest.", evidence=f"{len(fetched.body) // 1024} KB, {len(page.scripts)} scripts", location=loc)
