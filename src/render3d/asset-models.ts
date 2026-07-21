/**
 * Modèles 3D CC0 embarqués dans le bundle, deux origines complémentaires :
 *
 * - **Quaternius** (quaternius.com) — Ultimate Buildings Pack : tous les
 *   bâtiments URBAINS (génériques, QG, recherche, finance, administratif).
 *   Convertis depuis l'OBJ « with Materials » (couleurs portées par les
 *   matériaux, donc AUCUNE texture externe) via tools/obj-to-glb.mjs.
 * - **Kenney** (kenney.nl) — tout ce qui est INDUSTRIEL, PORTUAIRE ou
 *   COMMÉMORATIF : usines à cheminées, cuves, hangars, tours de
 *   refroidissement, porte-conteneurs, obélisque. Ces kits partagent une
 *   texture `colormap` par kit, servie en URL blob grâce au URLModifier du
 *   LoadingManager — d'où UN loader par kit.
 *
 * Le pack Farm de Quaternius a été essayé pour les usines (halle + silos) et
 * ABANDONNÉ : à l'écran ça donnait une ferme, pas une usine. Les silhouettes
 * industrielles de Kenney (cheminées, cuves) sont beaucoup plus lisibles.
 *
 * Plusieurs types ont des VARIANTES (voir VARIANTS), réparties par hash du
 * seed pour éviter que toutes les structures d'un même type soient identiques.
 *
 * Chaque template est normalisé (emprise ≈ 1, base au sol, centré) puis CLONÉ
 * par structure : géométries et matériaux restent partagés entre clones (flag
 * paxSharedAsset — ne pas les disposer).
 *
 * ⚠️ Les composites (port, monument, centrale) et les choix de modèles se
 * vérifient À L'ŒIL via tools/preview-server.mjs AVANT livraison.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { StructureType } from '../parser';
import { log, warn } from '../lib/log';

// Kenney — City Industrial : usines, cuves, hangars, centrale.
import factoryAGlb from './assets/kenney-factory-a.glb';
import factoryBGlb from './assets/kenney-factory-b.glb';
import factoryCGlb from './assets/kenney-factory-c.glb';
import infraAGlb from './assets/kenney-infra-a.glb';
import infraBGlb from './assets/kenney-infra-b.glb';
import depotAGlb from './assets/kenney-depot-a.glb';
import depotBGlb from './assets/kenney-depot-b.glb';
import complexGlb from './assets/kenney-complex.glb';
import coolingGlb from './assets/kenney-cooling.glb';
// Kenney — Watercraft : port.
import shipCargoGlb from './assets/kenney-ship-cargo.glb';
import containerAGlb from './assets/kenney-container-a.glb';
import containerBGlb from './assets/kenney-container-b.glb';
import containerCGlb from './assets/kenney-container-c.glb';
// Kenney — Graveyard : monument.
import obeliskGlb from './assets/kenney-obelisk.glb';
import columnGlb from './assets/kenney-column.glb';
import pineGlb from './assets/kenney-pine.glb';
// Kenney — City Kit (Suburban) : l'enceinte de la base militaire. `fence-3x3`
// est un périmètre carré complet en UN seul modèle (35 Ko) — c'est le mur qui
// rend une base identifiable au premier coup d'œil, comme l'a montré l'essai
// du modèle Sketchfab (abandonné, 1 Mo pour le même effet).
import fenceCompoundGlb from './assets/kenney-fence-compound.glb';
import colormapIndustrial from './assets/colormap-industrial.png';
import colormapWatercraft from './assets/colormap-watercraft.png';
import colormapGraveyard from './assets/colormap-graveyard.png';
import colormapSuburban from './assets/colormap-suburban.png';

// Quaternius — Ultimate Buildings Pack : bâtiments urbains.
import bld1Glb from './assets/quaternius-bld-1story.glb';
import bld2RoundGlb from './assets/quaternius-bld-2story-round.glb';
import bld2BalconyGlb from './assets/quaternius-bld-2story-balcony.glb';
import bld2SlimGlb from './assets/quaternius-bld-2story-slim.glb';
import bld3Glb from './assets/quaternius-bld-3story.glb';
import bld4Glb from './assets/quaternius-bld-4story.glb';
import bld6Glb from './assets/quaternius-bld-6story.glb';
import bldCenterGlb from './assets/quaternius-bld-center.glb';
import bld3BalconyGlb from './assets/quaternius-bld-3story-balcony.glb';
import bldColumnsGlb from './assets/quaternius-bld-columns.glb';
import bld2CenterGlb from './assets/quaternius-bld-2story-center.glb';
import bld2DoubleGlb from './assets/quaternius-bld-2story-double.glb';
import bld2WideGlb from './assets/quaternius-bld-2story-wide.glb';

type Kit = 'industrial' | 'watercraft' | 'graveyard' | 'suburban' | 'quaternius';

/**
 * Nombre de variantes par type, réparties par hash du seed. Un type absent
 * (ou à 1) n'a qu'un seul modèle. Les clés attendues dans `templates` sont
 * alors `type-0` … `type-{n-1}`.
 */
const VARIANTS: Partial<Record<StructureType, number>> = {
  generic: 6,
  factory: 3,
  research: 2,
  infrastructure: 2,
  depot: 2,
  hq: 2,
  finance: 2,
  policy: 2,
};

/**
 * Palette Kenney — blanc cassé, gris clair, gris moyen, anthracite, plus une
 * touche de jaune orangé. Les bâtiments Quaternius sortent tous du même
 * vert-gris, qui jurait avec les modèles Kenney (usines, hangars, port) : on
 * les y ramène pour que la carte forme un ensemble cohérent.
 */
const KENNEY_WHITE = 0xeae8e3;
const KENNEY_LIGHT = 0xc4c8cc;
const KENNEY_MID = 0x8f959d;
const KENNEY_DARK = 0x5d646e;
/** Le jaune Kenney, à doser : accent sur UN matériau, jamais dominant. */
const KENNEY_SAND = 0xe0b063;
/** Vert-de-gris militaire — sert à l'enceinte de la base. */
const OLIVE = 0x5e6552;

/**
 * Rampes du plus SOMBRE au plus CLAIR. Chaque bâtiment porte plusieurs
 * matériaux (murs, toit, encadrements, portes) : on les classe par luminosité
 * d'origine et on les redistribue le long de la rampe. Le modèle garde donc sa
 * structure — un toit resté plus sombre que ses murs — mais dans la palette
 * Kenney. Un aplat uni par bâtiment donnerait un rendu plat et mort.
 */
const RAMP_FULL = [KENNEY_DARK, KENNEY_MID, KENNEY_LIGHT, KENNEY_WHITE];
const RAMP_LIGHT = [KENNEY_MID, KENNEY_LIGHT, KENNEY_WHITE, KENNEY_WHITE];
const RAMP_DARK = [KENNEY_DARK, KENNEY_DARK, KENNEY_MID, KENNEY_LIGHT];

type Paint = { ramp: number[]; accent: boolean };

/**
 * Habillage par type : la rampe donne la dominante (clair/contrasté/sombre),
 * ce qui garde un minimum de lisibilité entre types sans casser l'harmonie.
 * Les modèles Kenney ne sont pas repeints — ils sont déjà à la bonne palette.
 */
const TYPE_PAINT: Partial<Record<StructureType, Paint>> = {
  hq: { ramp: RAMP_DARK, accent: false }, // anthracite, imposant
  research: { ramp: RAMP_LIGHT, accent: false }, // blanc, laboratoire
  finance: { ramp: RAMP_FULL, accent: true }, // contrasté + touche de jaune
  policy: { ramp: RAMP_FULL, accent: false }, // gris administratif
};

/** Les génériques n'ont pas d'identité à porter : les rampes alternent. */
const GENERIC_PAINT: Paint[] = [
  { ramp: RAMP_LIGHT, accent: false },
  { ramp: RAMP_FULL, accent: true },
  { ramp: RAMP_FULL, accent: false },
  { ramp: RAMP_DARK, accent: false },
  { ramp: RAMP_LIGHT, accent: true },
  { ramp: RAMP_FULL, accent: false },
];

/**
 * Force du mélange (0 = modèle d'origine, 1 = couleur pure). Élevé à dessein :
 * en dessous de ~0.75 le vert-gris d'origine transparaît et casse l'accord
 * avec les modèles Kenney.
 */
const TINT_MIX = 0.85;

/** Types couverts par un asset (les autres restent procéduraux). */
const ASSET_TYPES = new Set<StructureType>([
  'factory',
  'depot',
  'infrastructure',
  'hq',
  'research',
  'nuclear_plant',
  'finance',
  'policy',
  'port',
  'monument',
  'generic',
  'military_base',
]);

const templates = new Map<string, THREE.Group>();
let loaded = false;
let loading: Promise<void> | null = null;

function loaderFor(colormap: Uint8Array): GLTFLoader {
  const blobUrl = URL.createObjectURL(new Blob([colormap as BlobPart], { type: 'image/png' }));
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => (url.includes('colormap') ? blobUrl : url));
  return new GLTFLoader(manager);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function parseGlb(loader: GLTFLoader, bytes: Uint8Array): Promise<THREE.Group> {
  return new Promise((resolve, reject) => {
    loader.parse(toArrayBuffer(bytes), '', (gltf) => resolve(gltf.scene), reject);
  });
}

/** Emprise ≈ 1 unité, centré en x/z, base à y=0, meshes marqués « partagés ». */
function normalize(group: THREE.Group): THREE.Group {
  const box = new THREE.Box3().setFromObject(group);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  const footprint = Math.max(size.x, size.z) || 1;
  let scale = 1 / footprint;
  // Les tours (gratte-ciel…) ne doivent pas dominer la carte : hauteur plafonnée.
  const MAX_HEIGHT = 1.25;
  if (size.y * scale > MAX_HEIGHT) scale = MAX_HEIGHT / size.y;
  const wrapper = new THREE.Group();
  group.position.set(-center.x, -box.min.y, -center.z);
  wrapper.add(group);
  wrapper.scale.setScalar(scale);
  // aplatit la hiérarchie de transformation dans un groupe stable
  const root = new THREE.Group();
  root.add(wrapper);
  root.traverse((child) => {
    child.userData['paxSharedAsset'] = true;
  });
  return root;
}

/** Clones d'assets : géométries/matériaux partagés, jamais disposés. */
function markShared(group: THREE.Object3D): void {
  group.traverse((child) => {
    child.userData['paxSharedAsset'] = true;
  });
}

const materialsOf = (mesh: THREE.Mesh): THREE.Material[] =>
  Array.isArray(mesh.material) ? mesh.material : [mesh.material];

/** Luminance perçue de la couleur d'un matériau (0 = noir, 1 = blanc). */
function luminance(m: THREE.Material): number {
  const c = (m as THREE.MeshStandardMaterial).color;
  return c ? c.r * 0.299 + c.g * 0.587 + c.b * 0.114 : 0.5;
}

/** Saturation de la couleur d'un matériau — sert à repérer les détails colorés. */
function saturation(m: THREE.Material): number {
  const c = (m as THREE.MeshStandardMaterial).color;
  if (!c) return 0;
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  return hsl.s;
}

/** Couleur à la position `t` (0 = extrémité sombre, 1 = extrémité claire). */
function sampleRamp(ramp: number[], t: number): THREE.Color {
  const x = Math.max(0, Math.min(1, t)) * (ramp.length - 1);
  const i = Math.min(Math.floor(x), ramp.length - 2);
  return new THREE.Color(ramp[i]!).lerp(new THREE.Color(ramp[i + 1]!), x - i);
}

/**
 * Copie repeinte d'un template. `clone(true)` partage géométries ET matériaux
 * avec la source : on ne duplique donc QUE les matériaux, ce qui rend la
 * variante quasi gratuite en mémoire.
 *
 * Les matériaux sont classés par luminosité d'origine puis étalés le long de
 * la rampe : le bâtiment garde ainsi ses contrastes internes (toit sombre,
 * murs clairs) au lieu de devenir un aplat uni. Si `accent`, le matériau le
 * plus saturé du modèle — typiquement une porte ou un encadrement, donc une
 * petite surface — passe au jaune Kenney.
 */
function repaint(src: THREE.Group, paint: Paint, mix: number): THREE.Group {
  const copy = src.clone(true) as THREE.Group;

  const mats: THREE.Material[] = [];
  copy.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    for (const m of materialsOf(mesh)) if (!mats.includes(m)) mats.push(m);
  });
  if (!mats.length) return copy;

  const accent = paint.accent
    ? mats.reduce((best, m) => (saturation(m) > saturation(best) ? m : best), mats[0]!)
    : null;

  const ranked = [...mats].sort((a, b) => luminance(a) - luminance(b));
  const replacement = new Map<THREE.Material, THREE.Material>();
  ranked.forEach((m, rank) => {
    const t = ranked.length > 1 ? rank / (ranked.length - 1) : 1;
    const target = m === accent ? new THREE.Color(KENNEY_SAND) : sampleRamp(paint.ramp, t);
    const clone = m.clone();
    const std = clone as THREE.MeshStandardMaterial;
    if (std.color) std.color.lerp(target, mix);
    replacement.set(m, clone);
  });

  copy.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    const swapped = materialsOf(mesh).map((m) => replacement.get(m) ?? m);
    mesh.material = Array.isArray(mesh.material) ? swapped : swapped[0]!;
  });

  markShared(copy);
  return copy;
}

/**
 * Copie d'un template repeinte en APLAT : texture retirée, couleur imposée.
 *
 * Nécessaire quand un modèle vient d'un kit dont la palette jure. Teinter par
 * multiplication (`repaint`) ne suffit pas dans ce cas : la couleur du matériau
 * MULTIPLIE la texture, donc une palissade orange vire au brun foncé et jamais
 * au vert-de-gris. Retirer la map donne un aplat propre — acceptable sur une
 * géométrie simple, à éviter sur un bâtiment dont la texture porte le détail.
 */
function solidColor(src: THREE.Group, color: number): THREE.Group {
  const copy = src.clone(true) as THREE.Group;
  const cache = new Map<THREE.Material, THREE.Material>();
  const flatten = (m: THREE.Material): THREE.Material => {
    const hit = cache.get(m);
    if (hit) return hit;
    const c = m.clone() as THREE.MeshStandardMaterial;
    c.map = null;
    if (c.color) c.color.set(color);
    c.needsUpdate = true; // sans ça le shader garde la texture
    cache.set(m, c);
    return c;
  };
  copy.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    const swapped = materialsOf(mesh).map(flatten);
    mesh.material = Array.isArray(mesh.material) ? swapped : swapped[0]!;
  });
  markShared(copy);
  return copy;
}

type Part = { key: string; scale: number; at: readonly [number, number, number] };

/**
 * Assemble plusieurs templates en un seul. Si une pièce manque (modèle
 * illisible), le composite n'est PAS créé : le type retombe alors sur son
 * modèle procédural plutôt que d'afficher un assemblage tronqué.
 */
function compose(key: string, parts: readonly Part[]): void {
  const group = new THREE.Group();
  for (const p of parts) {
    const tpl = templates.get(p.key);
    if (!tpl) return;
    const clone = tpl.clone(true);
    clone.scale.multiplyScalar(p.scale);
    clone.position.set(...p.at);
    group.add(clone);
  }
  markShared(group);
  templates.set(key, group);
}

async function buildTemplates(): Promise<void> {
  // Un loader par kit Kenney : chaque kit a SA colormap, servie via URL blob.
  // Quaternius : couleurs dans les matériaux, aucune texture à router.
  const loaders: Record<Kit, GLTFLoader> = {
    industrial: loaderFor(colormapIndustrial),
    watercraft: loaderFor(colormapWatercraft),
    graveyard: loaderFor(colormapGraveyard),
    suburban: loaderFor(colormapSuburban),
    quaternius: new GLTFLoader(),
  };
  const load = async (key: string, kit: Kit, bytes: Uint8Array) => {
    const scene = await parseGlb(loaders[kit], bytes);
    templates.set(key, normalize(scene));
  };

  // allSettled et non all : un modèle illisible ne doit pas faire tomber TOUS
  // les types sur le procédural — seul le sien retombe (assetModelFor renvoie
  // null quand la clé est absente).
  const results = await Promise.allSettled([
    // Bâtiments urbains (Quaternius)
    load('generic-0', 'quaternius', bld1Glb),
    load('generic-1', 'quaternius', bld2RoundGlb),
    load('generic-2', 'quaternius', bld2BalconyGlb),
    load('generic-3', 'quaternius', bld2SlimGlb),
    load('generic-4', 'quaternius', bld3Glb),
    load('generic-5', 'quaternius', bld4Glb),
    load('hq-0', 'quaternius', bld6Glb),
    load('hq-1', 'quaternius', bldCenterGlb),
    // research et finance partagent la forme 2Story_Center : la teinte de type
    // (turquoise / doré) suffit à les distinguer, pour 111 Ko au lieu de 222.
    load('research-0', 'quaternius', bld3BalconyGlb),
    load('research-1', 'quaternius', bld2CenterGlb),
    load('finance-0', 'quaternius', bldColumnsGlb),
    load('finance-1', 'quaternius', bld2CenterGlb),
    load('policy-0', 'quaternius', bld2DoubleGlb),
    load('policy-1', 'quaternius', bld2WideGlb),
    // Industriel (Kenney) — cheminées et cuves : lisibles au premier coup d'œil
    load('factory-0', 'industrial', factoryAGlb),
    load('factory-1', 'industrial', factoryBGlb),
    load('factory-2', 'industrial', factoryCGlb),
    load('infrastructure-0', 'industrial', infraAGlb),
    load('infrastructure-1', 'industrial', infraBGlb),
    load('depot-0', 'industrial', depotAGlb),
    load('depot-1', 'industrial', depotBGlb),
    // Pièces de composites
    load('complex', 'industrial', complexGlb),
    load('cooling', 'industrial', coolingGlb),
    load('ship-cargo', 'watercraft', shipCargoGlb),
    load('container-a', 'watercraft', containerAGlb),
    load('container-b', 'watercraft', containerBGlb),
    load('container-c', 'watercraft', containerCGlb),
    load('obelisk', 'graveyard', obeliskGlb),
    load('column', 'graveyard', columnGlb),
    load('pine', 'graveyard', pineGlb),
    load('fence-compound', 'suburban', fenceCompoundGlb),
  ]);

  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length) {
    warn(`${failed.length} modèle(s) 3D illisibles, repli procédural pour ces types`, failed[0]);
  }

  // Mise en peinture — AVANT les composites (aucun composite n'utilise de
  // pièce Quaternius, mais l'ordre reste le bon si ça change un jour).
  for (const [type, paint] of Object.entries(TYPE_PAINT) as [StructureType, Paint][]) {
    for (let v = 0; v < (VARIANTS[type] ?? 1); v++) {
      const key = `${type}-${v}`;
      const tpl = templates.get(key);
      if (tpl) templates.set(key, repaint(tpl, paint, TINT_MIX));
    }
  }
  GENERIC_PAINT.forEach((paint, v) => {
    const tpl = templates.get(`generic-${v}`);
    if (tpl) templates.set(`generic-${v}`, repaint(tpl, paint, TINT_MIX));
  });

  // L'enceinte sort du kit PAVILLONNAIRE : c'est une palissade en bois orange,
  // qui faisait jardin de banlieue au milieu d'une carte grise. Teinte uniforme
  // vers le vert-de-gris (rampe d'une seule couleur) pour qu'elle lise
  // « militaire » et s'accorde au reste.
  const fence = templates.get('fence-compound');
  if (fence) templates.set('fence-compound', solidColor(fence, OLIVE));

  // Base militaire : enceinte + deux hangars. C'est le PÉRIMÈTRE qui fait
  // lire « base » — sans lui on ne voit que des entrepôts. Les hangars sont
  // les templates de `depot`, réutilisés tels quels : rien à embarquer en plus.
  compose('military_base', [
    { key: 'fence-compound', scale: 1, at: [0, 0, 0] },
    { key: 'depot-0', scale: 0.44, at: [-0.14, 0, 0.08] },
    { key: 'depot-1', scale: 0.34, at: [0.22, 0, -0.18] },
  ]);

  // Centrale nucléaire : complexe industriel + deux tours de refroidissement.
  compose('nuclear_plant', [
    { key: 'complex', scale: 0.78, at: [0.12, 0, 0.08] },
    { key: 'cooling', scale: 0.42, at: [-0.32, 0, -0.12] },
    { key: 'cooling', scale: 0.34, at: [-0.1, 0, -0.28] },
  ]);

  // Port : porte-conteneurs à quai + conteneurs empilés sur le terre-plein.
  compose('port', [
    { key: 'ship-cargo', scale: 0.72, at: [0, 0, 0.24] },
    { key: 'container-a', scale: 0.3, at: [-0.26, 0, -0.26] },
    { key: 'container-b', scale: 0.3, at: [-0.26, 0.115, -0.26] },
    { key: 'container-c', scale: 0.3, at: [0.18, 0, -0.3] },
  ]);

  // Monument : obélisque encadré de colonnes commémoratives + sapins.
  compose('monument', [
    { key: 'obelisk', scale: 0.62, at: [0, 0, -0.05] },
    { key: 'column', scale: 0.26, at: [-0.28, 0, -0.05] },
    { key: 'column', scale: 0.26, at: [0.28, 0, -0.05] },
    { key: 'pine', scale: 0.28, at: [-0.3, 0, 0.3] },
    { key: 'pine', scale: 0.24, at: [0.3, 0, 0.3] },
  ]);
}

export function loadAssetTemplates(): Promise<void> {
  if (!loading) {
    loading = buildTemplates()
      .then(() => {
        loaded = templates.size > 0;
        log(`🏙️ ${templates.size} modèles 3D chargés (CC0 — Quaternius + Kenney)`);
      })
      .catch((e) => {
        warn('assets 3D indisponibles, modèles procéduraux conservés', e);
      });
  }
  return loading;
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Clé de template pour un type donné (variante choisie par hash du seed). */
function templateKey(type: StructureType, seed: string): string | null {
  if (!ASSET_TYPES.has(type)) return null; // types couverts par les procéduraux
  const n = VARIANTS[type] ?? 1;
  return n > 1 ? `${type}-${hashString(seed) % n}` : type;
}

/** Clone du modèle 3D pour ce type, ou null (→ procédural). */
export function assetModelFor(type: StructureType, seed: string): THREE.Group | null {
  if (!loaded) return null;
  const key = templateKey(type, seed);
  if (!key) return null;
  const template = templates.get(key);
  return template ? (template.clone(true) as THREE.Group) : null;
}
