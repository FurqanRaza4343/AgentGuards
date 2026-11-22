import { AGENTS, type AgentId } from '../../agents';
import { RobotActor } from './RobotActor';
import type { AgentActor } from './types';

/**
 * Builds the actor for an agent id: the procedural robot coloured with that agent's skin.
 *
 * The sample FBX/GLB files that were supplied are single static meshes (no skeleton, no animation,
 * about 290k triangles and 11 MB each), so they cannot show expressions or move their arms.
 * The procedural robot matches the artwork, loads instantly and is fully animated.
 */
export function createActor(id: AgentId): AgentActor {
  return new RobotActor(AGENTS[id].skin);
}
