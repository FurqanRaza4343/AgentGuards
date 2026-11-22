import type { LogLine } from '../game/types';
import { readEventStream, ScanError } from '../live/scanClient';
import { coerceAssess } from './types';
import type { AssessKind, AssessReport } from './types';

export interface AssessInput {
  kind: AssessKind;
  /** a website address (kind "site") */
  url?: string;
  /** text the person pasted (kind "profile") */
  text?: string;
  /** the role the person wants (kind "profile"); the only thing that may go to a search engine */
  role?: string;
}

/** Runs the Orchestrator on a website or a pasted profile. Calls onLog for every line, and resolves with the report. */
export async function runAssess(input: AssessInput, onLog: (line: LogLine) => void, signal?: AbortSignal): Promise<AssessReport> {
  let res: Response;
  try {
    res = await fetch('/api/assess', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ScanError('The service cannot be reached. You can still play the demo.');
  }
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => null)) as { message?: string; detail?: unknown } | null;
    throw new ScanError(body?.message ?? (res.status === 422 ? 'That input was not accepted. Check its length and try again.' : `The service answered ${res.status}.`));
  }
  const report = coerceAssess(await readEventStream(res, onLog));
  if (!report) throw new ScanError('The service sent a report that could not be understood.');
  return report;
}

export async function loadAssessDemo(kind: AssessKind): Promise<AssessReport> {
  const res = await fetch(`/demo-${kind}-report.json`);
  if (!res.ok) throw new ScanError('The demo report is not available.');
  const report = coerceAssess(await res.json());
  if (!report || report.kind !== kind) throw new ScanError('The demo report could not be understood.');
  return report;
}
