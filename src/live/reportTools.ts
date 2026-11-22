import type { Finding, Report, Severity } from '../missions/types';
import { SEVERITY_ORDER } from '../missions/templates';
import { coerceReport } from './scanClient';

export function countBySeverity(findings: Finding[]): Partial<Record<Severity, number>> {
  const out: Partial<Record<Severity, number>> = {};
  for (const f of findings) if (!f.benign) out[f.severity] = (out[f.severity] ?? 0) + 1;
  return out;
}

export const realFindings = (report: Report): Finding[] =>
  report.findings.filter((f) => !f.benign).sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));

/**
 * A summary the owner can paste into an issue or a note. It lists what and where, and how to fix it.
 * It never contains the evidence lines, so a secret or an attack string cannot leak through a copy.
 */
export function reportToMarkdown(report: Report): string {
  const items = realFindings(report);
  const lines = [
    `# AgentGuard scan: ${report.repo}`,
    '',
    `Commit \`${report.commit.slice(0, 7)}\` · ${report.stats.files} files read · ${items.length} findings`,
    '',
    '| Severity | Finding | Where |',
    '|---|---|---|',
    ...items.map((f) => `| ${f.severity} | ${f.title} | \`${f.path}:${f.startLine}\` |`),
    '',
    '## How to fix',
    '',
    ...items.map((f) => `- **${f.title}** (\`${f.path}\`): ${f.fix.summary}`),
    '',
    '## Notes',
    '',
    ...report.disclaimers.map((d) => `- ${d}`),
    '',
  ];
  return lines.join('\n');
}

// ------------------------------------------------------------------ the report survives a reload of the tab

const KEY = 'agentguard.report.v1';

export function saveReport(report: Report): void {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(report));
  } catch {
    /* storage blocked or full: the missions simply will not survive a reload */
  }
}

export function restoreReport(): Report | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    return raw ? coerceReport(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}
