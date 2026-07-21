/**
 * Planche de contact d'un kit d'assets BRUT (dev uniquement, hors extension).
 *
 * Rend chaque .glb d'un dossier servi par tools/preview-server.mjs, avec son
 * NOM DE FICHIER en légende, dans l'orientation et l'éclairage de l'overlay.
 *
 * RAISON D'ÊTRE : les kits nomment leurs modèles `building-a` … `building-t`.
 * Impossible de savoir lequel est une halle d'usine sans les regarder — et
 * choisir au hasard donne des résultats absurdes. Cette planche remplace la
 * devinette. Usage : http://localhost:5599/sheet?dir=industrial
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const TILT_X = 0.65;
const YAW_Y = 0.45;
const CELL = 220;
const COLS = 5;

/** Même normalisation que asset-models.ts : emprise ≈ 1, base au sol, centré. */
function normalize(group: THREE.Group): THREE.Group {
  const box = new THREE.Box3().setFromObject(group);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  const footprint = Math.max(size.x, size.z) || 1;
  let scale = 1 / footprint;
  const MAX_HEIGHT = 1.25;
  if (size.y * scale > MAX_HEIGHT) scale = MAX_HEIGHT / size.y;
  const wrapper = new THREE.Group();
  group.position.set(-center.x, -box.min.y, -center.z);
  wrapper.add(group);
  wrapper.scale.setScalar(scale);
  const root = new THREE.Group();
  root.add(wrapper);
  return root;
}

async function main(): Promise<void> {
  const dir = new URLSearchParams(location.search).get('dir') ?? 'industrial';
  const names: string[] = await (await fetch(`/kit-list?dir=${dir}`)).json();

  // La colormap du kit est servie à côté des modèles : on y route toute
  // référence de texture, comme le fait l'overlay en production.
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) =>
    /colormap|\.png$/i.test(url) ? `/kit/${dir}/colormap.png` : url,
  );
  const loader = new GLTFLoader(manager);

  const gl = document.createElement('canvas');
  const renderer = new THREE.WebGLRenderer({ canvas: gl, antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(CELL, CELL);

  const sheet = document.createElement('canvas');
  sheet.width = COLS * CELL;
  sheet.height = Math.ceil(names.length / COLS) * CELL;
  const ctx = sheet.getContext('2d')!;

  for (let i = 0; i < names.length; i++) {
    const name = names[i]!;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xdfe8f0);
    scene.add(new THREE.AmbientLight(0xffffff, 1.15));
    const sun = new THREE.DirectionalLight(0xffffff, 1.5);
    sun.position.set(0.6, 1, 2);
    scene.add(sun);

    const cam = new THREE.OrthographicCamera(-0.8, 0.8, 0.95, -0.65, -10, 10);
    cam.position.z = 5;

    const gltf = await loader.loadAsync(`/kit/${dir}/${name}`);
    const model = normalize(gltf.scene);
    model.rotation.y = YAW_Y;
    const wrapper = new THREE.Group();
    wrapper.rotation.x = TILT_X;
    wrapper.add(model);
    scene.add(wrapper);
    renderer.render(scene, cam);

    const x = (i % COLS) * CELL;
    const y = Math.floor(i / COLS) * CELL;
    ctx.drawImage(gl, x, y, CELL, CELL);
    ctx.fillStyle = '#1a1a1a';
    ctx.font = 'bold 13px system-ui';
    ctx.fillText(name.replace(/\.glb$/i, ''), x + 8, y + 18);
  }

  document.body.appendChild(sheet);
  await fetch(`/save?name=kit-${dir}`, { method: 'POST', body: sheet.toDataURL('image/png') });
  document.title = 'PREVIEW_SAVED';
}

main().catch((e) => {
  console.error(e);
  document.title = 'PREVIEW_FAILED';
});
