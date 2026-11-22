const KEY = 'agentguard.best.v1';

/** Best total score on this device. localStorage can be blocked, so every access is guarded. */
export function loadBest(): number | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Stores the score if it beats the previous best, and returns the best score. */
export function saveBest(score: number): number {
  const prev = loadBest();
  const best = prev === null ? score : Math.max(prev, score);
  try {
    window.localStorage.setItem(KEY, String(best));
  } catch {
    /* private mode or blocked storage: keep playing without saving */
  }
  return best;
}
