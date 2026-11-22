import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

export function shadowed<T extends THREE.Mesh>(mesh: T): T {
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

export const rbox = (w: number, h: number, d: number, r: number, mat: THREE.Material, seg = 5) =>
  shadowed(new THREE.Mesh(new RoundedBoxGeometry(w, h, d, seg, r), mat));

export const ball = (r: number, mat: THREE.Material) =>
  shadowed(new THREE.Mesh(new THREE.SphereGeometry(r, 28, 18), mat));

export const cyl = (rt: number, rb: number, h: number, mat: THREE.Material, seg = 36) =>
  shadowed(new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat));

export function put<T extends THREE.Object3D>(parent: THREE.Object3D, obj: T, x = 0, y = 0, z = 0): T {
  obj.position.set(x, y, z);
  parent.add(obj);
  return obj;
}

export function roundRectPath(p: THREE.Path, w: number, h: number, r: number) {
  const x = -w / 2;
  const y = -h / 2;
  p.moveTo(x + r, y);
  p.lineTo(x + w - r, y);
  p.absarc(x + w - r, y + r, r, -Math.PI / 2, 0, false);
  p.lineTo(x + w, y + h - r);
  p.absarc(x + w - r, y + h - r, r, 0, Math.PI / 2, false);
  p.lineTo(x + r, y + h);
  p.absarc(x + r, y + h - r, r, Math.PI / 2, Math.PI, false);
  p.lineTo(x, y + r);
  p.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5, false);
}

/** UVs from the shape's own bounds, so a texture wraps around the whole frame. */
export function remapUV(geo: THREE.BufferGeometry, w: number, h: number) {
  const p = geo.attributes.position;
  const uv = geo.attributes.uv;
  for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / w + 0.5, p.getY(i) / h + 0.5);
  uv.needsUpdate = true;
}

/** Extruded rounded-rect frame (outer minus inner), bevel kept inside the outer size. */
export function frameGeo(ow: number, oh: number, or: number, iw: number, ih: number, ir: number, depth: number, bevel: number) {
  const s = new THREE.Shape();
  roundRectPath(s, ow, oh, or);
  const hole = new THREE.Path();
  roundRectPath(hole, iw, ih, ir);
  s.holes.push(hole);
  const g = new THREE.ExtrudeGeometry(s, {
    depth,
    steps: 1,
    curveSegments: 22,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: -bevel,
    bevelSegments: 3,
  });
  remapUV(g, ow, oh);
  return g;
}

export function plateGeo(w: number, h: number, r: number, depth: number) {
  const s = new THREE.Shape();
  roundRectPath(s, w, h, r);
  const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false, curveSegments: 22 });
  remapUV(g, w, h);
  return g;
}

export function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Frees geometries, materials and textures below an object. */
export function disposeTree(root: THREE.Object3D) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (!mat) return;
    for (const m of Array.isArray(mat) ? mat : [mat]) {
      for (const v of Object.values(m)) if (v instanceof THREE.Texture) v.dispose();
      m.dispose();
    }
  });
}
