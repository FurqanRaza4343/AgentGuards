# AgentGuard scanner and Orchestrator

A Python service that reads things on the public internet **read-only**, finds problems and weak spots, and returns a
report. Three kinds of input:

| Input | What reads it | What you get |
|---|---|---|
| A **public GitHub repository** | Scout, Retriever, Auditor, Coach | Findings with real file names and line numbers, which the game (`../src/missions/`) turns into playable missions |
| A **website** | The Orchestrator: Nova + Scraper, Security, Content | Security, search and accessibility findings, **questions** and rewrites from Nova |
| A **profile you paste** (for example from LinkedIn) | The Orchestrator: Nova + Reader, Privacy, Impact | Privacy, writing and keyword findings, **questions** and rewrites from Nova |

Nothing from a repository, a site or a profile is ever executed, and nothing is stored.

```
POST /api/scan     {"url": "github.com/owner/repo"}                    -> Server-Sent Events: log ... log, report (or error)
POST /api/assess   {"kind": "site", "url": "example.com"}              -> the same shape, for a website
                   {"kind": "profile", "text": "...", "role": "..."}   -> the same shape, for a pasted profile
GET  /api/demo, /api/demo/site, /api/demo/profile                      the pre-baked reports of the planted demos
GET  /api/health                                                       {"ok": true, "model": true, "search": false, "testSource": false}
```

## The Orchestrator (website and profile)

Nova (the first robot) is the orchestrator. It reads the request, sends **one task to each of three specialists**, collects
what they found and writes the questions. The specialists work **at the same time** and hand work to each other through
futures: the Security specialist waits for the home page, the Content specialist waits for all the pages. Every log line
says who speaks, who receives (the browser flies a message between those two robots), what state the speaker is in and
what it is doing now, so the 3D stage shows the real order of events.

| Robot | Website | Profile |
|---|---|---|
| Nova | Orchestrator: plans, delegates, asks | the same |
| DataRetriever | **Scraper**: robots.txt, the home page, up to five linked pages, sitemap, broken links | **Reader**: sections, headline, what is missing |
| PurchasingAgent | **Security**: headers, cookies, certificate, plain-http redirect, security.txt, page source (mixed content, forms, secrets, comments, text aimed at AI readers) | **Privacy**: phone, email, ID numbers, address, shortened links, secrets, text aimed at AI screening tools |
| FinanceAgent | **Content**: titles, descriptions, headings, phones (viewport), accessibility, thin content, search visibility | **Impact**: headline, About, numbers and results, buzzwords, keywords that hiring pages mention |

**Nova's questions.** Gemini (through ADK, no tools, answers only in a schema) writes 5 to 8 questions and 3 to 5 rewrites
from the findings. Every answer is checked before it is used: finding ids must exist, a quote must be found in the
owner's own text, links, markdown images, active HTML and shell commands are removed, anything that talks to an AI
reader is dropped. Without a key, or if the model fails, **templates** write the questions from the same findings.

**The website rules.** Passive and polite, by construction (`tools/web.py`):

- ordinary GET requests only, at most about eleven per run; no forms are submitted, no scripts run, no logins, no hidden
  paths guessed (it reads `/robots.txt`, `/sitemap.xml`, `/.well-known/security.txt` and pages the site links to);
- `robots.txt` is read first and obeyed (a missing file allows everything, a server error disallows everything, as RFC 9309 says);
  the user agent is `AgentGuardBot` so an owner can block it there;
- a redirect to a different site is refused, so this cannot become a way to reach other people's sites;
- only real public DNS names on port 80 or 443: IP addresses, single-label names and `.local`/`.internal` names are refused,
  every DNS answer is checked, the connection is pinned to the checked address, every redirect is checked again;
- every request has a total time limit (a server that drips one byte at a time cannot hold it), bodies are capped while they
  stream, a page is parsed only up to 400 KB and 400 levels deep, and the CPU-heavy steps run in a thread so a hostile page
  cannot stall other requests. One site may be read only a few times an hour, whoever asks.

**Search (optional).** With `SEARXNG_URL` set, the Content specialist asks whether the site shows up when its own name is
searched, and the Impact specialist asks what hiring pages for the role the person typed mention. **Only the site's name or
the typed role leaves this server**, never a pasted profile or a person's name. Results are untrusted data: shortened,
cleaned, dropped if they talk to an AI reader, never fetched. The keyword comparison is counting, not guessing: a fixed
vocabulary, counted across the results.

**Profiles, not scraping.** LinkedIn forbids automated collection and needs a login, so the person pastes their own text.
Contact details are replaced (`[email]`, `[phone]`, `[id]`) before any excerpt reaches a model.

## The repository scan crew

| Stage | Role | May do | May not do |
|---|---|---|---|
| Scout | checks the address | parse `github.com/owner/repo` | any network call |
| Retriever | fetches one archive | download from `api.github.com` / `codeload.github.com` through the network policy | read anything else |
| Auditor | runs the rules | read the in-memory corpus, ask OSV.dev about dependencies | write, run, or call a model |
| Coach | writes prose | call Gemini through ADK with masked excerpts | pick lines, ids, severities, points or options |

The **Guard** is not a stage but a layer around all of them (`guardscan/guard/`):

- `netpolicy.py`: one deny-set of address ranges used for the literal host and for DNS answers, checked at connect time
  (the connection is pinned to the checked address) and again on every redirect. Covers loopback, private ranges,
  link-local and cloud metadata, CGNAT, IPv4-mapped / NAT64 / 6to4 / Teredo forms, and numeric hosts like `0x7f000001`.
  `check_url` has an allow-list (GitHub); `check_public_url` is the stricter one for websites.
- `inject.py`: strips hidden content (comments, zero-width characters, text hidden with CSS) before any model sees a
  file, **and turns it into a finding**; detects instructions aimed at AI readers; wraps untrusted text for prompts.
- `mask.py`: secrets are masked at the source (first four characters stay). A test proves the demo's fake key never
  reaches a report, a log line or a prompt.
- `budget.py`: file, byte, time and finding limits; a per-address rate limit; a daily model-call budget; a kill switch.

`verify.py` checks what the Coach returns: it may only add prose, a quoted line must exist in the corpus, links and
markdown images are removed, and ids, lines, severities and CVE numbers only ever come from the rules and OSV.

About thirty repository rules in 8 groups: `secret`, `deps` (OSV advisories for pinned versions in `requirements*.txt`,
`package-lock.json`, `poetry.lock` and `Cargo.lock`; a loose `package.json` range is not checked, because OSV needs an exact
version), `ci`, `docker`, `mcp`, `agent` (dangerous instructions in AGENTS.md / CLAUDE.md / skills), `injection`
and `hygiene`. Several rules also produce a **benign** match, the safe form of the same pattern. Those become the
"legitimate request" steps in the game, which teach the player not to over-block.

## Run it

```bash
python -m venv .venv
.venv/Scripts/pip install -r requirements-dev.txt     # Windows; use .venv/bin/pip on Linux and macOS
.venv/Scripts/python -m pytest                        # 425 tests, no network and no key needed
.venv/Scripts/python -m uvicorn guardscan.api:app --host 127.0.0.1 --port 8000
```

A `.env` file (see `../.env.example`) is read from this folder or up to four folders above it. Put `GEMINI_API_KEY`
there (and optionally `GEMINI_API_KEY2`, used if the first fails) and Gemini writes the questions and explanations.
Without a key the templates do. The Vite dev server proxies `/api` to `127.0.0.1:8000`.

From a terminal, or in CI (see `../.github/workflows/ci.yml`):

```bash
python -m guardscan.cli site example.com --model --out report.json        # --model: let Gemini write the questions
python -m guardscan.cli profile --file my-profile.txt --role "Backend engineer" --out report.json
python -m guardscan.cli url github.com/owner/repo --out report.json
python -m guardscan.cli dir .. --repo owner/name --fail-on high --ignore-file ../.agentguard-ignore
python -m guardscan.cli bake-demos --out-dir demo --model                 # re-bake the planted site and profile (copy to ../public too)
python -m guardscan.cli serve-demo-site --port 8787                       # the planted site on 127.0.0.1, for the end-to-end run
```

`--ignore-file` accepts findings you have reviewed. Every line needs a reason (`RULE_GLOB PATH_GLOB -- why`) and stale
entries are reported. The web service never reads such a file from a repository it scans.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `GEMINI_API_KEY`, `GEMINI_API_KEY2`, ... (or `GOOGLE_API_KEY`) | unset | Turns on Gemini. Every key is tried with every model before the questions fall back to templates |
| `AGENTGUARD_MODELS` | `gemini-2.5-flash,gemini-2.5-flash-lite` | The models to try, in order. The free tier counts quota per model and per key, so when `flash` is used up for the day `flash-lite` (its own quota) answers. A (model, key) pair that said "quota" is skipped for 5 minutes |
| `AGENTGUARD_MODEL` | unset | One model name to try first |
| `SEARXNG_URL` | unset | A SearXNG server (JSON format enabled) for the search checks, e.g. `http://127.0.0.1:8888` |
| `AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL` | unset | An optional **backup** language model (any OpenAI-compatible API), asked only when no Gemini model answers. The report and Nova's log say "a backup language model", never "Gemini", when it wrote the text |
| `GITHUB_TOKEN` | unset | Optional, raises the GitHub rate limit. Never sent anywhere else |
| `AGENTGUARD_RATE_PER_HOUR` | 6 | Runs per client address per hour |
| `AGENTGUARD_HOST_RATE_PER_HOUR` | 3 | Runs per website per hour, whoever asks |
| `AGENTGUARD_MAX_CONCURRENT` | 2 | Runs at the same time; more get a 503 |
| `AGENTGUARD_DAILY_LLM_CALLS` | 200 | Daily model-call budget |
| `AGENTGUARD_KILL_SWITCH` | unset | `1` turns the model off at once (everything else keeps working) |
| `AGENTGUARD_PACE` | 0.45 | Seconds between the visible steps of a profile run (it is all local and would otherwise be over in a blink) |
| `AGENTGUARD_TRUST_PROXY` | unset | `1` reads the client address from `X-Forwarded-For`. Only behind a proxy you control (Cloud Run) |
| `AGENTGUARD_STATIC_DIR` | unset | Serve the built site from this folder (the Docker image sets it) |
| `AGENTGUARD_ENV` | unset | `production` refuses the test-only settings below |
| `AGENTGUARD_TEST_SOURCE_DIR` | unset | **Tests only.** Read repositories from local folders instead of GitHub |
| `AGENTGUARD_ALLOW_PRIVATE_NETWORK` | unset | **Tests only.** Lifts the private-address and port rules (the end-to-end run reads a fixture site on 127.0.0.1) |

## What is verified, and what is not

Verified:

- the 425 tests (network policy table, hostile archives, hostile pages, hidden-content stripping, secret masking, every rule
  with a bad and a good case, the pipeline, the Orchestrator with fake models and fake search, the HTTP interface, the CLI);
- the pinned `requirements.txt` installs into a clean Python 3.11 environment and the suite passes there;
- **Gemini, live, on 2026-11-22:** the Coach for the repository demo (prose kept for 12 of 13 findings), and Nova's questions and
  rewrites for the planted website and the planted profile (every question and rewrite passed the checks), with both
  configured keys; the baked demo reports in `demo/` were written by Gemini;
- a real call to OSV.dev through the guarded transport;
- the whole stack in headless Chrome: `../tools/e2e-live.mjs` (repository) and `../tools/e2e-assess.mjs` (website and profile
  over real HTTP against the planted site, a stand-in search server, and live Gemini): the three specialists work at the same time,
  only the role goes to the search server, no contact detail comes back on the page, the demos replay, and a phone has no sideways scroll;
- **SearXNG and Docker, 2026-11-22:** the SearXNG container (`../searxng/`, image pinned by digest) answered JSON searches, and
  AgentGuard's client used it for a site's name (example.com came back as result 1) and for a role (40 results read). The
  service image built, ran read-only as a non-root user, was healthy, and analysed `example.com` and a profile from inside
  the container with Gemini and the host's SearXNG;
- one real website was scanned over the real internet (`example.com`, IANA's reserved test domain): real DNS, TLS 1.3 and the
  guarded transport worked, and the findings matched what the page really sends.

**Not verified yet:** a Cloud Run deploy, and your own website or profile (that is for you to run and read). Gemini's free-tier
quota is small: after a few runs in a minute it answers `ResourceExhausted`, and the run falls back to templates (seen in the
container test). Ownership of a site or a repository cannot be proven from its address, so every run is in third-party mode: no attack
steps, secrets masked, nothing stored.

## Not included on purpose

No stealth or anti-detection features, no scraping of LinkedIn or any logged-in site, no active probing of websites
(no port scans, no path guessing, no fuzzing, no form submission), and no private repositories.
