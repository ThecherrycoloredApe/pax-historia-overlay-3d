/**
 * Conversion OBJ (+ MTL) → GLB optimisé pour l'overlay.
 *
 *   node tools/obj-to-glb.mjs <entree.obj> <sortie.glb>
 *
 * Les packs Quaternius (et la plupart des kits hors Kenney) ne sont livrés
 * qu'en .obj/.fbx/.blend : notre chargeur ne lit que le glTF, d'où ce script.
 *
 * Pipeline en 3 temps :
 *   1. obj2gltf  — OBJ+MTL → GLB (les couleurs du .mtl deviennent des
 *                  matériaux glTF ; préférer les exports « with Materials »,
 *                  qui évitent toute texture externe à embarquer).
 *   2. prune     — supprime les accesseurs inutiles, en particulier les
 *                  TEXCOORD_0 : sans texture, les UV ne servent à rien.
 *   3. quantize  — float32 → entiers courts via KHR_mesh_quantization, une
 *                  extension gérée NATIVEMENT par three.js (aucun décodeur à
 *                  charger, contrairement à Draco ou meshopt).
 *
 * Gain observé sur l'Ultimate Buildings Pack : ~45 % (1548 → 860 Ko sur 6
 * bâtiments). Ne PAS ajouter de compression Draco/meshopt sans câbler le
 * décodeur correspondant dans asset-models.ts — le chargement échouerait.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('Usage : node tools/obj-to-glb.mjs <entree.obj> <sortie.glb>');
  process.exit(1);
}
if (!existsSync(input)) {
  console.error(`Introuvable : ${input}`);
  process.exit(1);
}

// npx sur Windows est un .cmd → shell requis pour le résoudre.
const run = (cmd) => execFileSync(cmd, { shell: true, stdio: ['ignore', 'ignore', 'inherit'] });
const ko = (p) => Math.round(statSync(p).size / 1024);

const work = mkdtempSync(join(tmpdir(), 'obj2glb-'));
try {
  const raw = join(work, 'raw.glb');
  const pruned = join(work, 'pruned.glb');
  run(`npx --no-install obj2gltf -i "${input}" -o "${raw}"`);
  run(`npx --no-install gltf-transform prune "${raw}" "${pruned}" --keep-attributes false`);
  run(`npx --no-install gltf-transform quantize "${pruned}" "${output}"`);
  console.log(`${input} → ${output} : ${ko(raw)} Ko → ${ko(output)} Ko`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
