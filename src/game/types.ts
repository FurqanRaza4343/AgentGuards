import type { AgentId, Tool } from '../agents';
import type { AgentState } from '../stage/actors/types';

export type Verdict = 'safe' | 'risky' | 'neutral';
export type OptionKind = 'allow' | 'block' | 'audit' | 'human' | 'quarantine' | 'narrow' | 'report' | 'sandbox' | 'verify';
export type LogTone = 'system' | 'tool' | 'info' | 'warn' | 'good' | 'bad';

/** One line of the simulated console. When `from` and `to` are set, a message packet flies between the agents. */
export interface LogLine {
  text: string;
  tone?: LogTone;
  from?: AgentId;
  to?: AgentId;
  /** Orchestrator runs: the speaking agent enters this state, and `task` is what it is doing now. */
  state?: AgentState;
  task?: string;
}

// ------------------------------------------------------------------ evidence

/** A piece of text in an artifact. With a `clue` it can be inspected; `faint` text is hidden from people (white on white). */
export type Span = string | { t: string; clue?: string; faint?: boolean };

/** Something the player can find while inspecting an artifact. A flag is a real red flag; a decoy looks odd but is fine. */
export interface Clue {
  id: string;
  flag: boolean;
  note: string;
}

export type ArtifactKind = 'email' | 'sql' | 'chat' | 'shell' | 'payment' | 'tool' | 'web' | 'code';

/** What the agent is looking at or about to do, drawn as a small mock window. */
export interface Artifact {
  kind: ArtifactKind;
  title: string;
  /** for kind 'code': the number of the first body line, so line numbers match the real file */
  startLine?: number;
  meta: { k: string; v: Span[] }[];
  body: Span[][];
}

// ------------------------------------------------------------------ decisions

/** What an Audit uncovers. It may unlock better options, and the player decides again. */
export interface Reveal {
  title: string;
  text: string;
  log: LogLine[];
  unlock?: Option[];
}

export interface Option {
  id: string;
  kind: OptionKind;
  label: string;
  /** one plain sentence explaining what the option does (shown under the button and as a tooltip) */
  hint: string;
  verdict: Verdict;
  /** security points: negative when the choice leads to harm */
  safety: number;
  /** productivity points: how much of the job still got done */
  work: number;
  /** how the agent reacts once this option is chosen */
  reaction: AgentState;
  consequence: string;
  lesson: string;
  log: LogLine[];
  /** an Audit: shows what it found, costs one audit token, and may unlock new options */
  reveal?: Reveal;
}

/** Where a generated step comes from: a finding of a scan, with its real file and lines. */
export interface StepSource {
  findingId: string;
  path: string;
  startLine: number;
  endLine: number;
}

export interface Step {
  id: string;
  /** set on steps generated from a scan */
  source?: StepSource;
  /** the agent that is waiting for a decision */
  actor: AgentId;
  tool: Tool;
  title: string;
  situation: string;
  /** what the agent says to the player (urgent, persuasive, or just routine) */
  say: string;
  /** false for a legitimate request: blocking it is a mistake too */
  threat: boolean;
  artifact: Artifact;
  clues: Clue[];
  log: LogLine[];
  options: Option[];
}

export interface Scenario {
  id: string;
  /** 'mission' for scenarios generated from a scan of the player's own repository */
  kind?: 'level' | 'mission';
  /** for missions: what they were made from, so the words around them fit */
  source?: 'repo' | 'site' | 'profile';
  level: number;
  title: string;
  subtitle: string;
  briefing: string;
  agents: AgentId[];
  /** the role an agent plays in this level, when different from its usual one */
  roles?: Partial<Record<AgentId, string>>;
  /** ids of Field Guide entries that this level teaches */
  concepts: string[];
  learning: string[];
  steps: Step[];
}
