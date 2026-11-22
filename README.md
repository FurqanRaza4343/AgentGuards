# AgentGuard

A game that teaches **AI agent safety**, and a crew of agents that reads **your own repository, website or profile** and
turns what it finds into missions, questions and rewrites.

You supervise AI agents. Each time one asks for permission you inspect the evidence, find the red flags, and decide:
allow, block, audit, ask a human, or find a safer way to get the job done. Then you see the consequence and the lesson.

Built for **DevFest Pakistan 2026** (GDG Live Pakistan). The seven levels are a simulation: no real systems, data or
network calls. The look comes from the Nova landing-page theme (paper-white, grid lines, four colourways of a 3D ceramic
robot built entirely in three.js).

**Live: https://agentguard.185-183-54-184.sslip.io** (deployed with Docker on a VPS behind Caddy and HTTPS; see [deploy/](deploy/README.md)).
It is a public demo with limits: a few runs per visitor per hour, a few per website per hour, and a daily cap on model calls.
When Gemini's free quota is used up the questions come from templates, and the recorded demos always work.

Three things to do with it:

| | What it is | Needs |
|---|---|---|
| **The campaign** | 7 hand-written levels about phishing, MCP tools, A2A, sandboxing, SSRF and more | Just the browser |
| **Your repository** | Paste a public GitHub repository. A scanner reads it, finds secrets, risky workflows, unsafe code, exposed tool servers and known-vulnerable dependencies, and your coding agent's next pull request becomes a **mission built from your real lines**, with real line numbers | The scanner in `server/` (or the pre-baked demo) |
| **Your website or profile** | **Nova, the orchestrator,** sends three specialists to read a public website (or the text of a profile you paste) at the same time. They report back, and Nova asks the **questions** that would make it better and suggests **rewrites** | The scanner, and optionally a Gemini key and a SearXNG server (or the pre-baked demos) |

## The Orchestrator: your website and your profile

Nova (agent 1) is the lead. It reads the request, sends **one task to each of three robots**, and when they come back it
turns what they found into questions for you. The robots are the same 3D agents as in the game, and the stage shows what
is really happening: a cyan packet flies from Nova to a robot when it hands out a task, a green one flies back with the
result, a purple one passes work from robot to robot (the Scraper hands the home page to Security and the pages to Content).
Each robot's face shows its state (thinking, working, found problems, done) and a caption under its pedestal says what it is doing.

| Robot | Website | Profile you paste |
|---|---|---|
| **Scraper / Reader** (DataRetriever) | Reads robots.txt, the home page and up to five linked pages, the sitemap, broken links | Splits the text into headline, About, experience, skills and says what is missing |
| **Security / Privacy** (PurchasingAgent) | Headers, cookies, certificate, plain-http redirect, security.txt, mixed content, forms, secrets and notes in the page source, text written for AI readers | Phone, email, ID numbers, address, shortened links, secrets, text aimed at AI screening tools |
| **Content / Impact** (FinanceAgent) | Titles, descriptions, headings, phones, accessibility, thin content, search visibility | Headline, About, numbers and results, buzzwords, keywords that hiring pages mention |

What you get: a report grouped by severity with *what it means and how to fix it*, **5 to 8 questions** from Nova ("Which of
your claims could a stranger check, and what fact proves each one?"), **3 to 5 rewrites** ("Now: Passionate software developer
seeking opportunities. Try: Backend Engineer | Building scalable APIs with Python..."), and a list of what is already good.

Where the lines are drawn:

- **Websites are read passively and politely:** a few ordinary page requests, robots.txt first and obeyed, no forms submitted,
  no scripts run, no hidden paths guessed, a redirect to another site refused, one site read only a few times an hour.
  Findings explain what and why, never attack steps. If you find a real problem on a site that is not yours, tell its owner privately.
- **LinkedIn is not scraped.** It forbids automated collection and needs a login. You paste your own text; nothing is fetched.
  Contact details are replaced before any excerpt goes to a language model.
- **Gemini writes the questions, and every answer is checked** (ids must exist, quotes must be in your own text, links and
  commands are removed, text that talks to an AI reader is dropped). Without a key, templates write the questions from the same findings.
- **Search is optional** (SearXNG, `SEARXNG_URL`). Only the site's name or the role you typed ever leaves the server.

**Try it with no setup:** open the site, choose **Analyse yours**, pick *Website* or *Profile* and press **Play the demo (no network)**.
It replays a recorded run (the planted demo bakery site and a fictional profile) with questions written by Gemini.

## Your repository

1. **Scout** checks the address. **Retriever** downloads one archive from GitHub. **Auditor** runs about thirty rules and
   asks OSV.dev about dependencies. **Coach** writes the explanations (Gemini through Google ADK, optional). The four
   robots on the stage are these four stages, and a **Guard** layer watches all of them.
2. You get a **report** (what, where, how bad, how to fix) that you can copy as a summary. It never contains the
   evidence lines, and secrets are masked.
3. You can **play the report**. Each finding becomes a step: the coding agent wants to merge a change, you see the real
   lines in a code window, find the red flags, and decide. Look-alike lines that are provably safe become the decoys,
   and safe patterns become legitimate requests that you must not over-block.

Where the lines are drawn (the full list is in [server/README.md](server/README.md)):

- The scanner **only reads**. It never installs, builds or runs anything from a repository.
- Text inside a scanned repository is **data**. Instructions aimed at an AI reader (hidden in a README, an AGENTS.md or a
  tool description) are never followed. They are stripped before a model sees the file, and reported as a finding.
- The language model writes **prose only**. Line numbers, ids, severities, points and options come from code, and the
  game checks every generated mission with the same invariants as the hand-written levels (best path reaches Guardian;
  blocking everything or allowing everything never does).
- Every scan is in **third-party mode**: findings explain what and where, without attack steps. If you find something
  real in a repository that is not yours, tell its maintainers privately.
- Only GitHub hosts are reachable, through one network policy that also checks DNS answers and redirects.

The design borrows several ideas from the Obscura project (see [NOTICE](NOTICE)). No code was copied, and its
stealth features were deliberately left out.

**Try it with no setup:** open the site, choose **Analyse yours**, then **Play the demo (no network)**. It replays a report
that was baked from a planted demo repository (one issue per category, with a fake key that is assembled at run time).

## The campaign

Seven levels, four agents, about 30 minutes for the whole thing.

| # | Level | Agent(s) | What you learn |
|---|---|---|---|
| 1 | The suspicious email | Nova | Phishing links, and prompt injection hidden in an email |
| 2 | The payroll query | DataRetriever | Least privilege with an MCP database server, and data leaving the company |
| 3 | The urgent purchase | PurchasingAgent + FinanceAgent | One misled agent misleading the next over A2A, and verifying through a second channel |
| 4 | The cleanup script | DataRetriever | Sandboxing: an empty variable in `rm -rf`, and `curl ... \| bash` |
| 5 | The new tool | Nova | Poisoned MCP tools, and over-blocking a tool that is fine |
| 6 | Friday, 5 pm | all four | The final shift: five requests, two of them legitimate |
| 7 | The headless browser | Nova | SSRF to the cloud metadata address, an exposed control port, and bypassing a site's "no bots" rule |

### How a level plays

1. **Briefing.** Which agents, what they may touch, which ideas the level teaches.
2. **Simulation.** The agent "works" and a console log fills in (every level says `[SIMULATION]`).
3. **Inspect.** The agent is waiting and tells you what it wants ("Boss, this looks urgent..."). The **Evidence** tab
   shows what it is looking at as a small window: an email, an SQL query, a shell, a chat between agents, a payment, a
   tool manifest, a web page, or (in Live missions) source code with line numbers. Click anything suspicious. You can
   check **3 things per step**, and real red flags look just like harmless decoys until you check them. Some text is
   hidden from people (faint), but not from an AI.
4. **Decide.** Keys `1`-`4`. Allow, block, ask a human, a safer alternative, or **Audit** (2 tokens per level):
   it reveals everything and unlocks a better option, and you decide again.
5. **Outcome.** What happened, the lesson, and your points.
6. **Debrief.** Per decision: what you chose, what the red flags were, and *"what if you had allowed it?"*.

### Scoring: safety versus work

Every choice earns **Safety** points (negative when it leads to harm) and **Work** points (how much of the job still got
done). You also earn bonus points for each real red flag you found yourself.

- Allowing a threat costs a lot of safety. Blocking everything is safe but earns almost no work, so it never reaches Guardian.
- Some requests are **legitimate** (a colleague's invite, a verified tool, a small refund inside policy). Blocking those
  is *over-blocking*: safe, but nothing gets done.
- Rating is the share of the maximum: Guardian 80% and above, Cautious 50%, otherwise At risk. Stars follow the rating.
- **Badges**: Sharp Eye, Flawless, Least Privilege, Safe Hands, Human in the Loop, Not Paranoid, Guardian.
- Progress, stars and badges are kept in `localStorage`. A **Field guide** explains every idea in plain language and every
  level links to its concepts. Quiet synthesised sound effects, with a mute switch.

## Run it

**The easiest way: Docker.** One command starts the site, the service and a private SearXNG for the search checks:

```bash
cp .env.example .env            # then set SEARXNG_SECRET (any long random value); GEMINI_API_KEY is optional
docker compose up -d --build    # if your .env is in the folder above:  docker compose --env-file ../.env up -d --build
# open http://127.0.0.1:8080    (#site for a website, #profile for a profile, #analyze for a repository)
docker compose down             # stop it
```

The container runs as a non-root user with a read-only filesystem, and both ports are published on 127.0.0.1 only. Starting takes
about 40 seconds (the model library is slow to import). Without a Gemini key, or when its free quota runs out, the questions come
from templates.

**Without Docker** (to work on the code):

```bash
npm install
npm run dev          # http://127.0.0.1:5173  (the campaign and the demo work with just this)
npm test             # 212 tests: scenarios, reducer, scoring, mission builder, validator, the Python report contracts
npm run build        # type-check + production build into dist/
npm run preview      # production build on http://127.0.0.1:4173 with the same strict CSP as the scanner serves
```

For real runs, start the scanner in a second terminal (Python 3.11 or newer; the Vite dev server proxies `/api` to it):

```bash
cd server
python -m venv .venv
.venv/Scripts/pip install -r requirements-dev.txt        # .venv/bin/pip on Linux and macOS
.venv/Scripts/python -m pytest                           # 400 tests, no network and no key needed
.venv/Scripts/python -m uvicorn guardscan.api:app --host 127.0.0.1 --port 8000
```

Copy `.env.example` to `.env` and set `GEMINI_API_KEY` (a second key in `GEMINI_API_KEY2` is a fallback) to let Gemini write
the questions and explanations; without it templates do. Set `SEARXNG_URL` to turn the search checks on
(`docker compose --env-file .env -f searxng/docker-compose.yml up -d` starts a private SearXNG, run and tested on 2026-11-22;
put a random `SEARXNG_SECRET` in `.env` first). The `.env` is read from the
project folder or up to four folders above it, and is never committed.

Visual and end-to-end checks. They use the Chrome you already have (no browser download):

```bash
npm run dev                                   # in one terminal
npm run shoot -- shots http://127.0.0.1:5173  # plays all seven levels on the best path, checks each ends as Guardian,
                                              # plus inspects, audits, badges, the field guide and mobile
node tools/e2e-live.mjs shots-live            # starts the real scanner and the site itself, scans the planted demo
                                              # repository, plays a generated mission, and checks what must be refused
node tools/e2e-assess.mjs shots-assess        # the Orchestrator: a planted website over real HTTP, a pasted profile, a stand-in
                                              # search server, live Gemini if a key is set; checks that the three specialists work
                                              # at the same time and that only the role reaches the search server
```

## The agents

Four colourways of one robot design, matching the artwork in `agents_Details/`:

| Agent | Colourway | Role in a scan |
|---|---|---|
| Nova | white, black joints, orange to pink ring | Scout |
| DataRetriever | white, navy joints, cyan ring | Retriever |
| PurchasingAgent | silver, purple joints, lavender ring | Auditor |
| FinanceAgent | black shell, mint joints and ring | Coach |

They share one set of states (`idle, thinking, working, alert, success, fail`) and react to the game: typing posture while
working, a red face and a "stop" hand when asked to do something unsafe, a cheer when you get it right, a slump and
`x x` eyes when it goes wrong. Two agents face each other with a message packet flying along the A2A link, and the final
shift puts all four on stage.

**About the sample FBX/GLB files.** The two samples supplied (agents 1 and 2) are single static meshes: no skeleton, no
animation, about 290,000 triangles and 11 MB each, with the eyes baked into the texture. They cannot change expression or
move their arms, so the game uses the procedural robot, which is fully animated, loads instantly and matches the art.
`inspect.html` (dev only, not part of the build) opens any GLB/FBX and reports triangles, bones and clips:
`http://127.0.0.1:5173/inspect.html?file=/@fs/D:/path/to/model.glb&yaw=0`.

## Structure

```
index.html  inspect.html (dev only)  vite.config.ts  tsconfig.json  Dockerfile  .env.example
AGENTS.md  SECURITY.md  NOTICE  skills/agentguard/SKILL.md  .agentguard-ignore  .github/  searxng/  deploy/  docker-compose.yml
public/                  fonts, models, demo-report.json, demo-site-report.json, demo-profile-report.json (baked by the scanner)
src/
  agents.ts              the four agents: names, roles, tools, colour skins
  App.tsx                landing | game | analyze | site | profile | missions, driven by the URL hash
  styles/                fonts.css, theme.css, landing.css, game.css, live.css
  stage/                 three.js, one fixed canvas shared by landing, game and the scan screens
  landing/               the three landing sections
  game/
    types.ts             Scenario, Step, Artifact, Clue, Option, Reveal
    scenarios/           level1.ts ... level7.ts: all content is plain data
    validate.ts          the invariants, checked in tests and again at run time for generated missions
    gameReducer.ts       the state machine (pure, unit-tested)
    scoring.ts progress.ts guide.ts agentState.ts labels.ts layout.ts
    Game.tsx             wires state, stage, sound, progress; takes the scenarios to play
    ui/                  ArtifactView (incl. the code window), Panels, Cards, FieldGuide
  missions/              report types, per-category templates, buildMissions(report)
  live/                  scan client (SSE, validates what the server sends), report tools, AnalyzeView (repository)
  assess/                the Orchestrator screens: OrchestratorView, Crew (status list and the captions on the 3D stage),
                         beams, ModeTabs, the report types and their validation, the client
  lib/                   sound.ts (Web Audio), storage helpers, media-query hooks
server/                  the Python scanner: see server/README.md
tests/                   vitest: game, validate, missions, assess, demoReport (+ fixtures)
tools/                   shoot.mjs (campaign playthrough), e2e-live.mjs (repository), e2e-assess.mjs (website and profile)
```

## Adding or changing a level

Levels are data. Copy a file in `src/game/scenarios/`, edit it and add it to `scenarios/index.ts`. A step has:

- `artifact`: the window to inspect. Text can be a plain string or `{ t, clue, faint }`.
- `clues`: for each `clue` id, `flag: true` (a real red flag) or `flag: false` (a decoy), and the `note` shown when found.
- `say`: what the agent tells the player.
- `threat: false` for a legitimate request (blocking it must be `neutral`, approving it `safe`).
- `options`: each with `safety` and `work` points. An option with a `reveal` is an Audit and may `unlock` better options.

`npm test` checks every step: 2-4 options, unique ids, every clue in the text is defined and every defined clue appears,
threats have 2-3 flags and a decoy, legitimate requests have none, the best path needs no more audits than a level gives
you, and that blocking everything or allowing everything never reaches Guardian. The same checks (`validateScenario`)
run on every mission the scanner produces, and a mission that fails them is dropped.

## Deploy to Google Cloud Run

One image, one process: FastAPI serves the built site and the `/api` endpoints, so the page and the API share an origin
and the Content-Security-Policy stays `default-src 'self'`. The container runs as a non-root user.

```bash
docker build -t agentguard .
docker run --rm -p 8080:8080 --read-only --cap-drop ALL agentguard      # then open http://localhost:8080

gcloud run deploy agentguard --source . --region <REGION> --allow-unauthenticated --port 8080 \
  --set-env-vars AGENTGUARD_TRUST_PROXY=1 --set-secrets GEMINI_API_KEY=<SECRET_NAME>:latest
```

Put the key in Secret Manager, not in the image: the Docker build context excludes `.env`. The service reads websites from
Cloud Run, so keep `AGENTGUARD_ALLOW_PRIVATE_NETWORK` unset (it is for tests only) and leave the per-address and per-site
rate limits at their defaults or lower.

**Checked on 2026-11-22 with Docker Desktop:** the image builds (about 3.5 minutes, 324 MB), and runs with `--read-only
--cap-drop ALL --security-opt no-new-privileges` as user 10001 (writing to the filesystem fails, as intended). The page is
served under the strict CSP, `/api/health` reports the model and the search server, the container becomes healthy
(about 40 seconds: importing the ADK is slow), and from inside the container it analysed `example.com` on the real internet
with Gemini and the SearXNG on the host (`SEARXNG_URL=http://host.docker.internal:8888`), and a pasted profile too.
Gemini's free-tier quota ran out on a later request; the run still finished, with the questions written from templates.

**Not done yet:** nothing has been deployed to Cloud Run (no `gcloud` here), and the image is not pinned to a base-image digest.

## Accessibility

Semantic buttons with visible focus rings, number-key shortcuts, tabs with arrow-key navigation, an `aria-live` log and
notebook, meters with `role="meter"`, a focus-trapped field guide that closes with Esc, focus moves to the main control
of each screen, `prefers-reduced-motion` skips the animated log and stops shaking, hidden text appears on hover or focus, and
the layout works from 390px wide. Danger and success colours are separate from the brand pink. Not yet tested with a
screen reader.

## What is not done, and what comes next

- **Gemini was run for real on 2026-11-22** (the repository Coach, and Nova's questions for the planted site and profile), with
  both configured keys. The unit tests still use a fake model, so they need no key.
- **SearXNG was run for real** (Docker, image pinned by digest): JSON search returned results, a site's name and a job role were
  searched through it, and a skill gap was computed from the real snippets (which are short, so the count is shown next to each
  skill: "api (4 of 40)"). `tools/e2e-assess.mjs` still uses a stand-in server, so that test needs no Docker.
- **Gemini's free-tier quota is small.** When it runs out (or the model is overloaded) the run falls back to templates, and the
  pre-baked demos keep working. A second key in `GEMINI_API_KEY2` is tried automatically.
- **Only one real website has been scanned** (`example.com`). Scan your own and read the result with a critical eye: the checks
  are heuristics.
- **Missions from website and profile findings** are not built yet. The repository findings become playable missions; website
  and profile findings become the report, the questions and the rewrites.
- **Not built, by design for this version:** proof of site ownership, a PDF upload for profiles (paste the text instead),
  answering Nova's questions in the page and getting feedback on the answer, private repositories through a GitHub App, and a
  hardened `agentguard mcp` tool server for coding agents.
- **Urdu and Roman Urdu** for the interface and the Field Guide (right-to-left layout), plus a teacher mode with a shareable link.
- **Red Team mode**: play the attacker against a deliberately weak, rule-based agent, then switch sides.
- **Scenario editor** and share-by-link, so teachers can write their own levels.

## Notes

- Google logos are not used. The brand, agents, vendors and email addresses in the scenarios are fictional (`.example` domains).
- The personas on the landing page (Sara, Ali, Nida) come from the project brief. They are personas, not customer quotes.
- Nothing in the game is an attack recipe: scenarios describe what to look for and what to do.
- Report security problems privately: see [SECURITY.md](SECURITY.md).
