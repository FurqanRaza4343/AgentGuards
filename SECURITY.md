# Security policy

AgentGuard has two parts that could be attacked: the **service** (`server/`, which reads public GitHub repositories, public
websites and profiles that people paste) and the **site** (a static React app). The game itself is a simulation and runs in
your browser.

## Reporting a vulnerability

Please report it **privately**, not in a public issue.

- Use GitHub's **Report a vulnerability** button on the repository's *Security* tab (private vulnerability reporting).
  The maintainers must have switched this on in the repository settings; if the button is missing, open an issue that
  says only "I have a security report" and no details, and a maintainer will reply with a private channel.
- Say what you found, how to reproduce it, and what you think the impact is. A short proof is enough. Please do not
  access data that is not yours.

We aim to acknowledge a report within **7 days**. This is a student project built for a community event: there is no
bug bounty and no guaranteed fix time, but reports are taken seriously and credited if you wish.

## What is in scope

| Area | Examples |
|---|---|
| Fetching | Any way to make the service reach a private or internal address (private ranges, cloud metadata, redirects, DNS rebinding, IP spellings, other ports), or to reach a **different site** than the one a user named. Repositories may only reach `api.github.com` / `codeload.github.com`; websites may only reach the named site and its `www.` twin, on port 80 or 443. The policy is in `server/guardscan/guard/netpolicy.py` and `server/guardscan/tools/web.py`. |
| Hostile pages | A page or pasted text that makes the service slow, use a lot of memory, or run for long (very large or deeply nested pages, regex-heavy text, a server that sends bytes slowly). Every request has a total time limit and a size cap, and CPU-heavy steps run in a thread. |
| Hammering a site | A way to make the service send more requests to one website than its limits allow (a few runs per site per hour, about eleven requests per run). |
| Reading | A crafted archive that escapes memory or size limits, writes to disk, or runs code (the scanner reads archives in memory and never executes anything from a repository). |
| Prompt injection | Text in a scanned repository that changes what the scanner or the language model does. Such text is data. The detector and the guards are in `server/guardscan/guard/`. |
| Leaks | A secret from a scanned repository appearing unmasked in a report, a log line or a prompt. |
| The service | Rate-limit or budget bypass, missing security headers, the test-only source directory working in production. |

Out of scope: findings about third-party repositories that someone scanned with the tool (report those to *that*
project, privately, through its own `SECURITY.md`), and denial of service by sheer traffic.

## If AgentGuard visited your website

The service identifies itself as `AgentGuardBot` and reads `robots.txt` first. If you do not want it to read your site, add
`User-agent: AgentGuardBot` / `Disallow: /` to `robots.txt`, and it will stop. It makes a few ordinary GET requests per run
(the home page, up to five linked pages, `robots.txt`, `sitemap.xml`, `/.well-known/security.txt`, and the plain-http address), submits nothing,
runs no scripts, and stores nothing. If it did something else, please report it.

## How AgentGuard treats the repositories it scans

- It reads files and **never runs them**: no install, no build, no code execution.
- Everything read from a repository is **data**. Instructions found in it are not followed, and they are reported as a
  finding.
- Only masked, short excerpts are sent to a language model, and only when a key is configured: to Gemini, and, only if the operator configured
  one (`AI_API_KEY`), to a backup provider when no Gemini model answers. The interface says when the backup wrote the text. For a pasted profile,
  contact details are replaced first. A search server (optional) only ever receives a site's own name or the role a person typed.
- A website's `sitemap.xml` is read with plain string scanning (no XML parser, so no entity expansion), capped at 1 MB and 50,000 addresses.
  Besides the home page and up to five linked pages, up to three pages that the sitemap itself lists, and the first child of a sitemap index,
  are opened as a spot check: same site only, robots.txt obeyed, GET only.
- LinkedIn and other logged-in sites are never fetched. A person pastes their own text, or chooses their own LinkedIn "Get a copy of
  your data" ZIP, which is **read in the browser and never uploaded**: only a short list of CSV files is decompressed (with size and
  count limits against a zip bomb), the address, birth date, zip code, maiden name and email addresses are dropped, and the server
  receives only the profile text and one line of activity numbers (`activity`), which it cleans and treats as untrusted data.
- Every scan is in *third-party mode*: findings explain what and where, without attack steps, and secrets are masked.
  Do not publish findings about repositories you do not own. Tell the maintainers privately.

## Supported versions

Only the latest commit on the default branch.
