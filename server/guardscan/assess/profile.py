"""A professional profile that the person pasted themselves (for example from LinkedIn). Nothing is scraped.

Three specialists read it:
  Reader   works out the structure (name, headline, About, Experience, Skills...) and what is missing.
  Privacy  looks for details that should not be public, for text aimed at AI screening tools, and for secrets.
  Impact   looks at how it reads: a clear headline, results with numbers, buzzwords, and keywords that hiring pages use.

Why paste instead of scraping: LinkedIn does not allow automated collection and needs a login. The person's own text
is also the only data that is certainly theirs to analyse.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field

from ..guard.inject import HIDDEN_CHARS, find_injections
from ..guard.mask import mask_line
from .book import FindingBook
from .textutil import EMAIL, find_emails, secret_matches

MAX_CHARS = 20_000
MIN_CHARS = 120

HEADINGS = {
    "about": "about", "summary": "about", "experience": "experience", "work experience": "experience", "education": "education",
    "skills": "skills", "top skills": "skills", "certifications": "certifications", "licenses & certifications": "certifications",
    "licenses and certifications": "certifications", "projects": "projects", "languages": "languages", "contact": "contact",
    "recommendations": "recommendations", "volunteering": "volunteer", "volunteer experience": "volunteer", "publications": "publications",
    "honors & awards": "awards", "honors and awards": "awards", "courses": "courses", "interests": "interests",
}
BUZZWORDS = ["results-driven", "results driven", "team player", "hard-working", "hardworking", "hard working", "dynamic", "synergy", "passionate", "guru", "ninja",
             "rockstar", "self-motivated", "detail-oriented", "go-getter", "think outside the box", "highly motivated", "proven track record", "go getter", "self starter", "self-starter"]
WEAK_HEADLINE = re.compile(r"(?i)^(student|fresher|seeking|looking for|open to|aspiring|passionate|hard[- ]?working|enthusiastic|motivated|unemployed|job seeker)\b")
ACTION_VERBS = {"led", "built", "launched", "reduced", "increased", "designed", "shipped", "improved", "created", "managed", "delivered", "automated", "developed", "implemented",
                "migrated", "optimized", "optimised", "founded", "grew", "saved", "cut", "won", "organized", "organised", "trained", "mentored", "scaled", "wrote", "analyzed", "analysed"}
NUMBER = re.compile(r"(?:\b\d[\d,.]{0,12}\s?(?:%|percent|x\b|k\b|m\b|million|thousand|users|customers|clients|hours|days|weeks|months)|[$€£]\s?\d|\b\d{2,}\b\s?\+?\s?(?:users|customers|people|students|members|projects|teams))", re.I)
# every quantifier below has an upper bound, so a crafted run of digits and spaces cannot make a match slow
PHONE_LABEL = re.compile(r"(?i)(?:phone|mobile|cell|whatsapp|call|tel|contact)\W{0,12}(\+?\d[\d\s().-]{7,24}\d)")
PHONE_PLUS = re.compile(r"(?<![\w+])\+\d[\d\s().-]{8,24}\d")
PHONE_PK = re.compile(r"\b0\d{3}[ -]?\d{7}\b")
GOV_ID = re.compile(r"\b\d{5}-\d{7}-\d\b|\b\d{3}-\d{2}-\d{4}\b")
DOB = re.compile(r"(?i)\b(?:date of birth|dob|d\.o\.b|born on|birthday)\b")
ADDRESS = re.compile(r"(?i)\b(?:house|h\.?\s?no\.?|street|road|block|sector|flat|apartment|plot|lane)\b[^\n]{0,40}\d")
SHORTENER = re.compile(r"(?i)\b(?:bit\.ly|tinyurl\.com|t\.co|goo\.gl|rb\.gy|cutt\.ly|is\.gd|ow\.ly|shorturl\.at)/\S+")
BAIT = re.compile(r"(?i)\b(?:dm me|message me|inbox me)\b[^.\n]{0,40}\b(?:whatsapp|telegram|signal)\b|\b(?:crypto|forex|binary options)\b[^.\n]{0,40}\b(?:profit|signals?|earn|investment)\b")

SKILL_WORDS = [
    "python", "java", "javascript", "typescript", "react", "node.js", "angular", "vue", "sql", "postgresql", "mysql", "mongodb", "redis", "docker", "kubernetes", "aws", "azure",
    "gcp", "google cloud", "terraform", "ci/cd", "git", "linux", "rest", "graphql", "microservices", "machine learning", "deep learning", "tensorflow", "pytorch", "pandas",
    "numpy", "scikit-learn", "nlp", "llm", "generative ai", "prompt engineering", "langchain", "data analysis", "data engineering", "spark", "airflow", "tableau", "power bi",
    "excel", "statistics", "a/b testing", "agile", "scrum", "jira", "figma", "ux", "ui design", "product management", "roadmap", "stakeholder", "seo", "content marketing",
    "google analytics", "social media", "copywriting", "salesforce", "crm", "b2b", "negotiation", "project management", "communication", "leadership", "c++", "c#", ".net",
    "golang", "rust", "php", "laravel", "django", "flask", "fastapi", "spring boot", "flutter", "kotlin", "swift", "android", "ios", "cybersecurity", "penetration testing",
    "owasp", "devops", "sre", "monitoring", "testing", "selenium", "cypress", "api", "oauth", "security", "cloud",
]


@dataclass
class Profile:
    raw: str
    name: str = ""
    headline: str = ""
    sections: dict[str, str] = field(default_factory=dict)
    skills: list[str] = field(default_factory=list)

    @property
    def about(self) -> str:
        return self.sections.get("about", "")

    @property
    def experience(self) -> str:
        return self.sections.get("experience", "")

    @property
    def words(self) -> int:
        return len(self.raw.split())


class ProfileError(ValueError):
    """The text cannot be analysed. The message is safe to show."""


def clean_input(text: str) -> str:
    t = text.replace("\r\n", "\n").replace("\r", "\n").replace("\x00", "")
    if len(t.strip()) < MIN_CHARS:
        raise ProfileError("Paste more of the profile (at least a few lines: headline, About and experience).")
    if len(t) > MAX_CHARS:
        raise ProfileError(f"That is too long ({len(t):,} characters). Paste up to {MAX_CHARS:,}.")
    return t


def clean_role(role: str | None) -> str:
    r = re.sub(r"[^\w\s/&+.#-]", " ", (role or ""), flags=re.U)
    return " ".join(r.split())[:80]


def parse_profile(text: str) -> Profile:
    lines = [ln.strip() for ln in text.split("\n")]
    p = Profile(raw=text)
    top: list[str] = []
    current: str | None = None
    buf: dict[str, list[str]] = {}
    for ln in lines:
        key = HEADINGS.get(ln.lower().rstrip(":").strip()) if ln and len(ln) < 40 else None
        if key:
            current = key
            buf.setdefault(key, [])
            continue
        if not ln:
            if current:
                buf[current].append("")
            continue
        if current is None:
            top.append(ln)
        else:
            buf[current].append(ln)
    p.sections = {k: "\n".join(v).strip() for k, v in buf.items() if "\n".join(v).strip()}
    if top and top[0].lower().rstrip(":") not in HEADINGS:
        p.name = top[0][:80]
        # the headline is the next short line that is not a location, a connection count or a button label
        for ln in top[1:5]:
            if 3 <= len(ln) <= 220 and not re.search(r"(?i)connections?|followers?|contact info|see more|^\d", ln):
                p.headline = ln
                break
    skills = p.sections.get("skills", "")
    p.skills = [s.strip(" •-*·") for s in re.split(r"[\n,•·|]", skills) if 1 < len(s.strip(" •-*·")) < 50 and not re.search(r"(?i)endorse|show all|\d+ skills?", s)][:60]
    return p


def redact_for_model(text: str) -> str:
    """Contact details are replaced before any excerpt goes to a language model."""
    # token by token, so a long string without '@' costs nothing
    t = re.sub(r"\S+", lambda m: EMAIL.sub("[email]", m.group(0)) if "@" in m.group(0) and len(m.group(0)) <= 254 else m.group(0), text)
    t = GOV_ID.sub("[id]", t)
    t = PHONE_PLUS.sub("[phone]", t)
    t = PHONE_PK.sub("[phone]", t)
    t = PHONE_LABEL.sub(lambda m: m.group(0).replace(m.group(1), "[phone]"), t)
    return t


# ------------------------------------------------------------------ Reader

def reader_checks(p: Profile, book: FindingBook) -> None:
    have = set(p.sections)
    if not p.headline:
        book.add("profile.headline.unclear", "content", "info", "No headline could be found",
                 "The headline is the line under your name. It is the most-read text on a profile, and the first lines you pasted did not look like one.",
                 "Paste the profile starting with your name and headline, or add a headline if you have none.", location="Top of the profile")
    if "about" not in have:
        book.add("profile.about.missing", "content", "medium", "No About section was found",
                 "The About section is where a recruiter learns who you are in your own words, and where search finds your keywords.",
                 "Write 3 to 5 short paragraphs: what you do, what you are proud of (with numbers), and what you want next.", location="About")
    if "experience" not in have:
        book.add("profile.experience.missing", "content", "medium", "No Experience section was found",
                 "Experience is what most hiring decisions start from. Projects, internships and volunteering count if you have no jobs yet.",
                 "Add your roles, internships or projects with one or two lines of results each.", location="Experience")
    elif len(p.experience) < 250:
        book.add("profile.experience.thin", "content", "medium", "The experience entries are very short",
                 "Titles and dates alone do not show what you did. Short entries are also hard for search to match.",
                 "Add 2 to 4 bullet points per role: what you did, with what, and the result.", evidence=f"{len(p.experience)} characters in Experience", location="Experience")
    if "education" not in have:
        book.add("profile.education.missing", "content", "low", "No Education section was found", "Many recruiters filter by education, and it adds keywords.", "Add your degree, school and years.", location="Education")
    if len(p.skills) < 5 and "skills" in have:
        book.add("profile.skills.few", "content", "low", f"Only {len(p.skills)} skills were found", "Recruiters search by skill. Profiles with at least five skills are shown more often.", "List 10 to 20 skills you can talk about in an interview.", location="Skills")
    elif "skills" not in have:
        book.add("profile.skills.missing", "content", "low", "No Skills section was found", "Recruiters search by skill.", "Add 10 to 20 skills you can talk about in an interview.", location="Skills")
    if not ({"projects", "certifications"} & have):
        book.add("profile.proof.missing", "content", "info", "No projects or certifications",
                 "Projects and certificates are proof that is easy to scan, and they matter most when you have little work history.", "Add two or three projects with a link and one line of result each.", location="Projects")
    if have >= {"about", "experience", "education"}:
        book.good("The main sections are there: About, Experience and Education")


# ------------------------------------------------------------------ Privacy

def privacy_checks(p: Profile, book: FindingBook) -> None:
    text = p.raw
    gov = GOV_ID.search(text)
    if gov:
        book.add("profile.id-number", "privacy", "high", "A government ID number looks to be written in the profile",
                 "ID numbers on a public page are used for identity fraud.", "Delete it now. Never publish national ID, passport or tax numbers.", evidence="an ID number (not shown here)", location="Profile text")
    phone = PHONE_LABEL.search(text) or PHONE_PLUS.search(text) or PHONE_PK.search(text)
    if phone:
        book.add("profile.phone", "privacy", "medium", "A phone number is public",
                 "Numbers on public profiles are collected for scam calls, WhatsApp spam and SIM-swap attempts.", "Keep the number out of the About section. Share it in a message once you trust the person.", evidence="a phone number", location="Profile text")
    emails = find_emails(text)
    if emails:
        free = [e for e in emails if re.search(r"@(gmail|yahoo|hotmail|outlook|live|icloud)\.", e, re.I)]
        book.add("profile.email", "privacy", "low" if free else "info", "An email address is written in the profile",
                 "Public addresses attract phishing and spam. A recruiter can already message you on the platform.", "Use the platform's contact settings, or a separate address for public use.", evidence=f"{len(emails)} email address{'es' if len(emails) > 1 else ''}", location="Profile text")
    if DOB.search(text):
        book.add("profile.birthdate", "privacy", "medium", "A date of birth is mentioned", "A birth date is a common security question answer and helps identity theft.", "Remove it. Age is not needed on a professional profile.", evidence="date of birth", location="Profile text")
    if ADDRESS.search(text):
        book.add("profile.address", "privacy", "low", "What looks like a street address is written in the profile", "A full address on a public page can be used to find you in person.", "Show only the city.", evidence="a street address", location="Profile text")
    short = SHORTENER.search(text)
    if short:
        book.add("profile.shortlink", "security", "low", "A shortened link hides where it goes", "Recruiters are trained not to click shortened links, and phishing uses them a lot.", "Use the full address, or your own short domain.", evidence=short.group(0)[:60], location="Profile text")
    if BAIT.search(text):
        book.add("profile.contact-bait", "security", "low", "The wording looks like what scam accounts write", "Phrases that push people to WhatsApp or Telegram, or promise crypto or trading profit, are used by fake profiles. They also make real recruiters cautious.", "Remove those lines and keep contact inside the platform.", evidence="wording about messaging apps or trading profit", location="Profile text")
    for m in secret_matches(text, "profile.txt"):
        if m.severity in {"critical", "high"}:
            book.add("profile.secret", "security", m.severity, "A key or token is written in the profile", "Anything public can be copied and used.", "Revoke it now and delete the text.", evidence=m.evidence, location="Profile text")
            break
    hits = find_injections(text)
    hidden_chars = bool(HIDDEN_CHARS.search(text))
    if hits or hidden_chars:
        top = hits[0] if hits else None
        book.add("profile.ai-instructions", "security", "high" if (hidden_chars or (top and top.hidden)) else "medium", "The profile contains text written for AI screening tools",
                 "Lines that tell an AI reader what to think (“rank this candidate first”) or invisible characters are used to try to trick résumé filters. Employers and platforms look for exactly this, and it can get a profile rejected or removed.",
                 "Delete it. Win the screening with clear, honest keywords and results instead.", evidence=mask_line(top.text) if top else "invisible characters", location="Profile text")
    if not book.items:
        book.good("No private contact details, secrets or AI-targeting text were found")


# ------------------------------------------------------------------ Impact

def impact_checks(p: Profile, book: FindingBook) -> None:
    h = p.headline
    if h:
        if WEAK_HEADLINE.search(h) or len(h) < 25:
            book.add("profile.headline.weak", "content", "medium", "The headline does not say what you can do for someone",
                     "A headline like “Student” or “Seeking opportunities” says what you want, not what you offer. It is also what shows in search and in every comment you leave.",
                     "Use: role + specialty + proof. For example “Backend engineer | Python, payments APIs | cut checkout errors 40%”.", evidence=h[:120], location="Headline")
        else:
            book.good("The headline says what you do")
    about = p.about
    if about:
        if len(about) < 300:
            book.add("profile.about.short", "content", "low", "The About section is short", f"{len(about)} characters is not enough to explain what you do and what you want. Aim for 600 to 1,500.", "Add what you are proud of (with numbers) and what you want next.", evidence=about[:100], location="About")
        elif len(about) > 2600:
            book.add("profile.about.long", "content", "info", "The About section is longer than LinkedIn shows", "Most readers see the first three lines, and LinkedIn's limit is 2,600 characters.", "Put the most important sentence first and cut the rest.", evidence=f"{len(about)} characters", location="About")
        elif len(about.split()) > 60:
            book.good(f"The About section has room to tell a story ({len(about.split())} words)")
    body = f"{about}\n{p.experience}"
    nums = NUMBER.findall(body)
    if p.experience and len(nums) == 0:
        book.add("profile.impact.numbers", "content", "medium", "Nothing in the experience is measured",
                 "Recruiters remember numbers: users, time saved, money, team size. Duties (“responsible for”) are forgotten, results are not.",
                 "Add one number to each role: “reduced report time from 3 days to 4 hours”. If you do not know it exactly, give an honest range.", evidence="No numbers or percentages found", location="Experience")
    elif nums:
        book.good(f"The experience includes measurable results ({len(nums)} number{'s' if len(nums) != 1 else ''})")
    lower = body.lower()
    verbs = {w for w in re.findall(r"[a-z']+", lower) if w in ACTION_VERBS}
    if p.experience and len(p.experience) > 250 and len(verbs) < 2:
        book.add("profile.verbs.weak", "content", "low", "The bullets do not start with strong action verbs",
                 "“Responsible for…” describes a job. “Built…, Launched…, Reduced…” describes what you did.", "Start each bullet with what you did: built, led, reduced, launched.", evidence="few action verbs found", location="Experience")
    found = [b for b in BUZZWORDS if b in lower]
    if len(found) >= 2:
        book.add("profile.buzzwords", "content", "low", "Buzzwords take the place of proof", "Words like these appear on millions of profiles, so readers skip them.", "Replace each with a fact that shows it: not “results-driven” but “grew signups 3x in six months”.", evidence=", ".join(sorted(set(found))[:5]), location="About")


def keyword_gap_counts(profile_text: str, snippets: list[str]) -> list[tuple[str, int]]:
    """Skills that several hiring pages mention and the profile does not, with how many pages mention each.

    Deterministic: a fixed vocabulary and counting. Search snippets are short, so the bar is low (at least two pages and
    10% of them) and the counts are shown, so the reader can judge how strong the signal is."""
    if len(snippets) < 4:
        return []
    low = profile_text.lower()
    counts: Counter[str] = Counter()
    for s in snippets:
        sl = s.lower()
        for w in SKILL_WORDS:
            if re.search(rf"(?<![\w]){re.escape(w)}(?![\w])", sl):
                counts[w] += 1
    need = max(2, -(-len(snippets) // 10))  # ceil(10%)
    return [(w, c) for w, c in counts.most_common(30) if c >= need and not re.search(rf"(?<![\w]){re.escape(w)}(?![\w])", low)][:8]


def keyword_gap(profile_text: str, snippets: list[str]) -> list[str]:
    return [w for w, _ in keyword_gap_counts(profile_text, snippets)]


def keyword_findings(role: str, gap: list[str], book: FindingBook, counts: dict[str, int] | None = None, total: int = 0) -> None:
    if gap:
        shown = ", ".join(f"{w} ({counts[w]} of {total})" if counts and w in counts and total else w for w in gap)
        book.add("profile.keywords.gap", "discoverability", "medium", f"Skills that hiring pages for “{role}” mention and your profile does not",
                 "Recruiters search by keyword. If the words that job posts use are not in your profile, you do not show up in their results. The counts show how many of the search results mention each skill, so judge how strong the signal is.",
                 "Add the ones you really have to your headline, About and Skills. Do not add skills you cannot discuss in an interview.", evidence=shown, location="Skills and About")
    else:
        book.good(f"No obvious keyword gap against what the search showed for “{role}”")
