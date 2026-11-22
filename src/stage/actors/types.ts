import type * as THREE from 'three';

/** One state vocabulary for every agent, whether it is the procedural robot or an FBX model. */
export type AgentState = 'idle' | 'thinking' | 'working' | 'alert' | 'success' | 'fail';

export interface ActorContext {
  /** seconds since the stage started */
  t: number;
  /** seconds since the previous frame (clamped) */
  dt: number;
  /** smoothed pointer, -1..1 on both axes (y grows downwards) */
  pointer: { x: number; y: number };
  /** how much the pointer influences the agent (1 on the landing page, less in the game) */
  pointerGain: number;
  /** base pose blended by the stage (scroll on the landing page, fixed in the game) */
  pose: { bodyYaw: number; headYaw: number; headPitch: number; headRoll: number };
  /** the landing page asks for the quote mark on the face screen */
  quote: boolean;
  reducedMotion: boolean;
}

export interface AgentActor {
  /** Root object. Its origin is at the agent's feet, so the stage can stand it on a pedestal. */
  readonly object: THREE.Object3D;
  /** Height (actor space) where effects such as the A2A beam attach. */
  readonly anchorY: number;
  setState(state: AgentState): void;
  update(ctx: ActorContext): void;
  dispose(): void;
}
