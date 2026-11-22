import type { Clue, Option, Scenario, Span, Step } from '../game/types';
import { validateScenario } from '../game/validate';
import { WORDS } from './flavors';
import type { Flavor, Words } from './flavors';
import { ALLOW_PENALTY, SEVERITY_ORDER, TEMPLATES, categoryOf } from './templates';
import type { Category, Finding, LineRange, Report } from './types';

export type DecoyKind = 'lookalike' | 'ordinary' | 'none';

export interface BuiltStep {
  step: Step;
  decoyKind: DecoyKind;
}

export interface BuildResult {
  missions: Scenario[];
  /** why a finding or a mission was left out of the game (it stays in the report) */
  dropped: string[];
}

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'repo';
const within = (r: LineRange, first: number, last: number) => r.start >= first && r.end <= last && r.start <= r.end;
const overlaps = (a: LineRange, b: LineRange) => a.start <= b.end && b.start <= a.end;
const noteOf = (note: string, fallback: string) => {
  const n = note.trim();
  return n.length >= 20 ? n : `${n} ${fallback}`.trim();
};

/** Picks an ordinary line of the window to serve as a decoy when the scanner found no look-alike. */
function ordinaryDecoy(f: Finding, taken: LineRange[]): LineRange | null {
  const { startLine, lines } = f.context;
  let best: { n: number; len: number } | null = null;
  lines.forEach((text, i) => {
    const n = startLine + i;
    const t = text.trim();
    if (t.length < 8 || t.length > 100) return;
    if (taken.some((r) => n >= r.start && n <= r.end)) return;
    if (!best || t.length > best.len) best = { n, len: t.length };
  });
  const pick = best as { n: number; len: number } | null;
  if (!pick) return null;
  return { start: pick.n, end: pick.n, note: 'An ordinary line of this file. Nothing is wrong with it, so checking it only costs you an inspection.' };
}

/** Turns one finding into one playable step. Returns null when the finding cannot make a fair step. */
export function buildStep(f: Finding, w: Words = WORDS.repo): BuiltStep | null {
  const tpl = categoryOf(f);
  const first = f.context.startLine;
  const last = first + f.context.lines.length - 1;
  if (f.context.lines.length === 0) return null;

  const benign = Boolean(f.benign);
  // overlapping flags would fight over the same lines, so only the first of them is kept
  const flagRanges: LineRange[] = [];
  if (!benign) {
    for (const r of f.flags.filter((x) => within(x, first, last))) {
      if (flagRanges.length < 3 && !flagRanges.some((k) => overlaps(k, r))) flagRanges.push(r);
    }
  }
  let decoyRanges = f.decoys.filter((r) => within(r, first, last) && !flagRanges.some((x) => overlaps(x, r))).slice(0, benign ? 2 : 1);
  // for a legitimate request, the matched region is the safe pattern itself: it becomes a decoy
  if (benign) {
    const safe = f.flags.filter((r) => within(r, first, last)).slice(0, 2);
    decoyRanges = [...safe, ...decoyRanges].slice(0, 2);
  }
  if (!benign && flagRanges.length === 0) return null;

  let decoyKind: DecoyKind = decoyRanges.length > 0 ? 'lookalike' : 'none';
  if (!benign && decoyRanges.length === 0) {
    const ord = ordinaryDecoy(f, flagRanges);
    if (!ord) return null;
    decoyRanges = [ord];
    decoyKind = 'ordinary';
  }

  // clues, and the line -> clue map
  const clues: Clue[] = [];
  const clueAt = new Map<number, string>();
  flagRanges.forEach((r, i) => {
    const id = `f${i + 1}`;
    clues.push({ id, flag: true, note: noteOf(r.note, tpl.flagNote) });
    for (let n = r.start; n <= r.end; n++) clueAt.set(n, id);
  });
  decoyRanges.forEach((r, i) => {
    const id = `d${i + 1}`;
    clues.push({ id, flag: false, note: noteOf(r.note, 'This line looks similar but is fine.') });
    for (let n = r.start; n <= r.end; n++) if (!clueAt.has(n)) clueAt.set(n, id);
  });

  const body: Span[][] = f.context.lines.map((text, i) => {
    const id = clueAt.get(first + i);
    if (text.length === 0) return [];
    return id ? [{ t: text, clue: id }] : [text];
  });

  const meta: Step['artifact']['meta'] = [
    { k: w.metaPath, v: [f.path] },
    { k: 'Rule', v: [f.rule] },
    { k: 'Severity', v: [f.severity] },
  ];

  const prose = f.prose ?? {};
  const threat = !benign;
  const title = clip(`${w.titlePrefix}: ${f.title}`, 96);
  const situation =
    prose.situation ??
    (threat
      ? `${w.threatIntro(f)} It wants to ${tpl.want}.`
      : w.safeIntro(f));
  const say = prose.say ?? (threat ? tpl.say : w.sayBenign);

  const log: Step['log'] = [
    { text: w.logOpen(f), tone: 'system' },
    { text: w.logTool(f), tone: 'tool' },
    { text: `Rule matched: ${f.rule} (${f.severity})`, tone: threat ? 'warn' : 'info' },
    { text: w.waiting, tone: threat ? 'warn' : 'info' },
  ];

  const options: Option[] = threat
    ? [
        {
          id: 'allow',
          kind: 'allow',
          label: w.approve.label,
          hint: w.approve.hint,
          verdict: 'risky',
          safety: ALLOW_PENALTY[f.severity],
          work: 0,
          reaction: 'fail',
          consequence: prose.consequence ?? tpl.consequence,
          lesson: prose.lesson ?? tpl.lesson,
          log: [
            { text: w.approve.log, tone: 'tool' },
            { text: w.approve.bad(f), tone: 'bad' },
          ],
        },
        {
          id: 'block',
          kind: 'block',
          label: 'Reject the change',
          hint: w.reject.hint,
          verdict: 'safe',
          safety: 10,
          work: 0,
          reaction: 'success',
          consequence: w.reject.consequence,
          lesson: 'Rejecting is safe, but nothing gets fixed. Asking for the specific fix keeps you safe and gets the work done.',
          log: [{ text: w.reject.log, tone: 'good' }],
        },
        {
          id: 'human',
          kind: 'human',
          label: w.human.label,
          hint: w.human.hint,
          verdict: 'safe',
          safety: 15,
          work: 5,
          reaction: 'success',
          consequence: w.human.consequence,
          lesson: 'A reviewer is a strong check, but slow. Use one when you cannot tell, or when the fix is not obvious.',
          log: [
            { text: '> human.review(pr)', tone: 'tool' },
            { text: w.human.log, tone: 'good' },
          ],
        },
        {
          id: 'fix',
          kind: 'narrow',
          label: 'Request the fix',
          hint: clip(f.fix.summary, 110),
          verdict: 'safe',
          safety: 20,
          work: 20,
          reaction: 'success',
          consequence: `The agent was asked for the specific fix: ${f.fix.summary} The reviewed change shipped safely.`,
          lesson: 'Ask for the specific fix, not just a yes or a no. It keeps you safe and finishes the work.',
          log: [
            { text: w.fixLog(f.fix.summary), tone: 'tool' },
            { text: 'Fix applied and re-reviewed.', tone: 'good' },
          ],
        },
      ]
    : [
        {
          id: 'allow',
          kind: 'allow',
          label: w.approve.label,
          hint: w.approve.hint,
          verdict: 'safe',
          safety: 10,
          work: 20,
          reaction: 'success',
          consequence: w.approve.benignConsequence,
          lesson: 'Telling safe from unsafe matters as much as catching the bad. Approve what is clearly fine and save your attention for what is not.',
          log: [{ text: w.approve.good, tone: 'good' }],
        },
        {
          id: 'block',
          kind: 'block',
          label: 'Reject the change',
          hint: w.reject.hint,
          verdict: 'neutral',
          safety: 0,
          work: 0,
          reaction: 'thinking',
          consequence: 'The change was rejected. It was the safe form, so you blocked good work and the agent has to start again.',
          lesson: 'Over-blocking: if safe changes are refused, people stop trusting the review. Check, then approve what is safe.',
          log: [{ text: w.reject.log, tone: 'warn' }],
        },
        {
          id: 'human',
          kind: 'human',
          label: w.human.label,
          hint: w.human.hint,
          verdict: 'safe',
          safety: 5,
          work: 10,
          reaction: 'success',
          consequence: w.human.benignConsequence,
          lesson: 'Asking is never wrong, but nothing here needed a person.',
          log: [
            { text: '> human.review(pr)', tone: 'tool' },
            { text: 'Reviewer: safe, approved.', tone: 'good' },
          ],
        },
      ];

  const step: Step = {
    id: slug(f.id),
    source: { findingId: f.id, path: f.path, startLine: f.startLine, endLine: f.endLine },
    actor: 'nova',
    tool: w.tool,
    title,
    situation,
    say,
    threat,
    artifact: { kind: 'code', title: f.path, startLine: first, meta, body },
    clues,
    log,
    options,
  };
  return { step, decoyKind };
}

// ------------------------------------------------------------------ missions

/** A short theme for a mission title, so the missions of one repository are told apart in the list. */
const THEME: Record<Category, string> = {
  secret: 'Secrets',
  dependency: 'Dependencies',
  ci: 'Workflows',
  docker: 'Containers',
  mcp: 'Tool servers',
  'agent-instructions': 'Agent instructions',
  'prompt-injection': 'Hidden instructions',
  injection: 'Unsafe code',
  hygiene: 'Housekeeping',
  'site-security': 'Security',
  'site-privacy': 'Privacy',
  'site-content': 'Findability',
  'profile-security': 'Trust',
  'profile-privacy': 'Privacy',
  'profile-content': 'Impact',
};

function makeMission(repo: string, commit: string, n: number, steps: Step[], findings: Finding[], third: boolean, w: Words = WORDS.repo): Scenario {
  const cats = [...new Set(findings.map((f) => f.category))];
  const themes = cats.slice(0, 2).map((c) => THEME[c]);
  const concepts = [...new Set(cats.flatMap((c) => TEMPLATES[c].concepts))];
  const learning = [...new Set(cats.map((c) => TEMPLATES[c].learning))].slice(0, 3);
  const short = repo.split('/').pop() ?? repo;
  return {
    id: `live-${w.flavor === 'repo' ? '' : `${w.flavor}-`}${slug(repo)}-${commit.slice(0, 7) || 'x'}-${n}`,
    kind: 'mission',
    source: w.flavor,
    level: n,
    title: w.missionTitle(n, short, themes.join(' and ')),
    subtitle: w.subtitle(steps.length),
    briefing: w.briefing(repo, third),
    agents: ['nova'],
    roles: { nova: w.role },
    concepts,
    learning: learning.length > 0 ? learning : ['Review each change on its merits.'],
    steps,
  };
}

export interface BuildOptions {
  maxMissions?: number;
  threatsPerMission?: number;
  /** whose words the missions use: a repository (the default), a website or a profile */
  flavor?: Flavor;
}

/**
 * Builds playable missions from a scan report. Every mission is checked with validateScenario(): one that would be
 * unfair or mis-scored is dropped, and the reason is returned so it can be shown.
 */
export function buildMissions(report: Report, opts: BuildOptions = {}): BuildResult {
  const maxMissions = opts.maxMissions ?? 3;
  const perMission = opts.threatsPerMission ?? 3;
  const dropped: string[] = [];
  const third = report.findings.some((f) => !f.owned);
  const w = WORDS[opts.flavor ?? 'repo'];

  const rank = (f: Finding) => SEVERITY_ORDER.indexOf(f.severity);
  const sorted = [...report.findings].sort((a, b) => rank(a) - rank(b) || a.rule.localeCompare(b.rule) || a.path.localeCompare(b.path));

  const threats: { f: Finding; step: Step }[] = [];
  const benign: { f: Finding; step: Step }[] = [];
  for (const f of sorted) {
    const built = buildStep(f, w);
    if (!built) {
      dropped.push(`${f.id}: not enough evidence to build a fair step`);
      continue;
    }
    (f.benign ? benign : threats).push({ f, step: built.step });
  }

  // a threat has to hold up as a mission on its own
  const probe = (item: { f: Finding; step: Step }) => validateScenario(makeMission(report.repo, report.commit, 0, [item.step], [item.f], third, w), 'generated');
  const fair = threats.filter((t) => {
    const errs = probe(t);
    if (errs.length > 0) dropped.push(`${t.f.id}: ${errs[0]}`);
    return errs.length === 0;
  });

  if (fair.length === 0) {
    dropped.push('no finding could be turned into a fair mission');
    return { missions: [], dropped };
  }

  const missions: Scenario[] = [];
  let b = 0;
  for (let i = 0; i < fair.length && missions.length < maxMissions; i += perMission) {
    const chunk = fair.slice(i, i + perMission);
    const steps = chunk.map((c) => c.step);
    const fs = chunk.map((c) => c.f);
    // one legitimate request per mission, placed in the middle so the player cannot just block everything
    const extra = benign[b];
    if (extra) {
      steps.splice(Math.min(1, steps.length), 0, extra.step);
      fs.push(extra.f);
    }
    const n = missions.length + 1;
    let mission = makeMission(report.repo, report.commit, n, steps, fs, third, w);
    let errs = validateScenario(mission, 'generated');
    if (errs.length > 0 && extra) {
      mission = makeMission(report.repo, report.commit, n, chunk.map((c) => c.step), chunk.map((c) => c.f), third, w);
      errs = validateScenario(mission, 'generated');
    } else if (extra) b++;
    if (errs.length > 0) {
      dropped.push(`mission ${n}: ${errs[0]}`);
      continue;
    }
    missions.push(mission);
  }
  return { missions, dropped };
}
