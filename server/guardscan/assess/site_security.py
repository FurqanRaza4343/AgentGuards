"""The Security specialist for a website. Everything here is passive: it looks at what a normal visit already received.

No form is submitted, no hidden path is tried, nothing is sent except ordinary GET requests (see tools/web.py).
Findings say what and why in general terms. They never contain steps to attack a site.
"""

from __future__ import annotations

import re
from urllib.parse import urlsplit

from ..guard.inject import find_injections
from ..guard.mask import mask_line
from ..tools.web import Fetched, Robots, same_site
from .book import FindingBook
from .htmlparse import PageData, host_of
from .textutil import find_emails, find_internal_host, secret_matches, sentences

MAX_SOURCE = 400_000  # characters of one page's source that the checks read

SESSION_NAME = re.compile(r"(?i)(sess|sid|auth|token|jwt|login|account|user)")
CSRF_NAME = re.compile(r"(?i)(csrf|xsrf)")
VERSIONED_BANNER = re.compile(r"\d+\.\d+")
PRIVATE_IP = re.compile(r"\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b")
LEAKY_COMMENT = re.compile(r"(?i)\b(password|passwd|secret|api[_ -]?key|token|credentials?|private key|basic auth)\b")
NOTE_COMMENT = re.compile(r"(?i)\b(todo|fixme|hack|xxx|remove before|debug|staging|test account)\b")
SENSITIVE_ROBOTS = re.compile(r"(?i)/(?:admin|backup|backups|private|internal|staging|dev|old|db|database|\.git|config|secret|wp-admin|phpmyadmin|logs?)\b")


def _cookie_parts(value: str) -> tuple[str, set[str]]:
    parts = [p.strip() for p in value.split(";")]
    name = parts[0].split("=", 1)[0].strip()
    attrs = {p.split("=", 1)[0].strip().lower() for p in parts[1:]}
    samesite = next((p.split("=", 1)[1].strip().lower() for p in parts[1:] if p.lower().startswith("samesite=") and "=" in p), "")
    if samesite:
        attrs.add(f"samesite={samesite}")
    return name, attrs


def check_headers(home: Fetched, book: FindingBook) -> None:
    https = home.url.startswith("https:")
    loc = home.url
    h = home.header

    # ---- transport headers
    hsts = h("strict-transport-security")
    if https:
        if not hsts:
            book.add("web.hsts.missing", "security", "medium", "The site does not tell browsers to always use HTTPS",
                     "Without a Strict-Transport-Security header, a visitor who types the address without https:// can be sent through an unencrypted first request, which is where a network attacker can interfere.",
                     "Send `Strict-Transport-Security: max-age=31536000; includeSubDomains` once every subdomain works over HTTPS.", evidence="Strict-Transport-Security: (not sent)", location=loc)
        else:
            m = re.search(r"max-age=(\d+)", hsts, re.I)
            if m and int(m.group(1)) < 15_552_000:
                book.add("web.hsts.short", "security", "low", "The HTTPS-only setting expires quickly",
                         "The Strict-Transport-Security lifetime is under 180 days, so browsers forget the rule soon after a visit.",
                         "Raise max-age to at least 15552000 (180 days), ideally 31536000.", evidence=f"Strict-Transport-Security: {hsts[:80]}", location=loc)
            else:
                book.good("HSTS is on, so browsers keep using HTTPS")

    # ---- content security policy
    csp = h("content-security-policy")
    if not csp:
        book.add("web.csp.missing", "security", "medium", "No Content-Security-Policy",
                 "A Content-Security-Policy lets the browser refuse scripts and other content that you did not list. Without one, a single injected script can do anything the page can do.",
                 "Start with a report-only policy (`Content-Security-Policy-Report-Only`), list the sources your pages really need, then enforce it.", evidence="Content-Security-Policy: (not sent)", location=loc)
    else:
        book.good("A Content-Security-Policy is set")
        script_src = next((d for d in csp.split(";") if d.strip().lower().startswith("script-src")), None) or next((d for d in csp.split(";") if d.strip().lower().startswith("default-src")), "")
        weak = []
        if "'unsafe-inline'" in script_src and "nonce-" not in script_src and "sha256-" not in script_src and "'strict-dynamic'" not in script_src:
            weak.append("'unsafe-inline'")
        if "'unsafe-eval'" in script_src:
            weak.append("'unsafe-eval'")
        if re.search(r"(^|\s)(\*|https?:|data:)(\s|$)", script_src.strip()):
            weak.append("a wildcard source")
        if weak:
            book.add("web.csp.weak", "security", "low", "The Content-Security-Policy allows risky script sources",
                     f"The policy for scripts allows {', '.join(weak)}, which lets injected script run and removes most of the protection a policy gives.",
                     "Move inline scripts into files or give them a nonce, and list exact script hosts instead of wildcards.", evidence=f"{script_src.strip()[:150]}", location=loc)

    # ---- framing, sniffing, referrer
    if not h("x-frame-options") and not (csp and "frame-ancestors" in csp.lower()):
        book.add("web.framing.missing", "security", "low", "Other sites can put this page in a frame",
                 "Without X-Frame-Options or a frame-ancestors rule, another site can load this page invisibly inside its own and trick visitors into clicking (clickjacking).",
                 "Send `Content-Security-Policy: frame-ancestors 'self'` (or `X-Frame-Options: SAMEORIGIN`).", evidence="X-Frame-Options / frame-ancestors: (not sent)", location=loc)
    if (h("x-content-type-options") or "").lower() != "nosniff":
        book.add("web.nosniff.missing", "security", "low", "Browsers may guess file types",
                 "Without `X-Content-Type-Options: nosniff`, a browser can treat an uploaded or mislabelled file as a script.",
                 "Send `X-Content-Type-Options: nosniff` on every response.", evidence="X-Content-Type-Options: (not sent)", location=loc)
    if not h("referrer-policy"):
        book.add("web.referrer.missing", "privacy", "info", "Full page addresses may be shared with other sites",
                 "With no Referrer-Policy the browser decides how much of the address is sent to other sites when someone follows a link, and addresses can contain private details.",
                 "Send `Referrer-Policy: strict-origin-when-cross-origin`.", evidence="Referrer-Policy: (not sent)", location=loc)

    # ---- software banners
    for name in ("server", "x-powered-by", "x-aspnet-version"):
        v = h(name)
        if v and VERSIONED_BANNER.search(v):
            book.add("web.banner.version", "security", "low", "The server tells everyone its software version",
                     "A header such as Server or X-Powered-By with a version number tells attackers exactly which known weaknesses to try. It does not make the server unsafe by itself.",
                     "Remove the version from the header (for nginx `server_tokens off;`, for Apache `ServerTokens Prod`) and keep the software up to date.", evidence=f"{name}: {v[:80]}", location=loc)
            break

    # ---- cookies
    cookies = [_cookie_parts(v) for v in home.header_all("set-cookie")]
    insecure, nohttp, nosame = [], [], []
    for name, attrs in cookies:
        sess = bool(SESSION_NAME.search(name)) and not CSRF_NAME.search(name)
        if https and "secure" not in attrs:
            insecure.append((name, sess))
        if "httponly" not in attrs and sess:
            nohttp.append(name)
        if not any(a.startswith("samesite=") for a in attrs):
            nosame.append(name)
    if insecure:
        names = ", ".join(n for n, _ in insecure[:5])
        sev = "medium" if any(s for _, s in insecure) else "low"
        book.add("web.cookie.secure", "security", sev, "Cookies can travel over an unencrypted connection",
                 "A cookie without the Secure flag is also sent over plain http. On a network the visitor does not control, that is enough to read or steal it.",
                 "Add the `Secure` attribute to every cookie.", evidence=f"Set-Cookie without Secure: {names}", location=loc)
    if nohttp:
        book.add("web.cookie.httponly", "security", "medium", "Login-style cookies can be read by page scripts",
                 "A cookie that identifies a visitor and lacks HttpOnly can be read by any script on the page, so one injected script can take over the session.",
                 "Add `HttpOnly` to session and login cookies.", evidence=f"Set-Cookie without HttpOnly: {', '.join(nohttp[:5])}", location=loc)
    if nosame and not insecure and not nohttp:
        book.add("web.cookie.samesite", "security", "info", "Cookies do not say when they may be sent from other sites",
                 "Without SameSite, older browsers send the cookie on requests that other sites trigger, which helps cross-site request forgery.",
                 "Add `SameSite=Lax` (or Strict) to cookies.", evidence=f"Set-Cookie without SameSite: {', '.join(nosame[:5])}", location=loc)
    if cookies and not (insecure or nohttp):
        book.good("Cookies are marked Secure and HttpOnly where it matters")

    # ---- cross-origin sharing
    if (h("access-control-allow-origin") or "").strip() == "*" and (h("content-type") or "").lower().startswith("text/html"):
        book.add("web.cors.wildcard", "security", "low", "This page can be read by script from any other website",
                 "`Access-Control-Allow-Origin: *` on a web page (not on a public data feed) lets any site's script read it from a visitor's browser.",
                 "Remove the header from pages, or allow only the origins that need it.", evidence="Access-Control-Allow-Origin: *", location=loc)


def check_transport(home: Fetched | None, http_probe: Fetched | None, tls_problem: str | None, book: FindingBook, host: str) -> None:
    if tls_problem:
        book.add("web.tls.invalid", "security", "critical", "The site's security certificate is not accepted",
                 f"{tls_problem}. Browsers show a full-page warning, most visitors leave, and the connection cannot be trusted.",
                 "Renew or reissue the certificate for exactly this domain (Let's Encrypt is free) and install the full chain.", evidence="TLS handshake failed", location=host)
        return
    tls = home.tls if home is not None else None
    if tls:
        days = tls.get("daysLeft")
        if isinstance(days, int) and days < 0:
            book.add("web.tls.expired", "security", "critical", "The security certificate has expired", "Browsers refuse or warn about expired certificates.", "Renew the certificate now and automate renewal.", evidence=f"Expires {tls.get('expires')}", location=host)
        elif isinstance(days, int) and days < 21:
            book.add("web.tls.expiring", "security", "medium" if days >= 7 else "high", f"The security certificate expires in {days} days",
                     "An expired certificate takes the site offline for visitors with a full-page warning.", "Renew the certificate and set up automatic renewal.", evidence=f"Expires {tls.get('expires')}", location=host)
        elif isinstance(days, int):
            version = tls.get("version", "")
            book.good(f"HTTPS with {version}, certificate valid for {days} more days")
        if str(tls.get("version", "")) in {"TLSv1", "TLSv1.1", "SSLv3"}:
            book.add("web.tls.old", "security", "high", "The site still accepts an old encryption version", "TLS 1.0 and 1.1 are deprecated and have known weaknesses.", "Allow TLS 1.2 and 1.3 only.", evidence=f"Negotiated {tls.get('version')}", location=host)
    if http_probe is not None:
        loc = http_probe.header("location") or ""
        if http_probe.status in {301, 302, 303, 307, 308} and loc.lower().startswith("https://"):
            book.good("Plain http:// visitors are sent to https://")
        elif http_probe.status == 200:
            book.add("web.https.no-redirect", "security", "medium", "The site can still be opened without encryption",
                     "The http:// address answers with the page instead of sending visitors to https://, so people who type the plain address use an unencrypted connection.",
                     "Redirect all http:// requests to https:// (a 301 redirect), then add HSTS.", evidence=f"http://{host}/ answered {http_probe.status}", location=f"http://{host}/")


def check_security_txt(status: int | None, book: FindingBook, host: str) -> None:
    if status == 200:
        book.good("A security.txt tells researchers how to report problems")
    elif status in {404, 410}:
        book.add("web.security-txt.missing", "security", "low", "No place for people to report a security problem",
                 "A /.well-known/security.txt file tells researchers who to contact. Without one, a person who finds a flaw may not know where to send it, or may just post it publicly.",
                 "Publish /.well-known/security.txt with a contact address and a policy link (securitytxt.org has a generator).", evidence="/.well-known/security.txt: 404", location=f"https://{host}/.well-known/security.txt")


def check_robots(robots: Robots, book: FindingBook, host: str) -> None:
    hits = [p for p in robots.disallowed_paths if SENSITIVE_ROBOTS.search(p)]
    if hits:
        book.add("web.robots.sensitive", "security", "low", "robots.txt points at sensitive-looking folders",
                 "robots.txt is public and is not access control. Listing folders such as an admin area tells everyone where to look.",
                 "Protect those folders with a login or network rules and remove them from robots.txt (a `noindex` header keeps them out of search).", evidence="Disallow: " + ", ".join(hits[:4]), location=f"https://{host}/robots.txt")


def ai_text_hits(page: PageData) -> list[tuple[str, bool]]:
    """Text that talks to an AI reader, as (text, hidden from people). Looks at short pieces: comments, hidden elements, sentences.

    Hidden text and comments are what a person never sees, so a hit there counts as hidden. A hit in visible text is hidden
    only if it uses invisible characters. This never runs a regular expression over the whole page source."""
    out: list[tuple[str, bool]] = []
    for piece in page.comments[:60]:
        out += [(h.text, True) for h in find_injections(piece[:600])]
    for piece in page.hidden_text[:40]:
        out += [(h.text, True) for h in find_injections(piece[:300])]
    for piece in sentences(page.visible_text):
        out += [(h.text, h.hidden) for h in find_injections(piece)]
    seen: set[str] = set()
    unique = []
    for text, hidden in out:
        if text not in seen:
            seen.add(text)
            unique.append((text, hidden))
    return sorted(unique, key=lambda t: not t[1])  # hidden ones first


def check_pages(pages: list[tuple[Fetched, PageData]], book: FindingBook, host: str) -> None:
    mixed_scripts: list[str] = []
    mixed_images: list[str] = []
    no_sri: list[str] = []
    third: set[str] = set()
    seen_secret = False
    email_noted = False
    for fetched, page in pages:
        https = page.url.startswith("https:")
        # mixed content
        if https:
            for u in [*(s.src for s in page.scripts if s.src), *page.stylesheets, *page.iframes]:
                if u and u.startswith("http://"):
                    mixed_scripts.append(u)
            mixed_images += [src for src, _ in page.images if src.startswith("http://")]
        # forms
        for form in page.forms:
            if form.has_password and not https:
                book.add("web.form.password-http", "security", "critical", "A password form is on a page without encryption",
                         "Anyone on the same network can read what visitors type into this form.", "Serve the page and the form over HTTPS only.", evidence=f"<form action={form.action[:80]}> with a password field", location=page.url)
            elif form.action.startswith("http://") and https:
                book.add("web.form.insecure-action", "security", "high", "A form sends its data over an unencrypted connection",
                         "The page is secure but the form posts to an http:// address, so what visitors type travels in the clear.", "Change the form action to https://.", evidence=f"<form action={form.action[:90]}>", location=page.url)
            if form.has_password and form.method != "post":
                book.add("web.form.password-get", "security", "high", "A password form puts the password in the address",
                         "A form that uses GET puts what is typed into the web address, which ends up in browser history, server logs and referrer headers.", "Use `method=\"post\"` for forms that take passwords.", evidence=f"<form method={form.method or 'get'}> with a password field", location=page.url)
        # third-party scripts without integrity
        for s in page.scripts:
            if s.src:
                sh = host_of(s.src)
                if sh and not same_site(sh, host):
                    third.add(sh)
                    if not s.integrity:
                        no_sri.append(s.src)
        for u in [*page.stylesheets, *page.iframes, *(src for src, _ in page.images)]:
            sh = host_of(u) if u else ""
            if sh and not same_site(sh, host):
                third.add(sh)
        # secrets, comments, internal addresses, instructions for AI: read the raw source
        raw = fetched.text[:MAX_SOURCE]
        if not seen_secret:
            for m in secret_matches(raw, "page.html"):
                if m.severity in {"critical", "high"}:
                    book.add("web.secret-in-source", "security", m.severity, "A secret is written in the page's source",
                             "Anything in a page's HTML or script is public to every visitor. A key or token there can be copied and used.",
                             "Revoke the key now, create a new one, and keep it on the server side (call the service from your backend).", evidence=m.evidence, location=page.url)
                    seen_secret = True
                    break
        for c in page.comments[:60]:
            if c.lower().startswith(("[if", "<![endif")):
                continue
            if LEAKY_COMMENT.search(c):
                book.add("web.comment.leak", "security", "medium", "An HTML comment mentions credentials",
                         "HTML comments are sent to every visitor. A comment that mentions a password or key may contain one, or hints where to find one.", "Remove comments from production pages (a build step can strip them).", evidence=c[:140], location=page.url)
                break
            if NOTE_COMMENT.search(c):
                book.add("web.comment.note", "security", "info", "A developer note is visible in the page's source",
                         "Notes like TODO or debug comments tell outsiders how the site is built.", "Strip comments from production builds.", evidence=c[:140], location=page.url)
                break
        internal = PRIVATE_IP.search(raw)
        internal_text = internal.group(0) if internal else find_internal_host(raw)
        if internal_text:
            book.add("web.internal-address", "security", "low", "The page mentions an internal address",
                     "An internal IP address or host name in public pages tells outsiders about your private network.", "Remove internal addresses from public pages and configuration shipped to the browser.", evidence=internal_text, location=page.url)
        for text, hidden in ai_text_hits(page)[:2]:
            book.add("web.ai-instructions", "security", "high" if hidden else "medium", "The page contains text written for AI readers",
                     "Text that tells an AI assistant what to do (and sometimes hides from people) is how pages try to steer AI tools that read them. It can also get a site flagged.",
                     "Remove it. If you want AI tools to behave in a certain way, say so in plain public documentation, not in hidden text.", evidence=mask_line(text), location=page.url)
        emails = find_emails(page.visible_text)
        if emails and not email_noted:
            email_noted = True  # one note is enough
            book.add("web.email.exposed", "privacy", "info", "An email address is written in plain text",
                     "Addresses in plain text are collected by spam robots.", "Use a contact form, or write the address in a way that is hard to harvest.", evidence=", ".join(emails[:3]), location=page.url)

    if mixed_scripts:
        book.add("web.mixed-content.active", "security", "high", "A secure page loads scripts or styles over plain http",
                 "Browsers block or warn about this, and anyone on the network could replace those files with their own.", "Load every script, style and frame from an https:// address.", evidence=", ".join(sorted(set(mixed_scripts))[:2]), location=pages[0][1].url)
    if mixed_images:
        book.add("web.mixed-content.passive", "security", "low", "A secure page loads images over plain http",
                 "Images over http make the padlock disappear in some browsers and show which pages a visitor reads.", "Use https:// for images.", evidence=", ".join(sorted(set(mixed_images))[:2]), location=pages[0][1].url)
    if no_sri:
        hosts = sorted({host_of(u) for u in no_sri})
        book.add("web.sri.missing", "security", "low", "Scripts from other websites are not integrity-checked",
                 "If a third-party host is hacked, every site that loads its script is hacked too. A Subresource Integrity hash makes the browser refuse a changed file.",
                 "Add `integrity` and `crossorigin` attributes to third-party scripts, or host them yourself.", evidence=", ".join(hosts[:4]), location=pages[0][1].url)
    if len(third) >= 12:
        book.add("web.third-parties", "privacy", "info", f"Pages load from {len(third)} other websites",
                 "Every outside host sees your visitors' addresses and can slow or break the page.", "Remove what you do not need and host the rest yourself.", evidence=", ".join(sorted(third)[:5]), location=pages[0][1].url)
    if pages and not seen_secret:
        book.good("No keys or passwords were found in the page source")
