/**
 * Fiche d'identité d'un ou plusieurs .glb — à passer AVANT d'intégrer un
 * nouveau modèle.
 *
 *   node tools/glb-stats.mjs <fichier.glb> [autres.glb …]
 *
 * Affiche poids, triangles, meshes, matériaux, textures embarquées, et le
 * `generator` qui trahit souvent la provenance (Sketchfab, Blender, obj2gltf…).
 *
 * Trois signaux d'alerte :
 *   - generator « Sketchfab-* » → licence à VÉRIFIER à la source. Le projet
 *     n'embarque que du CC0, or Sketchfab est majoritairement CC-BY ou non
 *     redistribuable, et le fichier ne porte pas sa licence.
 *   - triangles » 3000 → invisible à 24–150 px mais alourdit le bundle, qui
 *     est injecté à document_start sur chaque page du jeu.
 *   - textures photo (jpeg de plusieurs centaines de Ko) → jure avec la
 *     direction artistique low-poly à aplats de Kenney/Quaternius.
 */

import { NodeIO } from '@gltf-transform/core';
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions';
import { statSync } from 'node:fs';
import { basename } from 'node:path';

const io = new NodeIO().registerExtensions(KHRONOS_EXTENSIONS);
const files = process.argv.slice(2);
if (!files.length) {
  console.error('Usage : node tools/glb-stats.mjs <fichier.glb> [autres.glb …]');
  process.exit(1);
}

for (const path of files) {
  const name = basename(path);
  let doc;
  try {
    doc = await io.read(path);
  } catch (e) {
    // Cas normal des kits Kenney : la texture colormap est externe au .glb et
    // n'est résolue qu'à l'exécution, par le URLModifier de asset-models.ts.
    console.log(`${name.padEnd(26)} illisible hors contexte (${String(e.message).slice(0, 60)})`);
    continue;
  }

  const root = doc.getRoot();
  let tris = 0;
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      const pos = prim.getAttribute('POSITION');
      tris += (idx ? idx.getCount() : pos ? pos.getCount() : 0) / 3;
    }
  }
  const textures = root.listTextures().map((t) => {
    const img = t.getImage();
    return `${t.getMimeType().replace('image/', '')} ${img ? Math.round(img.byteLength / 1024) : '?'}Ko`;
  });
  const asset = root.getAsset();

  console.log(
    `${name.padEnd(26)} ${String(Math.round(statSync(path).size / 1024)).padStart(6)} Ko  ` +
      `${String(Math.round(tris)).padStart(7)} tris  ` +
      `${String(root.listMeshes().length).padStart(3)} meshes  ` +
      `${String(root.listMaterials().length).padStart(3)} mat  ` +
      `${String(textures.length).padStart(2)} tex`,
  );
  if (asset.generator) console.log(`   generator : ${asset.generator}`);
  if (asset.copyright) console.log(`   copyright : ${asset.copyright}`);
  if (textures.length) console.log(`   textures  : ${textures.slice(0, 6).join(', ')}${textures.length > 6 ? ', …' : ''}`);
}
