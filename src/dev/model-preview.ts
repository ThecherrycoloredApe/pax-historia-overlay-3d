/**
 * Harnais de prévisualisation des modèles (dev uniquement, hors extension).
 * Rend chaque modèle avec l'orientation/éclairage exacts de l'overlay puis
 * POSTe la planche PNG au serveur local (/save) pour inspection.
 *
 * Les types à variantes sont rendus UNE FOIS PAR VARIANTE : on cherche un seed
 * dont le hash retombe sur l'index voulu, avec la même fonction de hachage que
 * asset-models.ts. Sans ça un tirage au hasard peut masquer une variante ratée.
 */

import * as THREE from 'three';
import { makeModel } from '../render3d/models';
import { loadAssetTemplates } from '../render3d/asset-models';
import type { StructureType } from '../parser';
import type { StructureState } from '../structures';

const TILT_X = 0.65;
const YAW_Y = 0.45;
const CELL = 220;
const COLS = 5;

/** Copie de asset-models.ts — À GARDER SYNCHRONISÉ (harnais dev uniquement). */
function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Premier seed dont le hash retombe sur la variante voulue. */
function seedFor(type: string, variant: number, n: number): string {
  for (let i = 0; i < 10000; i++) {
    const s = `${type}-${i}`;
    if (hashString(s) % n === variant) return s;
  }
  return `${type}-0`;
}

/** [type, état, nombre de variantes] — À GARDER SYNCHRONISÉ avec VARIANTS. */
const TYPES: Array<[StructureType, StructureState, number]> = [
  ['factory', 'built', 3],
  ['infrastructure', 'built', 2],
  ['depot', 'built', 2],
  ['hq', 'built', 2],
  ['research', 'built', 2],
  ['finance', 'built', 2],
  ['policy', 'built', 2],
  ['generic', 'built', 6],
  ['nuclear_plant', 'built', 1],
  ['port', 'built', 1],
  ['monument', 'built', 1],
  ['hospital', 'built', 1],
  ['military_base', 'built', 1],
  ['airport', 'built', 1],
  ['dam', 'built', 1],
  ['factory', 'under_construction', 1],
  ['factory', 'destroyed', 1],
];

const CELLS: Array<[StructureType, StructureState, string, string]> = TYPES.flatMap(
  ([type, state, n]) =>
    Array.from({ length: n }, (_, v) => {
      const suffix =
        state === 'under_construction' ? ' (chantier)' : state === 'destroyed' ? ' (ruines)' : '';
      const label = n > 1 ? `${type} #${v}` : `${type}${suffix}`;
      return [type, state, seedFor(type, v, n), label] as [
        StructureType,
        StructureState,
        string,
        string,
      ];
    }),
);

function renderOne(
  renderer: THREE.WebGLRenderer,
  type: StructureType,
  state: StructureState,
  seed: string,
): void {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xdfe8f0);
  scene.add(new THREE.AmbientLight(0xffffff, 1.15));
  const sun = new THREE.DirectionalLight(0xffffff, 1.5);
  sun.position.set(0.6, 1, 2);
  scene.add(sun);

  const cam = new THREE.OrthographicCamera(-0.8, 0.8, 0.95, -0.65, -10, 10);
  cam.position.z = 5;

  const wrapper = new THREE.Group();
  wrapper.rotation.x = TILT_X;
  const model = makeModel(type, state, seed);
  model.rotation.y = YAW_Y;
  wrapper.add(model);
  scene.add(wrapper);

  renderer.render(scene, cam);
}

async function main(): Promise<void> {
  await loadAssetTemplates();

  const gl = document.createElement('canvas');
  const renderer = new THREE.WebGLRenderer({ canvas: gl, antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(CELL, CELL);

  const sheet = document.createElement('canvas');
  sheet.width = COLS * CELL;
  sheet.height = Math.ceil(CELLS.length / COLS) * CELL;
  const ctx = sheet.getContext('2d')!;

  CELLS.forEach(([type, state, seed, label], i) => {
    renderOne(renderer, type, state, seed);
    const x = (i % COLS) * CELL;
    const y = Math.floor(i / COLS) * CELL;
    ctx.drawImage(gl, x, y, CELL, CELL);
    ctx.fillStyle = '#1a1a1a';
    ctx.font = 'bold 13px system-ui';
    ctx.fillText(label, x + 8, y + 18);
  });

  document.body.appendChild(sheet);
  await fetch('/save', { method: 'POST', body: sheet.toDataURL('image/png') });
  document.title = 'PREVIEW_SAVED';
}

main().catch((e) => {
  console.error(e);
  document.title = 'PREVIEW_FAILED';
});
