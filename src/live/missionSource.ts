import { coerceAssess } from '../assess/types';
import type { AssessReport } from '../assess/types';
import type { Scenario } from '../game/types';
import { buildAssessMissions } from '../missions/assessReport';
import { buildMissions } from '../missions/buildScenarios';
import type { Report } from '../missions/types';
import { coerceReport } from './scanClient';

/** What the missions are made from: a repository scan, a website analysis or a profile analysis. */
export type MissionSource = { kind: 'repo'; report: Report } | { kind: 'site' | 'profile'; report: AssessReport };

const KEY = 'agentguard.missionSource.v1';

export function missionsFrom(src: MissionSource): Scenario[] {
  return src.kind === 'repo' ? buildMissions(src.report).missions : buildAssessMissions(src.report).missions;
}

/** Where the page that made this source lives: used by "analyse another" in the game. */
export const hashOf = (kind: MissionSource['kind'] | 'game'): string => (kind === 'site' ? '#site' : kind === 'profile' ? '#profile' : '#analyze');

export function saveMissionSource(src: MissionSource): void {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(src));
  } catch {
    /* storage blocked or full: the missions simply will not survive a reload */
  }
}

/** The server and the browser's own storage are not trusted: what comes back is validated again. */
export function restoreMissionSource(): MissionSource | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { kind?: string; report?: unknown };
    if (parsed.kind === 'repo') {
      const r = coerceReport(parsed.report);
      return r ? { kind: 'repo', report: r } : null;
    }
    if (parsed.kind === 'site' || parsed.kind === 'profile') {
      const r = coerceAssess(parsed.report);
      return r && r.kind === parsed.kind ? { kind: parsed.kind, report: r } : null;
    }
    return null;
  } catch {
    return null;
  }
}
