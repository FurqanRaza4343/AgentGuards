import * as THREE from 'three';
import type { AgentSkin } from '../../agents';
import { FaceScreen, type Expression } from '../face';
import { ball, cyl, disposeTree, frameGeo, mulberry32, plateGeo, put, rbox, shadowed } from '../geometry';
import type { ActorContext, AgentActor, AgentState } from './types';

/** torso centre sits this far above the feet */
const FEET = 1.42;
const ENV_INTENSITY = 0.9;

const EXPRESSION: Record<AgentState, Expression> = {
  idle: 'eyes',
  thinking: 'thinking',
  working: 'thinking',
  alert: 'alert',
  success: 'success',
  fail: 'fail',
};

interface Pose {
  pitch: number;
  roll: number;
  slump: number;
  /** forearms raised, "typing" posture */
  armLift: number;
  shake: number;
  wobble: number;
  glow: number;
  /** both arms up and out */
  cheer: number;
  /** right arm out in front, palm forward: "stop" */
  stop: number;
}

const ZERO: Pose = { pitch: 0, roll: 0, slump: 0, armLift: 0, shake: 0, wobble: 0, glow: 0, cheer: 0, stop: 0 };

const TARGET: Record<AgentState, Pose> = {
  idle: ZERO,
  thinking: { ...ZERO, pitch: 0.03, armLift: 0.55, wobble: 0.8 },
  working: { ...ZERO, pitch: 0.05, armLift: 1, wobble: 1.3 },
  alert: { ...ZERO, pitch: -0.06, shake: 1, glow: 1, stop: 1 },
  success: { ...ZERO, glow: 0.6, cheer: 1 },
  fail: { ...ZERO, pitch: 0.3, roll: 0.08, slump: 1, glow: 0.4 },
};

const GLOW_COLOUR: Partial<Record<AgentState, number>> = { alert: 0xff2a2a, success: 0x35e0a0, fail: 0xff5030 };
const LED_STATE_COLOUR: Partial<Record<AgentState, number>> = { alert: 0xff2a2a, success: 0x37e29a, fail: 0x5a1010 };

/** The boxy ceramic robot, built entirely from three.js primitives and coloured by an AgentSkin. */
export class RobotActor implements AgentActor {
  readonly object = new THREE.Group();
  readonly anchorY = FEET + 1.56;

  private readonly robot = new THREE.Group();
  private readonly head = new THREE.Group();
  private readonly face = new FaceScreen();
  private readonly arms: { side: number; shoulder: THREE.Group; fore: THREE.Group }[] = [];
  private readonly leds: THREE.MeshStandardMaterial[] = [];
  private readonly ledBase: number[];
  private readonly glow = new THREE.PointLight(0xff2a2a, 0, 6, 2);
  private readonly cur: Pose = { ...ZERO };
  private state: AgentState = 'idle';
  private stateT = 0;

  constructor(skin: AgentSkin) {
    this.ledBase = [...skin.leds];
    this.build(skin);
  }

  setState(state: AgentState) {
    if (state === this.state) return;
    this.state = state;
    this.stateT = 0;
    const c = GLOW_COLOUR[state];
    if (c !== undefined) this.glow.color.setHex(c);
  }

  update(ctx: ActorContext) {
    const { t, dt, pointer, pose, reducedMotion } = ctx;
    this.stateT += dt;

    // ease the pose values toward the target of the current state
    const k = 1 - Math.exp(-dt * 6);
    const target = TARGET[this.state];
    for (const key of Object.keys(this.cur) as (keyof Pose)[]) this.cur[key] += (target[key] - this.cur[key]) * k;

    const g = ctx.pointerGain;
    const shake = reducedMotion ? 0 : this.cur.shake;
    const wobble = reducedMotion ? 0 : this.cur.wobble;
    const nod = this.state === 'success' && !reducedMotion ? Math.max(0, 1 - this.stateT / 1.4) : 0;
    // the cheer settles after a moment instead of holding both arms up for as long as the card is on screen
    const cheer = this.cur.cheer * Math.max(0.35, 1 - this.stateT / 2.6);
    const wave = reducedMotion ? 0 : Math.sin(t * 9);

    // body: bob, yaw, tiny shake when alarmed, forward lean when slumped, a hop when cheering
    this.robot.rotation.set(this.cur.slump * 0.08, pose.bodyYaw + pointer.x * 0.12 * g, 0);
    this.robot.position.set(
      Math.sin(t * 61) * 0.012 * shake,
      FEET + Math.sin(t * 1.4) * 0.02 + (reducedMotion ? 0 : Math.max(0, Math.sin(this.stateT * 8)) * 0.1 * cheer * (this.stateT < 1.4 ? 1 : 0)),
      0,
    );

    // head
    this.head.rotation.set(
      pose.headPitch + pointer.y * 0.18 * g + Math.sin(t * 0.9) * 0.02 + this.cur.pitch + Math.sin(this.stateT * 9) * 0.14 * nod,
      pose.headYaw + pointer.x * 0.45 * g + Math.sin(t * 2.4) * 0.07 * wobble,
      pose.headRoll + Math.sin(t * 0.7) * 0.02 + this.cur.roll + Math.cos(t * 2.4) * 0.03 * wobble,
      'YXZ',
    );

    // arms: idle swing, typing posture while working, hands up when cheering, a stop gesture when alarmed, limp when slumped
    for (const a of this.arms) {
      const lift = this.cur.armLift;
      const type = reducedMotion ? 0 : Math.sin(t * 14 + a.side * 1.7) * 0.12 * lift;
      const stop = a.side === 1 ? this.cur.stop : 0; // the robot's left arm, on the right of the screen
      a.shoulder.rotation.x =
        Math.sin(t * 1.4 + a.side) * 0.05 - lift * 0.4 + type * 0.4 - stop * 1.25 - cheer * 0.5;
      a.shoulder.rotation.z = a.side * (0.16 - 0.1 * this.cur.slump + cheer * (1.55 + wave * 0.12));
      a.fore.rotation.x = -0.35 + Math.sin(t * 1.4 + a.side + 1) * 0.06 - lift * 0.55 + type + stop * 0.2 - cheer * 0.2;
    }

    this.updateLeds(t, reducedMotion);
    this.glow.intensity = this.cur.glow * (this.state === 'alert' && !reducedMotion ? 7 + 4 * Math.sin(t * 12) : 7);

    this.face.set(ctx.quote ? 'quote' : EXPRESSION[this.state], ctx.quote ? 0 : 0.3);
    this.face.update(t, reducedMotion);
  }

  dispose() {
    disposeTree(this.object);
    this.glow.dispose();
  }

  // ---------------------------------------------------------------- LEDs

  private updateLeds(t: number, reduced: boolean) {
    const override = LED_STATE_COLOUR[this.state];
    this.leds.forEach((m, i) => {
      if (override !== undefined) {
        m.color.setHex(override);
        m.emissive.setHex(override);
        m.emissiveIntensity =
          this.state === 'alert' ? (reduced ? 2.4 : 1.5 + 1.5 * Math.sin(t * 14)) : this.state === 'fail' ? 0.4 : 2.4;
        return;
      }
      m.color.setHex(this.ledBase[i]);
      m.emissive.setHex(this.ledBase[i]);
      m.emissiveIntensity =
        this.state === 'thinking' || this.state === 'working'
          ? reduced
            ? 1.6
            : 0.4 + 1.8 * Math.max(0, Math.sin(t * 7 - i * 1.2))
          : 2.2;
    });
  }

  // ---------------------------------------------------------------- build

  private ringTexture(skin: AgentSkin) {
    const c = document.createElement('canvas');
    c.width = c.height = 512;
    const x = c.getContext('2d');
    if (!x) throw new Error('2D canvas is not available');
    const [c0, c1, c2, c3] = skin.ring;
    const stops = [c0, c1, c2, c3, c2, c1, c0];
    const g = x.createConicGradient ? x.createConicGradient(-Math.PI * 0.39, 256, 256) : x.createLinearGradient(0, 0, 512, 512);
    stops.forEach((s, i) => g.addColorStop(i / (stops.length - 1), s));
    x.fillStyle = g;
    x.fillRect(0, 0, 512, 512);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    return tex;
  }

  private build(skin: AgentSkin) {
    const ringTex = this.ringTexture(skin);
    const clearcoat = { clearcoat: 0.45, clearcoatRoughness: 0.3 };
    const M = {
      shell: new THREE.MeshPhysicalMaterial({ color: skin.shell, roughness: 0.38, ...clearcoat }),
      shellL: new THREE.MeshPhysicalMaterial({ color: skin.shellLight, roughness: 0.34, ...clearcoat }),
      foot: new THREE.MeshPhysicalMaterial({ color: skin.foot, roughness: 0.34, ...clearcoat }),
      dark: new THREE.MeshStandardMaterial({ color: skin.joint, roughness: 0.55, metalness: 0.3 }),
      trim: new THREE.MeshStandardMaterial({ color: skin.trim, roughness: 0.45, metalness: 0.25 }),
      bar: new THREE.MeshStandardMaterial({ color: 0x3a3a43, roughness: 0.45, metalness: 0.5 }),
      ring: new THREE.MeshPhysicalMaterial({
        color: 0xffffff,
        map: ringTex,
        emissive: 0xffffff,
        emissiveMap: ringTex,
        emissiveIntensity: 0.22,
        roughness: 0.5,
        clearcoat: 0.35,
      }),
      screen: new THREE.MeshPhysicalMaterial({
        color: 0x060608,
        roughness: 0.12,
        metalness: 0,
        clearcoat: 1,
        clearcoatRoughness: 0.04,
        emissive: 0xffffff,
        emissiveMap: this.face.texture,
        emissiveIntensity: 1.6,
      }),
    };
    for (const m of Object.values(M)) m.envMapIntensity = ENV_INTENSITY;

    const { robot, head } = this;
    this.object.add(robot);

    // torso
    put(robot, rbox(1.22, 1.12, 0.92, 0.24, M.shell, 6));
    put(robot, rbox(0.9, 0.1, 0.64, 0.04, M.shellL, 3), 0, 0.56, 0.02);
    skin.leds.forEach((hex, i) => {
      const mat = new THREE.MeshStandardMaterial({ color: hex, emissive: hex, emissiveIntensity: 2.2, roughness: 0.4 });
      mat.envMapIntensity = ENV_INTENSITY;
      this.leds.push(mat);
      const led = new THREE.Mesh(new THREE.SphereGeometry(0.05, 20, 14), mat);
      put(robot, led, (i - 1) * 0.22, 0.27, 0.455);
    });
    for (const x of [-0.2, 0.2]) {
      put(robot, rbox(0.1, 0.34, 0.04, 0.02, M.dark, 3), x, -0.12, 0.452);
      const lip = shadowed(new THREE.Mesh(new THREE.TorusGeometry(0.065, 0.017, 10, 20, Math.PI), M.dark));
      put(robot, lip, x, 0.05, 0.455);
    }
    put(robot, rbox(1.02, 0.2, 0.78, 0.08, M.dark, 4), 0, -0.6, 0);
    put(robot, cyl(0.2, 0.24, 0.42, M.dark), 0, 0.72, 0);

    // legs
    for (const s of [-1, 1]) {
      put(robot, ball(0.13, M.dark), s * 0.32, -0.7, 0);
      put(robot, rbox(0.34, 0.4, 0.4, 0.1, M.shell), s * 0.32, -0.94, 0);
      put(robot, cyl(0.1, 0.1, 0.1, M.dark, 24), s * 0.32, -1.2, 0);
      put(robot, rbox(0.44, 0.2, 0.62, 0.09, M.foot), s * 0.32, -1.32, 0.07);
      put(robot, rbox(0.46, 0.05, 0.64, 0.02, M.dark, 2), s * 0.32, -1.4, 0.07); // sole
      put(robot, rbox(0.46, 0.035, 0.5, 0.015, M.trim, 2), s * 0.32, -1.3, 0.1); // stripe across the toe
    }

    // arms
    for (const side of [-1, 1]) {
      const shoulder = new THREE.Group();
      shoulder.position.set(side * 0.76, 0.34, 0);
      shoulder.rotation.z = side * 0.16;
      robot.add(shoulder);
      shoulder.add(ball(0.14, M.dark));
      put(shoulder, rbox(0.25, 0.42, 0.25, 0.09, M.shell), 0, -0.26, 0);
      const elbow = new THREE.Group();
      elbow.position.y = -0.47;
      shoulder.add(elbow);
      elbow.add(ball(0.115, M.dark));
      const fore = new THREE.Group();
      fore.rotation.x = -0.35;
      elbow.add(fore);
      put(fore, rbox(0.23, 0.34, 0.23, 0.08, M.shell), 0, -0.2, 0);
      put(fore, rbox(0.25, 0.045, 0.25, 0.02, M.trim, 2), 0, -0.345, 0); // wrist band
      put(fore, rbox(0.3, 0.19, 0.27, 0.07, M.shellL), 0, -0.47, 0);
      put(fore, rbox(0.08, 0.13, 0.1, 0.03, M.shellL), -side * 0.17, -0.46, 0.05);
      this.arms.push({ side, shoulder, fore });
    }

    // head: pivots at y .78, the skull centre sits .78 above the pivot
    head.position.y = 0.78;
    robot.add(head);
    const hc = new THREE.Group();
    hc.position.y = 0.78;
    head.add(hc);

    put(hc, rbox(1.5, 1.42, 1.3, 0.2, M.shell, 7));
    put(hc, rbox(1.28, 1.14, 0.9, 0.14, M.dark, 5), 0, 0, -0.5);

    const rnd = mulberry32(11);
    for (let i = 0; i < 26; i++) {
      const onTop = i >= 17;
      const horiz = rnd() > 0.5;
      const len = 0.1 + rnd() * 0.24;
      const th = 0.026;
      let geo: THREE.BoxGeometry;
      let x: number;
      let y: number;
      let z: number;
      if (!onTop) {
        geo = new THREE.BoxGeometry(horiz ? len : th, horiz ? th : len, 0.014);
        x = (rnd() - 0.5) * 1.0;
        y = (rnd() - 0.5) * 0.86;
        z = -0.5 - 0.45 - 0.005;
      } else {
        geo = new THREE.BoxGeometry(horiz ? len : th, 0.014, horiz ? th : len);
        x = (rnd() - 0.5) * 1.0;
        y = 0.57 + 0.005;
        z = -0.5 + (rnd() - 0.5) * 0.7;
      }
      put(hc, new THREE.Mesh(geo, M.bar), x, y, z);
    }

    put(hc, shadowed(new THREE.Mesh(frameGeo(1.5, 1.44, 0.3, 1.08, 1.02, 0.2, 0.1, 0.03), M.ring)), 0, 0, 0.6);
    put(hc, shadowed(new THREE.Mesh(frameGeo(1.08, 1.02, 0.2, 0.88, 0.82, 0.13, 0.06, 0), M.shellL)), 0, 0, 0.62);
    put(hc, new THREE.Mesh(plateGeo(0.9, 0.84, 0.14, 0.04), M.screen), 0, 0, 0.64);

    for (const s of [-1, 1]) {
      const ear = cyl(0.22, 0.22, 0.16, M.shell, 40);
      ear.rotation.z = Math.PI / 2;
      put(hc, ear, s * 0.83, 0, 0);
      const cap = cyl(0.14, 0.14, 0.05, M.dark, 32);
      cap.rotation.z = Math.PI / 2;
      put(hc, cap, s * 0.92, 0, 0);
    }
    const cable = shadowed(new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.03, 12, 28, Math.PI), M.dark));
    cable.rotation.z = -Math.PI / 2;
    put(hc, cable, 0.93, -0.42, 0);

    // red / green glow in front of the face, driven by the agent state
    this.object.add(this.glow);
    this.glow.position.set(0, FEET + 1.7, 1.7);
  }
}
