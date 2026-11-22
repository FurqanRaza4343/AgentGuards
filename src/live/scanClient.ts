import type { AgentId } from '../agents';
import type { LogLine } from '../game/types';
import type { Category, Finding, Report, Severity } from '../missions/types';

/** Something the player can read: the scanner refused, was busy, or failed. */
export class ScanError extends Error {}

export interface SseEvent {
  event: string;
  data: string;
}

/** Splits a Server-Sent Events buffer into complete events and the unfinished rest. */
export function parseSse(buffer: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = [];
  let rest = buffer.replace(/\r\n/g, '\n');
  let idx: number;
  while ((idx = rest.indexOf('\n\n')) !== -1) {
    const block = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue; // a comment, used as a keep-alive
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (data.length > 0) events.push({ event, data: data.join('\n') });
  }
  return { events, rest };
}

const AGENTS: AgentId[] = ['nova', 'data', 'purchasing', 'finance'];
const CATEGORIES: Category[] = ['secret', 'dependency', 'ci', 'docker', 'mcp', 'agent-instructions', 'prompt-injection', 'injection', 'hygiene'];
const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isStr = (x: unknown): x is string => typeof x === 'string';
const isInt = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 1;

function coerceRanges(x: unknown): { start: number; end: number; note: string }[] | null {
  if (!Array.isArray(x)) return null;
  const out = [];
  for (const r of x) {
    if (!isObj(r) || !isInt(r.start) || !isInt(r.end) || !isStr(r.note)) return null;
    out.push({ start: r.start, end: r.end, note: r.note });
  }
  return out;
}

/** The server is not trusted: a report is checked field by field before it is used. Returns null when it is not valid. */
export function coerceReport(x: unknown): Report | null {
  if (!isObj(x) || !isStr(x.repo) || !isStr(x.commit) || !Array.isArray(x.findings)) return null;
  const findings: Finding[] = [];
  for (const f of x.findings) {
    if (!isObj(f) || !isStr(f.id) || !isStr(f.rule) || !isStr(f.title) || !isStr(f.path) || !isStr(f.evidence)) return null;
    if (!CATEGORIES.includes(f.category as Category) || !SEVERITIES.includes(f.severity as Severity)) return null;
    if (!isInt(f.startLine) || !isInt(f.endLine) || !isObj(f.context) || !isInt(f.context.startLine) || !Array.isArray(f.context.lines)) return null;
    if (!f.context.lines.every(isStr) || f.context.lines.length > 60) return null;
    const flags = coerceRanges(f.flags);
    const decoys = coerceRanges(f.decoys);
    if (!flags || !decoys || !isObj(f.fix) || !isStr(f.fix.summary)) return null;
    const prose = isObj(f.prose) ? Object.fromEntries(Object.entries(f.prose).filter(([, v]) => isStr(v))) : undefined;
    findings.push({
      id: f.id,
      category: f.category as Category,
      severity: f.severity as Severity,
      rule: f.rule,
      title: f.title,
      path: f.path,
      startLine: f.startLine,
      endLine: f.endLine,
      context: { startLine: f.context.startLine, lines: f.context.lines as string[] },
      flags,
      decoys,
      benign: f.benign === true,
      fix: { summary: f.fix.summary },
      prose,
      evidence: f.evidence,
      owned: f.owned === true,
    });
  }
  const runLog: LogLine[] = Array.isArray(x.runLog) ? x.runLog.flatMap((l) => (isObj(l) && isStr(l.text) ? [toLogLine(l)] : [])) : [];
  const stats = isObj(x.stats) ? x.stats : {};
  return {
    repo: x.repo,
    commit: x.commit,
    generatedAt: isStr(x.generatedAt) ? x.generatedAt : '',
    stats: { files: Number(stats.files) || 0, bytes: Number(stats.bytes) || 0, skipped: Number(stats.skipped) || 0 },
    findings,
    runLog,
    disclaimers: Array.isArray(x.disclaimers) ? x.disclaimers.filter(isStr) : [],
    demo: x.demo === true,
  };
}

const STATES: NonNullable<LogLine['state']>[] = ['idle', 'thinking', 'working', 'alert', 'success', 'fail'];

export function toLogLine(l: Record<string, unknown>): LogLine {
  const tone = ['system', 'tool', 'info', 'warn', 'good', 'bad'].includes(String(l.tone)) ? (l.tone as LogLine['tone']) : undefined;
  return {
    text: String(l.text).slice(0, 400),
    tone,
    from: AGENTS.includes(l.from as AgentId) ? (l.from as AgentId) : undefined,
    to: AGENTS.includes(l.to as AgentId) ? (l.to as AgentId) : undefined,
    state: STATES.includes(l.state as NonNullable<LogLine['state']>) ? (l.state as LogLine['state']) : undefined,
    task: isStr(l.task) ? l.task.slice(0, 90) : undefined,
  };
}

/** Reads a Server-Sent Events response, calling onLog for each log line, and resolves with the first `report` event's data. */
export async function readEventStream(res: Response, onLog: (line: LogLine) => void): Promise<unknown> {
  if (!res.body) throw new ScanError('The service sent an empty answer.');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: !done });
    const parsed = parseSse(buffer);
    buffer = parsed.rest;
    for (const ev of parsed.events) {
      let data: unknown;
      try {
        data = JSON.parse(ev.data);
      } catch {
        continue;
      }
      if (ev.event === 'log' && isObj(data) && isStr(data.text)) onLog(toLogLine(data));
      else if (ev.event === 'error') throw new ScanError(isObj(data) && isStr(data.message) ? data.message : 'The run failed.');
      else if (ev.event === 'report') return data;
    }
    if (done) break;
  }
  throw new ScanError('The run ended without a report.');
}

/** Scans a public GitHub repository. Calls onLog for every line the scanner reports, and resolves with the report. */
export async function scanRepo(url: string, onLog: (line: LogLine) => void, signal?: AbortSignal): Promise<Report> {
  let res: Response;
  try {
    res = await fetch('/api/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }), signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ScanError('The scanner cannot be reached. You can still play the demo.');
  }
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new ScanError(body?.message ?? `The scanner answered ${res.status}.`);
  }
  const report = coerceReport(await readEventStream(res, onLog));
  if (!report) throw new ScanError('The scanner sent a report that could not be understood.');
  return report;
}

export async function loadDemo(): Promise<Report> {
  const res = await fetch('/demo-report.json');
  if (!res.ok) throw new ScanError('The demo report is not available.');
  const report = coerceReport(await res.json());
  if (!report) throw new ScanError('The demo report could not be understood.');
  return report;
}
