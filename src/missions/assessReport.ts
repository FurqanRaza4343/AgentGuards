import type { AFinding, Area, AssessReport } from '../assess/types';
import { buildMissions } from './buildScenarios';
import type { BuildOptions, BuildResult } from './buildScenarios';
import type { Category, Finding, Report } from './types';

/**
 * Turns the report of a website or a profile into the same shape the repository scanner produces, so that the same game
 * engine can build missions from it. Everything in a step is real: the flagged line is what the specialists found on the
 * player's own site or profile, and the safe look-alike next to it is something that really is done well there.
 */
const CATEGORY: Record<'site' | 'profile', Record<Area, Category>> = {
  site: { security: 'site-security', privacy: 'site-privacy', content: 'site-content', seo: 'site-content', accessibility: 'site-content', discoverability: 'site-content' },
  profile: { security: 'profile-security', privacy: 'profile-privacy', content: 'profile-content', seo: 'profile-content', accessibility: 'profile-content', discoverability: 'profile-content' },
};
const HEADER = { site: 'What your web agent is about to publish', profile: 'What your profile agent is about to post' };
const WHERE = { site: 'page', profile: 'section' };
const WHOLE = { site: 'the whole site', profile: 'the whole profile' };

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
const withoutScheme = (s: string) => s.replace(/^https?:\/\//, '');

/** The line to flag: the evidence as the specialist saw it, with the finding's title when the evidence alone would be cryptic. */
function flaggedLine(f: AFinding): string {
  const e = f.evidence.trim();
  if (e.length === 0) return clip(f.title, 150);
  if (e.length >= 24 || /[:=]/.test(e)) return clip(e, 150);
  return clip(`${f.title} (${e})`, 150);
}

function toFinding(f: AFinding, kind: 'site' | 'profile', decoy: string | null): Finding {
  const where = withoutScheme(f.location.split(' and ')[0] || WHOLE[kind]);
  const lines = [`# ${HEADER[kind]}`, `${WHERE[kind]}: ${clip(where, 90)}`, flaggedLine(f)];
  const decoys = [];
  if (decoy) {
    lines.push(`# already fine: ${clip(decoy, 110)}`);
    decoys.push({ start: 4, end: 4, note: `This part is already done well, so there is nothing to fix here: ${clip(decoy, 120)}` });
  } else {
    // nothing on this site or profile is done well enough to be a look-alike: the line that says where the change goes is the safe line to be tempted by
    decoys.push({ start: 2, end: 2, note: 'This only says where the change goes. Nothing is wrong with it, so checking it only costs you an inspection.' });
  }
  return {
    id: f.id,
    category: CATEGORY[kind][f.area],
    severity: f.severity,
    rule: f.rule,
    title: clip(f.title, 100),
    path: clip(where, 90),
    startLine: 3,
    endLine: 3,
    context: { startLine: 1, lines },
    flags: [{ start: 3, end: 3, note: clip(f.detail, 320) }],
    decoys,
    fix: { summary: clip(f.fix, 200) },
    evidence: f.evidence,
    owned: kind === 'profile', // a profile is the player's own text; a website's owner cannot be proven
  };
}

/** A strength becomes a legitimate request: the agent wants to leave a good thing alone, and blocking it is over-blocking. */
function toBenign(strength: string, kind: 'site' | 'profile', i: number): Finding {
  const text = clip(strength, 130);
  return {
    id: `ok${i + 1}`,
    category: kind === 'site' ? 'site-security' : 'profile-content',
    severity: 'info',
    rule: 'ok.already-good',
    title: clip(strength, 80),
    path: WHOLE[kind],
    startLine: 3,
    endLine: 3,
    context: { startLine: 1, lines: [`# ${HEADER[kind]}`, `${WHERE[kind]}: ${WHOLE[kind]}`, text, '# nothing in this part changes'] },
    flags: [{ start: 3, end: 3, note: `This is already done well, so leaving it alone is right: ${text}` }],
    decoys: [],
    benign: true,
    fix: { summary: 'Leave it as it is.' },
    evidence: text,
    owned: kind === 'profile',
  };
}

export function assessToReport(a: AssessReport): Report {
  const kind = a.kind;
  const strengths = a.strengths.filter((s) => s.trim().length >= 12);
  const real = a.findings.filter((f) => f.severity !== 'info');
  const findings = [
    ...real.map((f, i) => toFinding(f, kind, strengths.length > 0 ? strengths[i % strengths.length] : null)),
    ...strengths.slice(0, 3).map((s, i) => toBenign(s, kind, i)),
  ];
  return {
    repo: kind === 'profile' ? 'your profile' : a.target,
    commit: a.generatedAt.replace(/\D/g, '').slice(0, 12) || 'x',
    generatedAt: a.generatedAt,
    stats: { files: Math.max(1, a.stats.pages), bytes: a.stats.bytes, skipped: 0 },
    findings,
    runLog: a.runLog,
    disclaimers: a.disclaimers,
    demo: a.demo,
  };
}

/** Missions in the words of a website or a profile: a web agent that wants to publish, a profile agent that wants to post. */
export function buildAssessMissions(a: AssessReport, opts: BuildOptions = {}): BuildResult {
  return buildMissions(assessToReport(a), { ...opts, flavor: a.kind });
}
