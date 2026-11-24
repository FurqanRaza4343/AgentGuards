import type { HistoryEntry } from './progress';
import type { Option, Scenario } from './types';

/**
 * What the player does with the game's result. Every mission is built from a real finding on the player's own repository, website
 * or profile, so when the mission ends the player has more than a score: a list of real things to fix, with the ones they
 * asked for marked, and the ones they let through or only blocked still on the list.
 */
export type FixState = 'requested' | 'open' | 'missed';

export interface FixItem {
  stepId: string;
  findingId: string;
  title: string;
  where: string;
  fix: string;
  state: FixState;
}

const RANK: Record<FixState, number> = { missed: 0, open: 1, requested: 2 };

export const STATE_LABEL: Record<FixState, string> = {
  missed: 'You let it through',
  open: 'Blocked, but still not fixed',
  requested: 'You asked for the fix',
};

/** The list of fixes for one finished mission. A fix is "requested" when the player chose the specific fix, "missed" when they allowed it. */
export function buildFixPlan(scenario: Scenario, history: HistoryEntry[]): FixItem[] {
  const items: FixItem[] = [];
  for (const step of scenario.steps) {
    if (!step.threat || !step.source) continue;
    const chosen = [...history].reverse().find((h) => h.stepId === step.id && !h.audit);
    const state: FixState = !chosen ? 'open' : chosen.kind === 'narrow' ? 'requested' : chosen.kind === 'allow' ? 'missed' : 'open';
    const fix = step.options.find((o) => o.kind === 'narrow')?.hint ?? '';
    items.push({
      stepId: step.id,
      findingId: step.source.findingId,
      title: step.title.replace(/^[^:]{3,60}:\s*/, ''),
      where: step.source.path,
      fix,
      state,
    });
  }
  return items.sort((a, b) => RANK[a.state] - RANK[b.state]);
}

/** A checklist that can be pasted into an issue, a note or a chat. Nothing in it is a secret: titles, places and fixes only. */
export function fixPlanToMarkdown(items: FixItem[], heading: string): string {
  const lines = [`# ${heading}`, ''];
  for (const i of items) lines.push(`- [${i.state === 'requested' ? 'x' : ' '}] **${i.title}**${i.where ? ` (${i.where})` : ''}${i.fix ? `: ${i.fix}` : ''}`);
  lines.push('', '_From AgentGuard missions built on my own material._');
  return lines.join('\n');
}

/** How many safe choices in a row, counting back from the latest one. An Audit is not a choice: it neither adds to the streak nor breaks it. */
export function streakOf(history: HistoryEntry[]): number {
  let n = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (h.audit) continue;
    if (h.verdict !== 'safe') break;
    n++;
  }
  return n;
}

/** Pressure mode: the seconds the player has per decision. A real agent does not wait for anyone. */
export const PRESSURE_SECONDS = 25;

/** What the agent does by itself when the time runs out: it goes ahead. That is the "allow" option, never an Audit. */
export function autoChoice(options: Option[]): Option | undefined {
  return options.find((o) => o.kind === 'allow' && !o.reveal);
}
