import type { AgentId } from '../agents';
import type { LogLine } from '../game/types';
import { toLogLine } from '../live/scanClient';
import type { Severity } from '../missions/types';

/**
 * The report of an Orchestrator run on a website or a pasted profile. It mirrors server/guardscan/assess/models.py.
 * The server is not trusted: `coerceAssess` checks every field before the page uses it.
 */
export type AssessKind = 'site' | 'profile';
export type Area = 'security' | 'privacy' | 'content' | 'seo' | 'accessibility' | 'discoverability';

export interface AFinding {
  id: string;
  area: Area;
  severity: Severity;
  rule: string;
  title: string;
  detail: string;
  evidence: string;
  location: string;
  fix: string;
  by: AgentId;
}

export interface Question {
  id: string;
  text: string;
  why: string;
  area: Area;
  findingId: string | null;
}

export interface Improvement {
  id: string;
  title: string;
  before: string;
  after: string;
  findingId: string | null;
}

export interface AgentSummary {
  id: AgentId;
  role: string;
  task: string;
  summary: string;
  findingIds: string[];
}

export interface AssessReport {
  kind: AssessKind;
  target: string;
  generatedAt: string;
  stats: { pages: number; bytes: number; words: number };
  agents: AgentSummary[];
  findings: AFinding[];
  strengths: string[];
  questions: Question[];
  improvements: Improvement[];
  search: { used: boolean; note: string; queries: string[] };
  model: boolean;
  /** true when the questions were written by the backup language model, not Gemini: the page must say so */
  backup: boolean;
  runLog: LogLine[];
  disclaimers: string[];
  /** short words for a scorecard check that passes (a site only): what robots.txt, the sitemap and the title looked like */
  facts: Record<string, string>;
  demo: boolean;
}

export const AREAS: Area[] = ['security', 'privacy', 'content', 'seo', 'accessibility', 'discoverability'];
export const AREA_LABEL: Record<Area, string> = {
  security: 'Security',
  privacy: 'Privacy',
  content: 'Content',
  seo: 'Search',
  accessibility: 'Accessibility',
  discoverability: 'Discoverability',
};
const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
const AGENTS: AgentId[] = ['nova', 'data', 'purchasing', 'finance'];

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isStr = (x: unknown): x is string => typeof x === 'string';
const str = (x: unknown, max: number): string => (isStr(x) ? x.slice(0, max) : '');
const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0);

/** The roles that each specialist plays, by kind. The server sends the same words in `agents`; this is for the stage before it does. */
export const ROLES: Record<AssessKind, Record<AgentId, { title: string; does: string }>> = {
  site: {
    nova: { title: 'Orchestrator', does: 'Plans, delegates, asks' },
    data: { title: 'Scraper', does: 'Reads the pages' },
    purchasing: { title: 'Security', does: 'Headers, cookies, source' },
    finance: { title: 'Content', does: 'Search, phones, access' },
  },
  profile: {
    nova: { title: 'Orchestrator', does: 'Plans, delegates, asks' },
    data: { title: 'Reader', does: 'Finds the structure' },
    purchasing: { title: 'Privacy', does: 'Private details, hidden text' },
    finance: { title: 'Impact', does: 'How it reads' },
  },
};

export function coerceAssess(x: unknown): AssessReport | null {
  if (!isObj(x) || (x.kind !== 'site' && x.kind !== 'profile') || !isStr(x.target) || !Array.isArray(x.findings) || !Array.isArray(x.questions)) return null;
  const findings: AFinding[] = [];
  for (const f of x.findings) {
    if (!isObj(f) || !isStr(f.id) || !isStr(f.rule) || !isStr(f.title) || !isStr(f.fix)) return null;
    if (!AREAS.includes(f.area as Area) || !SEVERITIES.includes(f.severity as Severity) || !AGENTS.includes(f.by as AgentId)) return null;
    findings.push({
      id: f.id.slice(0, 40),
      area: f.area as Area,
      severity: f.severity as Severity,
      rule: f.rule.slice(0, 80),
      title: f.title.slice(0, 200),
      detail: str(f.detail, 600),
      evidence: str(f.evidence, 240),
      location: str(f.location, 220),
      fix: f.fix.slice(0, 500),
      by: f.by as AgentId,
    });
  }
  const ids = new Set(findings.map((f) => f.id));
  const questions: Question[] = [];
  for (const q of x.questions) {
    if (!isObj(q) || !isStr(q.id) || !isStr(q.text) || !AREAS.includes(q.area as Area)) return null;
    questions.push({ id: q.id.slice(0, 20), text: q.text.slice(0, 260), why: str(q.why, 300), area: q.area as Area, findingId: isStr(q.findingId) && ids.has(q.findingId) ? q.findingId : null });
  }
  const improvements: Improvement[] = [];
  for (const i of Array.isArray(x.improvements) ? x.improvements : []) {
    if (!isObj(i) || !isStr(i.id) || !isStr(i.title) || !isStr(i.after)) return null;
    improvements.push({ id: i.id.slice(0, 20), title: i.title.slice(0, 120), before: str(i.before, 340), after: i.after.slice(0, 480), findingId: isStr(i.findingId) && ids.has(i.findingId) ? i.findingId : null });
  }
  const agents: AgentSummary[] = [];
  for (const a of Array.isArray(x.agents) ? x.agents : []) {
    if (!isObj(a) || !AGENTS.includes(a.id as AgentId) || !isStr(a.role)) return null;
    agents.push({ id: a.id as AgentId, role: a.role.slice(0, 40), task: str(a.task, 80), summary: str(a.summary, 200), findingIds: Array.isArray(a.findingIds) ? a.findingIds.filter(isStr).slice(0, 80) : [] });
  }
  const stats = isObj(x.stats) ? x.stats : {};
  const search = isObj(x.search) ? x.search : {};
  return {
    kind: x.kind,
    target: x.target.slice(0, 200),
    generatedAt: str(x.generatedAt, 40),
    stats: { pages: num(stats.pages), bytes: num(stats.bytes), words: num(stats.words) },
    agents,
    findings,
    strengths: Array.isArray(x.strengths) ? x.strengths.filter(isStr).map((s) => s.slice(0, 200)).slice(0, 20) : [],
    questions,
    improvements,
    search: { used: search.used === true, note: str(search.note, 240), queries: Array.isArray(search.queries) ? search.queries.filter(isStr).map((q) => q.slice(0, 120)).slice(0, 6) : [] },
    model: x.model === true,
    backup: x.backup === true,
    runLog: Array.isArray(x.runLog) ? x.runLog.flatMap((l) => (isObj(l) && isStr(l.text) ? [toLogLine(l)] : [])) : [],
    disclaimers: Array.isArray(x.disclaimers) ? x.disclaimers.filter(isStr).map((s) => s.slice(0, 400)) : [],
    facts: isObj(x.facts) ? Object.fromEntries(Object.entries(x.facts).filter(([k, v]) => k.length <= 30 && isStr(v)).slice(0, 30).map(([k, v]) => [k, (v as string).slice(0, 140)])) : {},
    demo: x.demo === true,
  };
}

export function countBySeverity(findings: AFinding[]): Partial<Record<Severity, number>> {
  const out: Partial<Record<Severity, number>> = {};
  for (const f of findings) out[f.severity] = (out[f.severity] ?? 0) + 1;
  return out;
}

/** What to copy: titles, where, and how to fix, plus the questions and rewrites. Evidence excerpts are left out on purpose. */
export function assessToMarkdown(r: AssessReport): string {
  const lines: string[] = [`# AgentGuard report: ${r.target}`, '', `Run on ${r.generatedAt || 'an unknown date'}. ${r.findings.length} findings.`, ''];
  if (r.questions.length > 0) {
    lines.push('## Questions to think about', '');
    r.questions.forEach((q, i) => lines.push(`${i + 1}. ${q.text}`, `   Why: ${q.why}`));
    lines.push('');
  }
  if (r.improvements.length > 0) {
    lines.push('## Suggested rewrites', '');
    for (const i of r.improvements) lines.push(`- **${i.title}**: ${i.after}`);
    lines.push('');
  }
  lines.push('## Findings', '');
  for (const f of r.findings.filter((x) => x.severity !== 'info')) lines.push(`- [${f.severity}] ${f.title}${f.location ? ` (${f.location})` : ''}. Fix: ${f.fix}`);
  if (r.strengths.length > 0) lines.push('', '## Already good', '', ...r.strengths.map((s) => `- ${s}`));
  lines.push('', '_Checked passively with AgentGuard. Findings explain what and why, without attack steps._');
  return lines.join('\n');
}
