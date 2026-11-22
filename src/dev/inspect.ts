/**
 * Dev-only model inspector (inspect.html, not part of the production build).
 *   /inspect.html?file=<url>&yaw=<degrees>
 * Loads a GLB or FBX, prints size / triangles / bones / animation clips, and renders it from one angle.
 */
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

const q = new URLSearchParams(location.search);
const file = q.get('file') ?? '';
const yaw = THREE.MathUtils.degToRad(Number(q.get('yaw') ?? 0));
const info = document.getElementById('info')!;
const canvas = document.getElementById('c') as HTMLCanvasElement;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xefece6);
const pm = new THREE.PMREMGenerator(renderer);
scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
scene.add(new THREE.HemisphereLight(0xffffff, 0xd9d2c8, 0.8));
const key = new THREE.DirectionalLight(0xffffff, 1.6);
key.position.set(-2, 3, 4);
scene.add(key);

async function load(url: string): Promise<{ root: THREE.Object3D; clips: THREE.AnimationClip[] }> {
  if (/\.fbx(\?|$)/i.test(url)) {
    const g = await new FBXLoader().loadAsync(url);
    return { root: g, clips: g.animations };
  }
  const g = await new GLTFLoader().loadAsync(url);
  return { root: g.scene, clips: g.animations };
}

try {
  const t0 = performance.now();
  const { root, clips } = await load(file);
  const loadMs = Math.round(performance.now() - t0);
  let tris = 0;
  let meshes = 0;
  let bones = 0;
  const mats = new Set<THREE.Material>();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      meshes++;
      const g = m.geometry;
      tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
      (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => mats.add(x));
    }
    if ((o as THREE.Bone).isBone) bones++;
  });
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  root.position.sub(centre);
  const holder = new THREE.Group();
  holder.add(root);
  holder.rotation.y = yaw;
  scene.add(holder);

  const cam = new THREE.PerspectiveCamera(30, innerWidth / innerHeight, 0.01, 1000);
  const h = Math.max(size.y, size.x, size.z);
  cam.position.set(0, 0, (h / 2 / Math.tan(THREE.MathUtils.degToRad(15))) * 1.25);
  renderer.render(scene, cam);

  info.textContent = [
    `file    ${file.split('/').pop()}`,
    `load    ${loadMs} ms`,
    `size    ${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)}`,
    `meshes  ${meshes}   triangles ${Math.round(tris).toLocaleString()}`,
    `bones   ${bones}   clips ${clips.length}${clips.length ? ' (' + clips.map((c) => c.name).join(', ') + ')' : ''}`,
    `mats    ${[...mats].map((m) => m.type).join(', ')}`,
  ].join('\n');
  document.title = 'ready';
} catch (e) {
  info.textContent = 'ERROR ' + (e as Error).message;
  document.title = 'error';
}
