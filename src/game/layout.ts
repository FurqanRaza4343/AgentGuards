import type { GameLayout } from '../stage/AgentStage';

/** Where the agents sit on screen: beside the text on desktop, above it on phones. */
export function layoutFor(agentCount: number, mobile: boolean): GameLayout {
  if (mobile) {
    if (agentCount >= 4) return { shiftX: 0, shiftY: -0.235, dist: 36, spacing: 2.1 };
    return { shiftX: 0, shiftY: -0.235, dist: agentCount > 1 ? 25 : 24, spacing: 2.5 };
  }
  if (agentCount >= 4) return { shiftX: 0.215, shiftY: 0, dist: 24.5, spacing: 2.1 };
  if (agentCount > 1) return { shiftX: 0.19, shiftY: 0, dist: 13.5, spacing: 2.5 };
  return { shiftX: 0.17, shiftY: 0, dist: 12.4, spacing: 2.5 };
}
