import { Brk, Icon } from '../components/ui';

/** Sections 4 to 7 of the landing page. They sit in the normal page flow, below the three full-screen sections. */

interface Source {
  id: string;
  hash: string;
  tag: string;
  title: string;
  lead: string;
  reads: string;
  finds: string;
  never: string;
  game: string;
  cta: string;
}

const SOURCES: Source[] = [
  {
    id: 'repo',
    hash: '#analyze',
    tag: 'Repository',
    title: 'A public GitHub repository',
    lead: 'Paste a link. The crew reads the files and finds what an AI agent should never merge without you.',
    reads: 'The archive of a public repo, in memory. Nothing is installed, built or run.',
    finds: 'Leaked keys, risky workflows and containers, vulnerable dependencies, and instructions written for AI readers.',
    never: 'It never executes a line of your code.',
    game: 'Each mission quotes one of your own lines: merge it, block it, or ask a human?',
    cta: 'Scan a repository',
  },
  {
    id: 'site',
    hash: '#site',
    tag: 'Website',
    title: 'A website address',
    lead: 'Type an address. The crew reads the public pages once, politely, the way a search engine would.',
    reads: 'The home page and a few pages it links to, after robots.txt. GET requests only.',
    finds: 'Missing security headers, unsafe cookies and forms, leaked comments, weak titles, thin pages, and hidden text aimed at AI readers.',
    never: 'It never logs in, sends a form, runs a script, or guesses at hidden paths.',
    game: 'Each mission is a change the web agent is about to publish: approve it or stop it?',
    cta: 'Check a website',
  },
  {
    id: 'profile',
    hash: '#profile',
    tag: 'LinkedIn and CV',
    title: 'Your own profile',
    lead: 'Use your LinkedIn data export, or paste your text. You get your posts per month, your certifications and what to improve.',
    reads: 'The ZIP that LinkedIn gives you (“Get a copy of your data”), opened in your browser. It is not uploaded.',
    finds: 'How often you post, how many certifications you hold, a vague headline, weak verbs, missing numbers, and personal details you should hide.',
    never: 'It never scrapes LinkedIn. LinkedIn forbids that, and your profile is yours to share, not ours to take.',
    game: 'Each mission is a line the profile agent is about to post: post it, or fix it first?',
    cta: 'Review a profile',
  },
];

function Head({ n, tag, children }: { n: string; tag: string; children: React.ReactNode }) {
  return (
    <header className="shead">
      <p className="stag rv">
        <span className="rnum brk">
          {n}
          <Brk />
        </span>
        <span>{tag}</span>
      </p>
      <h2 className="sh rv d1">{children}</h2>
    </header>
  );
}

/** 4 · three things to analyse, three different games */
export function Analyse() {
  return (
    <div className="wrap">
      <Head n="04" tag="Analyse yours">
        Three kinds of thing.
        <br />
        <span className="sh-dim">Three different games.</span>
      </Head>
      <ul className="cards">
        {SOURCES.map((s, i) => (
          <li key={s.id} className={`src brk rv d${i + 1}`}>
            <p className="src-tag">{s.tag}</p>
            <h3>{s.title}</h3>
            <p className="src-lead">{s.lead}</p>
            <dl>
              <dt>Reads</dt>
              <dd>{s.reads}</dd>
              <dt>Finds</dt>
              <dd>{s.finds}</dd>
              <dt>Never</dt>
              <dd>{s.never}</dd>
              <dt>Game</dt>
              <dd>{s.game}</dd>
            </dl>
            <a className="src-cta" href={s.hash}>
              {s.cta} <Icon name="ne" />
            </a>
            <Brk />
          </li>
        ))}
      </ul>
    </div>
  );
}

const STEPS = [
  { n: '01', who: 'Nova', role: 'Lead', text: 'Reads your request, gives each specialist a job, and later writes the questions and the rewrites.' },
  { n: '02', who: 'The specialists', role: 'Three in parallel', text: 'One reads the content, one checks the security, one checks how it looks to search engines or recruiters. Each works alone.' },
  { n: '03', who: 'The checks', role: 'Plain code', text: 'Line numbers, severities and points come from rules, not from a model. Anything the model writes is checked against your own text.' },
  { n: '04', who: 'You', role: 'Final say', text: 'Read the report, copy an issue, or play the missions built from your own material and decide like the agent’s supervisor.' },
];

/** 5 · how the crew works */
export function Crew() {
  return (
    <div className="wrap">
      <Head n="05" tag="How it works">
        A lead and three specialists.
        <br />
        <span className="sh-dim">You decide.</span>
      </Head>
      <ol className="steps">
        {STEPS.map((s, i) => (
          <li key={s.n} className={`step rv d${i + 1}`}>
            <span className="step-n">{s.n}</span>
            <h3>{s.who}</h3>
            <p className="step-role">{s.role}</p>
            <p>{s.text}</p>
          </li>
        ))}
      </ol>
      <p className="swide rv d2">
        The AI only writes words. Line numbers, ids, severities, points and options are computed by code, and a test checks that blocking everything or allowing everything never wins the game.
      </p>
    </div>
  );
}

const WILL = [
  'Reads public things, once, and obeys robots.txt.',
  'Opens your LinkedIn export in your own browser. The file is not uploaded.',
  'Shows the evidence for every finding: the exact line, quoted.',
  'Marks what the backup language model wrote, if Gemini is busy. It is never passed off as Gemini.',
];
const WONT = [
  'Scrape LinkedIn, or any page that asks not to be read.',
  'Run, install or build code from a repository.',
  'Log in, send forms, or hide who it is. There is no stealth mode.',
  'Keep your text. Reports live in your tab, and a repository is read in memory.',
];

/** 6 · what it does and what it will not do */
export function Trust() {
  return (
    <div className="wrap">
      <Head n="06" tag="Trust and limits">
        Built to be safe to point at things.
        <br />
        <span className="sh-dim">Here is where it stops.</span>
      </Head>
      <div className="duo">
        <section className="duo-col rv d1" aria-label="What AgentGuard does">
          <h3>It does</h3>
          <ul className="ticks">
            {WILL.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </section>
        <section className="duo-col wont rv d2" aria-label="What AgentGuard will not do">
          <h3>It will not</h3>
          <ul className="ticks">
            {WONT.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </section>
      </div>
      <p className="swide rv d3">
        Text from a repository, a website or a profile is treated as data, never as instructions. If it tries to talk to the AI reader, that becomes a finding.
      </p>
    </div>
  );
}

const FAQ = [
  {
    q: 'Why can I not paste my LinkedIn link?',
    a: 'LinkedIn forbids automated reading of its pages, shows a sign-in wall to programs, and blocks servers. A tool that tried would break the rules and still get nothing useful. Your own data export is allowed, and it holds more than the page shows: the date of every post and every certification.',
  },
  {
    q: 'How do I get my LinkedIn data?',
    a: 'On LinkedIn open Settings and Privacy, then Data privacy, then “Get a copy of your data”. Pick Profile, Positions, Skills, Certifications, Shares and Recommendations, and request the archive. LinkedIn emails you a link. Choose the ZIP on the profile page. It is read in your browser.',
  },
  {
    q: 'Is my data stored anywhere?',
    a: 'No account and no database. A repository is read in memory and dropped. A website is read once. The LinkedIn ZIP never leaves your browser. For the written advice, a short summary of your text goes to a language model, and an address or birth date is removed first.',
  },
  {
    q: 'Which AI writes the advice?',
    a: 'Gemini, through the Agent Development Kit. When Gemini’s free quota runs out, a backup language model may write instead, and the report says so. The game, the scores and the line numbers do not depend on either.',
  },
  {
    q: 'Can I scan a site or repository that is not mine?',
    a: 'You can read public pages, as any visitor could. Results are shown to you only. Do not use them to attack anyone. If you find a real problem in someone else’s project, tell them privately through their security contact.',
  },
  {
    q: 'What is the game for?',
    a: 'To practise supervising an AI agent. The agent proposes an action, you read the evidence and choose: allow, block, ask a human, or request a fix. Your choices are scored, and the missions come from your own repository, site or profile.',
  },
];

/** 7 · questions */
export function Faq() {
  return (
    <div className="wrap">
      <Head n="07" tag="Questions">
        Short answers.
      </Head>
      <div className="faq rv d1">
        {FAQ.map((f) => (
          <details key={f.q}>
            <summary>
              <span>{f.q}</span>
              <span className="faq-plus" aria-hidden="true" />
            </summary>
            <p>{f.a}</p>
          </details>
        ))}
      </div>
    </div>
  );
}
