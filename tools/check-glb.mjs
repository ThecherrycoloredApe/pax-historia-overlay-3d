/**
 * Vérifie que chaque .glb embarqué se parse bien avec LE MÊME GLTFLoader que
 * l'overlay (three.js), et affiche mesh/triangles.
 *
 *   node tools/check-glb.mjs [dossier]        (défaut : src/render3d/assets)
 *
 * À lancer après toute conversion (voir tools/obj-to-glb.mjs) : `buildTemplates()`
 * charge tous les modèles via un `Promise.all`, donc UN SEUL fichier illisible
 * fait échouer l'ensemble et bascule TOUS les types sur les modèles procéduraux.
 *
 * Note : les modèles Kenney référencent une texture externe (`colormap.png`)
 * résolue à l'exécution par un URLModifier ; hors navigateur cette texture ne
 * peut pas être chargée. Un avertissement de texture n'est donc pas un échec —
 * seule la géométrie est vérifiée ici.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const dir = process.argv[2] ?? join('src', 'render3d', 'assets');
if (!existsSync(dir)) {
  console.error(`Dossier introuvable : ${dir}`);
  process.exit(1);
}

/** Erreur due à l'absence d'API navigateur (chargement de texture), pas au modèle. */
const estArtefactNode = (msg) => /\bself is not defined\b|createImageBitmap|URL\.createObjectURL/i.test(msg);

const loader = new GLTFLoader();
const files = readdirSync(dir).filter((f) => f.endsWith('.glb')).sort();
let ok = 0;
let ko = 0;
let skip = 0;

for (const f of files) {
  const bytes = readFileSync(join(dir, f));
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  await new Promise((resolve) => {
    loader.parse(
      ab,
      '',
      (gltf) => {
        let meshes = 0;
        let tris = 0;
        gltf.scene.traverse((o) => {
          if (o.isMesh) {
            meshes++;
            const g = o.geometry;
            tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
          }
        });
        console.log(`OK     ${f.padEnd(34)} ${String(meshes).padStart(3)} mesh  ${String(Math.round(tris)).padStart(6)} tris`);
        ok++;
        resolve();
      },
      (err) => {
        const msg = String(err?.message ?? err);
        if (estArtefactNode(msg)) {
          console.log(`SKIP   ${f.padEnd(34)} texture externe, non verifiable hors navigateur`);
          skip++;
        } else {
          console.log(`ECHEC  ${f.padEnd(34)} ${msg.slice(0, 90)}`);
          ko++;
        }
        resolve();
      },
    );
  });
}
console.log(`\n=> ${ok} OK, ${skip} non verifiables (texture), ${ko} en echec`);
process.exit(ko ? 1 : 0);
