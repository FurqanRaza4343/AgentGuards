import { ratingFor, starsFor, type Rating } from './scoring';

/** What the game stores about one finished level. */
export interface LevelResult {
  score: number;
  max: number;
  safety: number;
  safetyMax: number;
  work: number;
  workMax: number;
  bonus: number;
  flagsFound: number;
  flagsTotal: number;
  risky: number;
  rating: Rating;
}

/** One decision, as kept for the debrief and for badges. */
export interface HistoryEntry {
  stepId: string;
  stepTitle: string;
  optionId: string;
  kind: string;
  label: string;
  verdict: 'safe' | 'risky' | 'neutral';
  safety: number;
  work: number;
  /** an Audit: it shows more information and the player decides again */
  audit: boolean;
  /** the step was a legitimate request */
  benign: boolean;
  lesson: string;
  flagsFound: number;
  flagsTotal: number;
}

export interface LevelRecord {
  best: number;
  max: number;
  stars: 1 | 2 | 3;
  rating: Rating;
  plays: number;
}

export interface Progress {
  v: 2;
  levels: Record<string, LevelRecord>;
  badges: string[];
  counters: { humanAsks: number };
}

export const emptyProgress = (): Progress => ({ v: 2, levels: {}, badges: [], counters: { humanAsks: 0 } });

// ------------------------------------------------------------------ badges

export interface BadgeDef {
  id: string;
  name: string;
  desc: string;
}

export const BADGES: BadgeDef[] = [
  { id: 'sharp-eye', name: 'Sharp Eye', desc: 'Find every red flag in a level.' },
  { id: 'flawless', name: 'Flawless', desc: 'Finish a level without a single risky choice.' },
  { id: 'least-privilege', name: 'Least Privilege', desc: 'Narrow a request instead of only allowing or denying it.' },
  { id: 'safe-hands', name: 'Safe Hands', desc: 'Use a sandbox instead of the real system.' },
  { id: 'human-loop', name: 'Human in the Loop', desc: 'Ask a human three times.' },
  { id: 'not-paranoid', name: 'Not Paranoid', desc: 'Approve a legitimate request without asking anyone.' },
  { id: 'guardian-all', name: 'Guardian', desc: 'Earn a Guardian rating on every level.' },
];

export const badgeById = (id: string) => BADGES.find((b) => b.id === id);

interface Evaluated {
  progress: Progress;
  /** badges earned by this level that the player did not have before */
  earned: string[];
}

/**
 * Pure: folds one finished level into the stored progress and works out new badges.
 * `levelIds` is the full list of level ids, needed for the "all levels" badge.
 */
export function applyResult(prev: Progress, levelId: string, result: LevelResult, history: HistoryEntry[], levelIds: string[]): Evaluated {
  const stars = starsFor(result.rating);
  const old = prev.levels[levelId];
  const record: LevelRecord = {
    best: Math.max(old?.best ?? -Infinity, result.score),
    max: result.max,
    stars: Math.max(old?.stars ?? 1, stars) as 1 | 2 | 3,
    rating: (old && old.best > result.score ? old.rating : result.rating) as Rating,
    plays: (old?.plays ?? 0) + 1,
  };
  const humanAsks = prev.counters.humanAsks + history.filter((h) => h.kind === 'human' || h.kind === 'verify').length;
  const levels = { ...prev.levels, [levelId]: record };

  const got = new Set(prev.badges);
  const add = (id: string, cond: boolean) => cond && got.add(id);
  add('sharp-eye', result.flagsTotal > 0 && result.flagsFound >= result.flagsTotal);
  add('flawless', result.risky === 0);
  add('least-privilege', history.some((h) => h.kind === 'narrow'));
  add('safe-hands', history.some((h) => h.kind === 'sandbox'));
  add('human-loop', humanAsks >= 3);
  add('not-paranoid', history.some((h) => h.benign && h.kind === 'allow'));
  add('guardian-all', levelIds.every((id) => levels[id] && ratingFor(levels[id].best, levels[id].max) === 'Guardian'));

  const badges = [...got];
  return { progress: { v: 2, levels, badges, counters: { humanAsks } }, earned: badges.filter((b) => !prev.badges.includes(b)) };
}

// ------------------------------------------------------------------ storage

const KEY = 'agentguard.progress.v2';

export function loadProgress(): Progress {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return emptyProgress();
    const p = JSON.parse(raw) as Progress;
    return p && p.v === 2 && p.levels && Array.isArray(p.badges) ? p : emptyProgress();
  } catch {
    return emptyProgress();
  }
}

export function saveProgress(p: Progress): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* private mode or blocked storage: keep playing without saving */
  }
}

export function clearProgress(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
