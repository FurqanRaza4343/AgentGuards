import type { AgentId } from '../agents';
import type { AgentState } from '../stage/actors/types';
import { scenarioOf, stepOf, type GameState } from './gameReducer';

/** What an agent is doing right now, derived from the game state. Drives both the 3D agent and the status badge. */
export function deriveAgentState(s: GameState, id: AgentId): AgentState {
  switch (s.phase) {
    case 'intro':
    case 'briefing':
      return 'idle';
    case 'simulating':
      // with two agents the other one waits; with four, only the one that is working moves
      return stepOf(s).actor === id ? 'working' : scenarioOf(s).agents.length <= 2 ? 'thinking' : 'idle';
    case 'decision': {
      const step = stepOf(s);
      if (step.actor !== id) return 'idle';
      // an unsafe request makes the agent flash until the player has audited it
      return step.threat && !s.reveal ? 'alert' : 'thinking';
    }
    case 'outcome':
      // in a pair both react; in the crowded final shift only the agent concerned does
      return stepOf(s).actor === id || scenarioOf(s).agents.length <= 2 ? (s.lastOption?.reaction ?? 'idle') : 'idle';
    case 'summary':
    case 'final': {
      const r = s.results[s.levelIndex];
      return r && r.rating !== 'At risk' ? 'success' : r ? 'fail' : 'idle';
    }
  }
}

export const STATE_LABEL: Record<AgentState, string> = {
  idle: 'Idle',
  thinking: 'Waiting',
  working: 'Working',
  alert: 'Needs a decision',
  success: 'Safe',
  fail: 'Compromised',
};
