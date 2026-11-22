import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { AgentId } from '../agents';
import { createActor } from './actors/registry';
import type { AgentActor, AgentState } from './actors/types';
import { AgentBeam } from './effects';
import { rbox } from './geometry';

export type StageMode = 'landing' | 'game';

/** Where the agents sit on screen in game mode (fractions of the viewport) and how far the camera is. */
export interface GameLayout {
  shiftX: number;
  shiftY: number;
  dist: number;
  /** distance between neighbouring agents, in scene units */
  spacing: number;
}

const FEET_Y = -1.42;
/** The pedestal is 1.6 tall and centred on y = -2.22, so its bottom edge is here. */
const PEDESTAL_BOTTOM = -3.02;
const ENV_INTENSITY = 0.9;

/** Landing page camera and head poses, blended by scroll (section 1 -> 2; section 3 keeps the close-up). */
const INTRO = { z: 11.6, y: 1.1, look: 0.55, body: -0.42, hYaw: -0.6, hPitch: 0.16, hRoll: 0.22 };
const PRODUCT = { z: 6.9, y: 1.95, look: 1.72, body: -0.2, hYaw: -0.06, hPitch: 0.04, hRoll: 0 };
const LANDING_SHIFT_X = 0.07;
/** Game pose: the agent faces the player, full body on its pedestal. */
const GAME = { y: 1.0, look: 0.35, body: -0.2, hYaw: -0.1, hPitch: 0.04, hRoll: 0.04 };

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

interface Slot {
  id: AgentId;
  actor: AgentActor;
  pedestal: THREE.Mesh;
  x: number;
  targetX: number;
  yaw: number;
  appear: number;
}

export class AgentStage {
  private renderer?: THREE.WebGLRenderer;
  private canvas?: HTMLCanvasElement;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  private readonly clock = new THREE.Clock();
  private readonly beam = new AgentBeam();
  private readonly pedestalMat = new THREE.MeshStandardMaterial({ color: 0x2a2928, roughness: 0.9 });
  private readonly slots = new Map<AgentId, Slot>();
  private order: AgentId[] = [];

  private mode: StageMode = 'landing';
  private layout: GameLayout = { shiftX: 0.18, shiftY: 0, dist: 10.5, spacing: 2.5 };
  private reducedMotion = false;
  private running = false;
  private raf = 0;

  private p = 0; // smoothed scroll progress, 0..2
  private blend = 0; // 0 = landing, 1 = game
  private readonly ptr = { x: 0, y: 0 };
  private readonly ptrTarget = { x: 0, y: 0 };

  constructor() {
    this.pedestalMat.envMapIntensity = ENV_INTENSITY;
    this.scene.add(this.beam.group);
    this.addLights();
    this.showAgents(['nova']);
  }

  // ------------------------------------------------------------------ public API

  mount(canvas: HTMLCanvasElement) {
    if (!this.renderer || this.canvas !== canvas) this.createRenderer(canvas);
    window.addEventListener('resize', this.resize);
    window.addEventListener('pointermove', this.onPointer, { passive: true });
    document.addEventListener('mouseleave', this.onLeave);
    this.resize();
    if (!this.running) {
      this.running = true;
      this.clock.getDelta();
      this.frame();
    }
  }

  unmount() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.resize);
    window.removeEventListener('pointermove', this.onPointer);
    document.removeEventListener('mouseleave', this.onLeave);
  }

  setMode(mode: StageMode) {
    this.mode = mode;
  }

  setLayout(layout: GameLayout) {
    this.layout = layout;
  }

  setReducedMotion(on: boolean) {
    this.reducedMotion = on;
  }

  /** Puts exactly these agents on stage (1 centred, 2 face to face). */
  showAgents(ids: AgentId[]) {
    for (const id of [...this.slots.keys()]) if (!ids.includes(id)) this.removeSlot(id);
    ids.forEach((id) => {
      if (!this.slots.has(id)) this.addSlot(id);
    });
    this.order = ids;
    ids.forEach((id, i) => {
      const s = this.slots.get(id);
      if (!s) return;
      // agents turn toward the middle of the group
      const half = (ids.length - 1) / 2;
      s.yaw = ids.length === 1 ? 0 : ((half - i) / half) * 0.45;
    });
  }

  setAgentState(id: AgentId, state: AgentState) {
    this.slots.get(id)?.actor.setState(state);
  }

  setAllAgentStates(state: AgentState) {
    this.slots.forEach((s) => s.actor.setState(state));
  }

  /** Sends a message packet from one agent to another (Level 3, and the Orchestrator's tasks and results). */
  fireBeam(from: AgentId, to: AgentId, colour = 0xff5a5f) {
    const a = this.anchor(from);
    const b = this.anchor(to);
    if (a && b) this.beam.fire(a, b, colour);
  }

  /** Where an agent is on the screen, in CSS pixels: above its head or below its pedestal. Null when it is not on stage. */
  screenPos(id: AgentId, part: 'head' | 'base' = 'head'): { x: number; y: number } | null {
    const s = this.slots.get(id);
    if (!s || !this.renderer) return null;
    const y = part === 'head' ? FEET_Y + s.actor.anchorY + 0.55 : PEDESTAL_BOTTOM;
    const v = new THREE.Vector3(s.x, y, 0).project(this.camera);
    return { x: (v.x * 0.5 + 0.5) * window.innerWidth, y: (-v.y * 0.5 + 0.5) * window.innerHeight };
  }

  // ------------------------------------------------------------------ setup

  private createRenderer(canvas: HTMLCanvasElement) {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const pmrem = new THREE.PMREMGenerator(renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.renderer = renderer;
    this.canvas = canvas;
  }

  private addLights() {
    this.scene.add(new THREE.HemisphereLight(0xfff6ee, 0xd9d2c8, 0.7));

    const key = new THREE.DirectionalLight(0xfff3e6, 1.7);
    key.position.set(-3, 5, 4);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.radius = 6;
    key.shadow.bias = -0.0005;
    Object.assign(key.shadow.camera, { left: -5, right: 5, top: 4.5, bottom: -4, near: 0.5, far: 20 });
    key.shadow.camera.updateProjectionMatrix();
    this.scene.add(key);

    const rim = new THREE.DirectionalLight(0xfff0e6, 1.2);
    rim.position.set(4, 2, -4);
    this.scene.add(rim);

    const fill = new THREE.PointLight(0xff9a6a, 2.2, 6);
    fill.position.set(-3.2, 1.2, 0.6);
    this.scene.add(fill);
  }

  private addSlot(id: AgentId) {
    const actor = createActor(id);
    const pedestal = rbox(1.7, 1.6, 1.7, 0.03, this.pedestalMat, 2);
    pedestal.castShadow = false;
    pedestal.rotation.y = -0.28;
    this.scene.add(actor.object, pedestal);
    this.slots.set(id, { id, actor, pedestal, x: 0, targetX: 0, yaw: 0, appear: this.slots.size === 0 ? 1 : 0 });
  }

  private removeSlot(id: AgentId) {
    const s = this.slots.get(id);
    if (!s) return;
    this.scene.remove(s.actor.object, s.pedestal);
    s.actor.dispose();
    s.pedestal.geometry.dispose();
    this.slots.delete(id);
  }

  private anchor(id: AgentId): THREE.Vector3 | null {
    const s = this.slots.get(id);
    if (!s) return null;
    return new THREE.Vector3(s.x, FEET_Y + s.actor.anchorY, 0);
  }

  // ------------------------------------------------------------------ loop

  private readonly resize = () => {
    if (!this.renderer) return;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
  };

  private readonly onPointer = (e: PointerEvent) => {
    this.ptrTarget.x = (e.clientX / window.innerWidth) * 2 - 1;
    this.ptrTarget.y = (e.clientY / window.innerHeight) * 2 - 1;
  };

  private readonly onLeave = () => {
    this.ptrTarget.x = this.ptrTarget.y = 0;
  };

  private readonly frame = () => {
    if (!this.running || !this.renderer) return;
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(this.clock.getDelta(), 0.1);
    const t = this.clock.elapsedTime;
    const W = window.innerWidth;
    const H = window.innerHeight;

    // scroll progress (landing) and mode blend, smoothed per frame
    this.p += (clamp(window.scrollY / H, 0, 2) - this.p) * 0.08;
    this.blend += ((this.mode === 'game' ? 1 : 0) - this.blend) * 0.07;
    this.ptr.x += (this.ptrTarget.x - this.ptr.x) * 0.06;
    this.ptr.y += (this.ptrTarget.y - this.ptr.y) * 0.06;

    const b = this.blend;
    const e = ease(clamp(this.p, 0, 1));
    const mobile = W <= 900 ? 1.25 : 1;

    // camera
    const camZ = lerp(lerp(INTRO.z, PRODUCT.z, e) * mobile, this.layout.dist, b);
    const camY = lerp(lerp(INTRO.y, PRODUCT.y, e), GAME.y, b) - this.ptr.y * 0.1;
    const look = lerp(lerp(INTRO.look, PRODUCT.look, e), GAME.look, b);
    this.camera.position.set(this.ptr.x * 0.25, camY, camZ);
    this.camera.lookAt(0, look, 0);

    // game layout shifts the picture sideways/up so the agent sits beside the text
    // on the landing page the agent drifts a little to the right once the close-up starts, clear of the left-hand text
    const landingShift = W > 900 ? LANDING_SHIFT_X * e : 0;
    const sx = lerp(landingShift, this.layout.shiftX, b);
    const sy = this.layout.shiftY * b;
    if (Math.abs(sx) + Math.abs(sy) > 0.001) this.camera.setViewOffset(W, H, -sx * W, -sy * H, W, H);
    else if (this.camera.view?.enabled) this.camera.clearViewOffset();

    // shared base pose for every agent
    const baseBody = lerp(lerp(INTRO.body, PRODUCT.body, e), GAME.body, b);
    const headYaw = lerp(lerp(INTRO.hYaw, PRODUCT.hYaw, e), GAME.hYaw, b);
    const headPitch = lerp(lerp(INTRO.hPitch, PRODUCT.hPitch, e), GAME.hPitch, b);
    const headRoll = lerp(lerp(INTRO.hRoll, PRODUCT.hRoll, e), GAME.hRoll, b);
    const quote = this.mode === 'landing' && this.p > 1.55;

    this.slots.forEach((s) => {
      const idx = this.order.indexOf(s.id);
      s.targetX = this.order.length <= 1 || idx < 0 ? 0 : (idx - (this.order.length - 1) / 2) * this.layout.spacing;
      s.x += (s.targetX - s.x) * 0.08;
      s.appear = Math.min(1, s.appear + dt * 2.2);
      const scale = Math.max(0.001, ease(s.appear));
      s.actor.object.position.set(s.x, FEET_Y, 0);
      s.actor.object.scale.setScalar(scale);
      s.pedestal.position.set(s.x, -2.22, 0);
      s.pedestal.scale.setScalar(scale);
      s.actor.update({
        t,
        dt,
        pointer: this.ptr,
        pointerGain: lerp(1, 0.55, b),
        pose: { bodyYaw: baseBody + s.yaw * b, headYaw, headPitch, headRoll },
        quote,
        reducedMotion: this.reducedMotion,
      });
    });

    // A2A link between the two agents of a level 3 scene
    if (this.order.length === 2) this.beam.setLink(this.anchor(this.order[0]), this.anchor(this.order[1]));
    else this.beam.setLink(null, null);
    this.beam.update(dt);

    this.renderer.render(this.scene, this.camera);
  };
}
