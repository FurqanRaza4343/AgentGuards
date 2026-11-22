import * as THREE from 'three';

interface Packet {
  core: THREE.Mesh;
  halo: THREE.Mesh;
  from: THREE.Vector3;
  to: THREE.Vector3;
  mid: THREE.Vector3;
  age: number;
  duration: number;
}

const CORE = new THREE.SphereGeometry(0.1, 16, 12);
const HALO = new THREE.SphereGeometry(0.24, 16, 12);

/** The A2A channel: a faint link between two agents and message packets flying along it. */
export class AgentBeam {
  readonly group = new THREE.Group();
  private readonly link: THREE.Line;
  private readonly linkMat = new THREE.LineBasicMaterial({ color: 0x141414, transparent: true, opacity: 0.28 });
  private readonly packets: Packet[] = [];

  constructor() {
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, 1)]);
    this.link = new THREE.Line(geo, this.linkMat);
    this.link.visible = false;
    this.group.add(this.link);
  }

  setLink(a: THREE.Vector3 | null, b: THREE.Vector3 | null) {
    if (!a || !b) {
      this.link.visible = false;
      return;
    }
    const pos = this.link.geometry.attributes.position as THREE.BufferAttribute;
    pos.setXYZ(0, a.x, a.y, a.z);
    pos.setXYZ(1, b.x, b.y, b.z);
    pos.needsUpdate = true;
    this.link.geometry.computeBoundingSphere();
    this.link.visible = true;
  }

  fire(from: THREE.Vector3, to: THREE.Vector3, colour: number) {
    const mid = from.clone().add(to).multiplyScalar(0.5);
    mid.y += 1.1;
    const core = new THREE.Mesh(CORE, new THREE.MeshBasicMaterial({ color: colour }));
    const halo = new THREE.Mesh(HALO, new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.28, depthWrite: false }));
    core.position.copy(from);
    halo.position.copy(from);
    this.group.add(core, halo);
    this.packets.push({ core, halo, from: from.clone(), to: to.clone(), mid, age: 0, duration: 1.1 });
  }

  update(dt: number) {
    for (let i = this.packets.length - 1; i >= 0; i--) {
      const p = this.packets[i];
      p.age += dt;
      const k = Math.min(1, p.age / p.duration);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      const a = 1 - e;
      // quadratic bezier: from -> mid -> to
      p.core.position.set(
        a * a * p.from.x + 2 * a * e * p.mid.x + e * e * p.to.x,
        a * a * p.from.y + 2 * a * e * p.mid.y + e * e * p.to.y,
        a * a * p.from.z + 2 * a * e * p.mid.z + e * e * p.to.z,
      );
      p.halo.position.copy(p.core.position);
      p.halo.scale.setScalar(1 + 0.25 * Math.sin(p.age * 18));
      if (k >= 1) {
        this.group.remove(p.core, p.halo);
        (p.core.material as THREE.Material).dispose();
        (p.halo.material as THREE.Material).dispose();
        this.packets.splice(i, 1);
      }
    }
  }
}
