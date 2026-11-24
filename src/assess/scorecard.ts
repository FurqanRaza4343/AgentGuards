import type { AFinding, AssessKind, AssessReport } from './types';

/**
 * A scorecard turns the findings of a report into one number and a checklist: "your site's search health is 62 out of 100,
 * and these are the things that cost you points". It is computed here, in the browser, from the findings that the page already
 * has (so a LinkedIn export that was read in the browser counts too). The server only sends `facts`: short words for a check that passes.
 *
 * A check is `fail` when a finding of medium severity or more matches it, `warn` when only a low one does, and `pass` otherwise.
 * Its points shrink with every finding that matches it (a high one takes all of them, a medium one 60%, a low one 30%), so fixing
 * one of two problems in the same check still raises the score. A check that could not run (no robots.txt was fetched, no export
 * was given) is `skip` and does not count for or against.
 */
export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface ScoreCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  weight: number;
  /** the share of the weight that this check keeps, from 0 to 1 */
  credit: number;
}

export type Verdict = 'Strong' | 'Good' | 'Needs work' | 'Weak';

export interface Scorecard {
  title: string;
  caption: string;
  score: number;
  verdict: Verdict;
  checks: ScoreCheck[];
}

interface Def {
  id: string;
  label: string;
  weight: number;
  /** rule ids that cost points. A trailing * matches a whole family. */
  rules: string[];
  /** words for a pass when the server sent no fact for it */
  pass: string;
  /** the check passes only when a fact (or an extra fact) says it ran. Without one it is skipped. */
  needsFact?: boolean;
  /** an info finding also counts, as a warning */
  warnOnInfo?: boolean;
}

export const SITE_CHECKS: Def[] = [
  { id: 'https', label: 'Secure connection (https)', weight: 6, rules: ['web.https.no-redirect', 'web.tls.*', 'web.mixed-content.*'], pass: 'The site is served over https' },
  { id: 'robots', label: 'robots.txt', weight: 8, rules: ['seo.robots.missing', 'seo.robots.blocks-assets', 'seo.robots.no-sitemap', 'seo.robots.sitemap-host', 'web.robots.sensitive'], pass: 'robots.txt is in order', needsFact: true },
  { id: 'sitemap', label: 'sitemap.xml', weight: 12, rules: ['seo.sitemap.*'], pass: 'The sitemap lists your pages', needsFact: true },
  { id: 'title', label: 'Page titles', weight: 10, rules: ['seo.title.*'], pass: 'Titles are set' },
  { id: 'description', label: 'Page descriptions', weight: 8, rules: ['seo.description.*'], pass: 'Descriptions are set' },
  { id: 'h1', label: 'Main heading (H1)', weight: 6, rules: ['seo.h1.*'], pass: 'One main heading' },
  { id: 'viewport', label: 'Works on phones', weight: 6, rules: ['seo.viewport.missing'], pass: 'Set for phones' },
  { id: 'canonical', label: 'Canonical address', weight: 6, rules: ['seo.canonical.*'], pass: 'A canonical address is set' },
  { id: 'indexable', label: 'Allowed to appear in search', weight: 10, rules: ['seo.noindex', 'seo.x-robots-noindex'], pass: 'Pages may be listed by search engines' },
  { id: 'social', label: 'Share preview (Open Graph)', weight: 5, rules: ['seo.social-preview', 'seo.og.incomplete'], pass: 'Shared links get a preview' },
  { id: 'structured', label: 'Structured data', weight: 4, rules: ['seo.structured-data'], pass: 'JSON-LD found', warnOnInfo: true },
  { id: 'alt', label: 'Image descriptions (alt text)', weight: 5, rules: ['a11y.img-alt'], pass: 'Images are described' },
  { id: 'lang', label: 'Page language', weight: 3, rules: ['a11y.lang.missing'], pass: 'The language is set' },
  { id: 'depth', label: 'Enough content, light pages', weight: 5, rules: ['content.thin', 'content.weight'], pass: 'The home page says enough' },
  { id: 'links', label: 'Links that work', weight: 6, rules: ['content.broken-links'], pass: 'No broken links on the pages read' },
];

/** The second card of a website: how well it protects the people who use it. */
export const SECURITY_CHECKS: Def[] = [
  { id: 'tls', label: 'Certificate and https', weight: 12, rules: ['web.https.no-redirect', 'web.tls.*'], pass: 'The certificate is valid and http moves to https' },
  { id: 'hsts', label: 'HSTS', weight: 8, rules: ['web.hsts.*'], pass: 'The browser is told to always use https' },
  { id: 'csp', label: 'Content-Security-Policy', weight: 14, rules: ['web.csp.*'], pass: 'A content security policy is set' },
  { id: 'headers', label: 'Other protective headers', weight: 8, rules: ['web.framing.missing', 'web.nosniff.missing', 'web.referrer.missing', 'web.cors.wildcard'], pass: 'Framing, sniffing and referrer rules are set' },
  { id: 'cookies', label: 'Cookies', weight: 10, rules: ['web.cookie.*'], pass: 'Cookies are Secure, HttpOnly and SameSite' },
  { id: 'forms', label: 'Forms', weight: 10, rules: ['web.form.*'], pass: 'No form sends a password the unsafe way' },
  { id: 'leaks', label: 'Secrets and leaks', weight: 14, rules: ['web.secret-in-source', 'web.comment.leak', 'web.comment.note', 'web.internal-address', 'web.banner.version'], pass: 'No secret, note or version is visible in the pages' },
  { id: 'mixed', label: 'Scripts and mixed content', weight: 8, rules: ['web.mixed-content.*', 'web.sri.missing'], pass: 'Everything loads safely' },
  { id: 'aitext', label: 'No text aimed at AI readers', weight: 8, rules: ['web.ai-instructions'], pass: 'None found' },
  { id: 'contact', label: 'Ways to report a problem', weight: 8, rules: ['web.security-txt.missing', 'web.robots.sensitive', 'web.third-parties'], pass: 'security.txt and robots.txt are in order' },
];

export const PROFILE_CHECKS: Def[] = [
  { id: 'headline', label: 'Headline', weight: 14, rules: ['profile.headline.*'], pass: 'The headline says what you do' },
  { id: 'about', label: 'About section', weight: 14, rules: ['profile.about.*', 'profile.buzzwords'], pass: 'The About section is clear' },
  { id: 'experience', label: 'Experience', weight: 14, rules: ['profile.experience.*', 'profile.verbs.weak'], pass: 'Experience is described' },
  { id: 'proof', label: 'Numbers and proof', weight: 12, rules: ['profile.impact.numbers', 'profile.proof.missing'], pass: 'Results are backed by facts' },
  { id: 'skills', label: 'Skills and keywords', weight: 8, rules: ['profile.skills.*', 'profile.keywords.gap'], pass: 'Skills are listed' },
  { id: 'education', label: 'Education', weight: 2, rules: ['profile.education.missing'], pass: 'Education is listed' },
  { id: 'privacy', label: 'Private details hidden', weight: 14, rules: ['profile.phone', 'profile.email', 'profile.address', 'profile.birthdate', 'profile.id-number', 'profile.secret', 'profile.contact-bait', 'profile.shortlink'], pass: 'Nothing private is exposed' },
  { id: 'aitext', label: 'No text aimed at AI screeners', weight: 2, rules: ['profile.ai-instructions'], pass: 'None found' },
  { id: 'url', label: 'Custom profile address', weight: 4, rules: ['profile.url.*'], pass: 'Your public address is a custom one', needsFact: true },
  { id: 'activity', label: 'Posting rhythm', weight: 8, rules: ['profile.activity.*'], pass: 'You post regularly', needsFact: true },
  { id: 'certs', label: 'Certifications', weight: 6, rules: ['profile.certs.*'], pass: 'Certifications are listed', needsFact: true },
  { id: 'recs', label: 'Recommendations', weight: 2, rules: ['profile.recommendations.*'], pass: 'You have recommendations', needsFact: true },
];

const matches = (rule: string, patterns: string[]) => patterns.some((p) => (p.endsWith('*') ? rule.startsWith(p.slice(0, -1)) : rule === p));
const RANK: Record<AFinding['severity'], number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
/** How much of a check's points one finding takes away. */
const PENALTY: Record<AFinding['severity'], number> = { critical: 1, high: 1, medium: 0.6, low: 0.3, info: 0.15 };

export function verdictOf(score: number): Verdict {
  return score >= 85 ? 'Strong' : score >= 70 ? 'Good' : score >= 50 ? 'Needs work' : 'Weak';
}

function evaluate(def: Def, findings: AFinding[], facts: Record<string, string>): ScoreCheck {
  const hit = findings
    .filter((f) => matches(f.rule, def.rules) && (f.severity !== 'info' || def.warnOnInfo))
    .sort((a, b) => RANK[a.severity] - RANK[b.severity]);
  const base = { id: def.id, label: def.label, weight: def.weight };
  if (hit.length > 0) {
    const worst = hit[0];
    const status: CheckStatus = RANK[worst.severity] <= RANK.medium ? 'fail' : 'warn';
    const credit = Math.max(0, 1 - hit.reduce((n, f) => n + PENALTY[f.severity], 0));
    return { ...base, status, credit, detail: hit.length > 1 ? `${worst.title} (and ${hit.length - 1} more)` : worst.title };
  }
  const fact = facts[def.id];
  if (def.needsFact && !fact) return { ...base, status: 'skip', credit: 0, detail: 'Not checked this time' };
  return { ...base, status: 'pass', credit: 1, detail: fact || def.pass };
}

function card(title: string, caption: string, defs: Def[], findings: AFinding[], facts: Record<string, string>): Scorecard {
  const checks = defs.map((d) => evaluate(d, findings, facts));
  const live = checks.filter((c) => c.status !== 'skip');
  const total = live.reduce((n, c) => n + c.weight, 0);
  const got = live.reduce((n, c) => n + c.weight * c.credit, 0);
  const score = total === 0 ? 0 : Math.round((got / total) * 100);
  return { title, caption, score, verdict: verdictOf(score), checks };
}

/** A website has two cards (how findable it is, and how safe), a profile has one. `facts` come from the server and from the page itself. */
export function buildScorecards(kind: AssessKind, findings: AFinding[], facts: Record<string, string> = {}): Scorecard[] {
  if (kind === 'profile') {
    return [card('Profile strength', 'How clearly the profile shows who you are, from the text and the numbers it was given.', PROFILE_CHECKS, findings, facts)];
  }
  return [
    card('Search health', 'How easy the site is to find and how well it is put together, from the pages the crew read.', SITE_CHECKS, findings, facts),
    card('Security health', 'How well the site protects the people who use it: headers, cookies, forms and what the pages give away.', SECURITY_CHECKS, findings, facts),
  ];
}

/** The first card: Search health for a website, Profile strength for a profile. */
export function buildScorecard(kind: AssessKind, findings: AFinding[], facts: Record<string, string> = {}): Scorecard {
  return buildScorecards(kind, findings, facts)[0];
}

export const scorecardsOf = (r: AssessReport): Scorecard[] => buildScorecards(r.kind, r.findings, r.facts);
export const scorecardOf = (r: AssessReport, extraFacts: Record<string, string> = {}): Scorecard => buildScorecard(r.kind, r.findings, { ...r.facts, ...extraFacts });

/** What would each score be if the player fixed the findings at these ids? One number per card. Used by the fix list at the end of a mission. */
export function scoresAfterFixing(r: AssessReport, fixedIds: Iterable<string>): number[] {
  const fixed = new Set(fixedIds);
  return buildScorecards(r.kind, r.findings.filter((f) => !fixed.has(f.id)), r.facts).map((c) => c.score);
}

export function scoreAfterFixing(r: AssessReport, fixedIds: Iterable<string>, extraFacts: Record<string, string> = {}): number {
  const fixed = new Set(fixedIds);
  return buildScorecard(r.kind, r.findings.filter((f) => !fixed.has(f.id)), { ...r.facts, ...extraFacts }).score;
}
