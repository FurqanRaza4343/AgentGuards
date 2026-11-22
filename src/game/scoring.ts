import type { Option, Scenario } from './types';

/** Audit tokens per level. An Audit shows everything, but you cannot audit every request. */
export const AUDITS_PER_LEVEL = 2;
/** How many things you may inspect in one artifact. Real red flags and harmless decoys look alike, so choose well. */
export const INSPECTIONS_PER_STEP = 3;
/** Points for spotting a real red flag yourself. */
export const FLAG_BONUS = 2;

export interface Points {
  safety: number;
  work: number;
}

const total = (p: Points) => p.safety + p.work;

/** Best reachable points from a set of options, following Audit -> unlocked options. */
function bestFrom(options: Option[]): Points {
  let best: Points = { safety: -Infinity, work: -Infinity };
  for (const o of options) {
    let p: Points = { safety: o.safety, work: o.work };
    if (o.reveal) {
      const rest = options.filter((x) => x.id !== o.id).concat(o.reveal.unlock ?? []);
      const next = bestFrom(rest);
      p = { safety: p.safety + next.safety, work: p.work + next.work };
    }
    if (total(p) > total(best)) best = p;
  }
  return best;
}

export function flagCount(step: Scenario['steps'][number]): number {
  return Math.min(INSPECTIONS_PER_STEP, step.clues.filter((c) => c.flag).length);
}

export interface LevelMax {
  safety: number;
  work: number;
  bonus: number;
  flags: number;
  score: number;
}

export function levelMax(scenario: Scenario): LevelMax {
  let safety = 0;
  let work = 0;
  let flags = 0;
  for (const step of scenario.steps) {
    const b = bestFrom(step.options);
    safety += b.safety;
    work += b.work;
    flags += flagCount(step);
  }
  const bonus = flags * FLAG_BONUS;
  return { safety, work, bonus, flags, score: safety + work + bonus };
}

export const maxScore = (scenario: Scenario) => levelMax(scenario).score;

export type Rating = 'Guardian' | 'Cautious' | 'At risk';

export function ratingFor(score: number, max: number): Rating {
  const pct = max > 0 ? Math.max(0, score) / max : 0;
  if (pct >= 0.8) return 'Guardian';
  if (pct >= 0.5) return 'Cautious';
  return 'At risk';
}

export const starsFor = (r: Rating): 1 | 2 | 3 => (r === 'Guardian' ? 3 : r === 'Cautious' ? 2 : 1);

export const RATING_TEXT: Record<Rating, string> = {
  Guardian: 'You kept the agent safe and still got the job done.',
  Cautious: 'You avoided the worst outcomes. Look at the lessons to find the safer path.',
  'At risk': 'The agent got you into trouble. Read the lessons and try again.',
};
