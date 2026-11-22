import type { LogLine } from '../game/types';

/**
 * The contract between the scanner (Python, server/) and the game (TypeScript).
 * The scanner finds the problems and decides which lines are the red flags.
 * The game builds the mission: the points and options come from templates in code, never from a language model.
 */

export type Category =
  | 'secret'
  | 'dependency'
  | 'ci'
  | 'docker'
  | 'mcp'
  | 'agent-instructions'
  | 'prompt-injection'
  | 'injection'
  | 'hygiene'
  // missions made from a website or a pasted profile (not produced by the repository scanner)
  | 'site-security'
  | 'site-privacy'
  | 'site-content'
  | 'profile-security'
  | 'profile-privacy'
  | 'profile-content';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

/** A range of lines, 1-based and inclusive, with a note that explains it. */
export interface LineRange {
  start: number;
  end: number;
  note: string;
}

/** Optional prose written by a language model and checked by the server. Templates are used when it is missing. */
export interface Prose {
  situation?: string;
  say?: string;
  consequence?: string;
  lesson?: string;
  question?: string;
  answer?: string;
}

export interface Finding {
  id: string;
  category: Category;
  severity: Severity;
  /** e.g. "ci.pull-request-target" */
  rule: string;
  title: string;
  path: string;
  startLine: number;
  endLine: number;
  /** the lines shown as evidence, with their real line numbers */
  context: { startLine: number; lines: string[] };
  /** the real red flags, inside the context window (1-3) */
  flags: LineRange[];
  /** provably safe look-alike lines inside the context window */
  decoys: LineRange[];
  /** a provably safe match of the rule: becomes a legitimate request */
  benign?: boolean;
  fix: { summary: string; before?: string; after?: string };
  prose?: Prose;
  /** the exact text that was matched, taken verbatim from the file */
  evidence: string;
  /** false for repositories the user does not own (third-party mode): no exploit detail, secrets masked */
  owned: boolean;
}

export interface ReportStats {
  files: number;
  bytes: number;
  skipped: number;
}

export interface Report {
  repo: string;
  commit: string;
  generatedAt: string;
  stats: ReportStats;
  findings: Finding[];
  runLog: LogLine[];
  disclaimers: string[];
  /** true when the report was pre-baked for the demo instead of scanned live */
  demo?: boolean;
}
