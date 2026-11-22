import type { AgentId } from '../agents';
import type { AgentState } from '../stage/actors/types';

// Beams on the 3D stage: Nova hands out tasks (cyan), results come back to Nova (green),
// specialists hand work to each other (purple), and a failure is red.
export const BEAM = { task: 0x22b8cf, result: 0x10b981, handoff: 0xa855f7, fail: 0xdc2626 };

export function beamColour(from: AgentId, to: AgentId, state?: AgentState): number {
  if (state === 'fail') return BEAM.fail;
  if (from === 'nova') return BEAM.task;
  if (to === 'nova') return BEAM.result;
  return BEAM.handoff;
}

export const CREW_ORDER: AgentId[] = ['nova', 'data', 'purchasing', 'finance'];

export type CrewStates = Record<AgentId, AgentState>;
export type CrewTasks = Record<AgentId, string>;

export const idleStates = (): CrewStates => ({ nova: 'idle', data: 'idle', purchasing: 'idle', finance: 'idle' });
export const emptyTasks = (): CrewTasks => ({ nova: '', data: '', purchasing: '', finance: '' });
