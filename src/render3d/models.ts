/**
 * Modèles low-poly procéduraux (géométries three.js, aucun asset externe).
 * Convention : Y vers le haut, sol à y=0, encombrement ≈ 1 unité — l'overlay
 * scale à l'emprise au sol voulue. Chaque appel construit ses propres
 * géométries/matériaux ; disposeModel() libère tout.
 */

import * as THREE from 'three';
import type { StructureType } from '../parser';
import type { StructureState } from '../structures';
import { assetModelFor } from './asset-models';

function mat(color: number, opts: Partial<THREE.MeshStandardMaterialParameters> = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.05, flatShading: true, ...opts });
}

function box(w: number, h: number, d: number, color: number, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color));
  m.position.set(x, y, z);
  return m;
}

function cyl(rTop: number, rBot: number, h: number, color: number, x = 0, y = 0, z = 0, seg = 14): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, h, seg), mat(color));
  m.position.set(x, y, z);
  return m;
}

export const TYPE_COLORS: Record<StructureType, number> = {
  nuclear_plant: 0x34c759,
  port: 0x007aff,
  military_base: 0x5b6b4a,
  airport: 0xff9500,
  dam: 0x5ac8fa,
  factory: 0xaf52de,
  hq: 0x5856d6,
  infrastructure: 0xffcc00,
  research: 0x64d2ff,
  hospital: 0xff3b30,
  depot: 0xa2845e,
  monument: 0xffd60a,
  finance: 0xf7b500,
  policy: 0x7d8a99,
  unit: 0x8b1e1e,
  generic: 0x8e8e93,
};

/** Chantier : grue + noyau échafaudé + bétonnière. Fanion coloré = type futur. */
function constructionSite(type: StructureType): THREE.Group {
  const g = new THREE.Group();
  g.add(box(1.0, 0.04, 1.0, 0xc4b393, 0, 0.02, 0)); // terre battue
  g.add(box(0.9, 0.005, 0.16, 0x9c8c6e, 0, 0.045, 0.36)); // piste de circulation

  // noyau de bâtiment + échafaudage
  g.add(box(0.34, 0.24, 0.34, 0xdde1e6, 0.24, 0.14, 0.05));
  g.add(box(0.34, 0.1, 0.34, 0xc3c9cf, 0.24, 0.31, 0.05));
  const pole = 0x8e959c;
  for (const [px, pz] of [[0.05, -0.14], [0.43, -0.14], [0.05, 0.24], [0.43, 0.24]] as const) {
    g.add(box(0.022, 0.46, 0.022, pole, px, 0.25, pz));
  }
  g.add(box(0.42, 0.022, 0.022, pole, 0.24, 0.47, -0.14));
  g.add(box(0.42, 0.022, 0.022, pole, 0.24, 0.47, 0.24));
  g.add(box(0.022, 0.022, 0.4, pole, 0.05, 0.47, 0.05));
  g.add(box(0.022, 0.022, 0.4, pole, 0.43, 0.47, 0.05));

  // grue à tour
  const crane = 0xf6a821;
  g.add(box(0.12, 0.03, 0.12, 0x6b7280, -0.25, 0.055, -0.05)); // socle
  g.add(box(0.06, 0.85, 0.06, crane, -0.25, 0.48, -0.05)); // mât
  g.add(box(0.08, 0.08, 0.08, 0xd9dde2, -0.25, 0.86, -0.05)); // cabine
  g.add(box(0.72, 0.045, 0.045, crane, 0.06, 0.93, -0.05)); // flèche
  g.add(box(0.2, 0.07, 0.07, 0x596066, -0.42, 0.9, -0.05)); // contrepoids
  g.add(box(0.012, 0.34, 0.012, 0x3c4046, 0.32, 0.74, -0.05)); // câble
  g.add(box(0.07, 0.05, 0.07, 0x9aa2ab, 0.32, 0.55, -0.05)); // charge
  g.add(box(0.09, 0.05, 0.012, TYPE_COLORS[type], -0.2, 0.99, -0.05)); // fanion type

  // bétonnière : tambour incliné sur châssis
  const mixer = cyl(0.05, 0.075, 0.14, 0xd97706, -0.32, 0.12, 0.32, 10);
  mixer.rotation.z = 0.8;
  g.add(mixer);
  g.add(box(0.14, 0.035, 0.09, 0x596066, -0.32, 0.055, 0.32));
  return g;
}

function nuclearPlant(): THREE.Group {
  const g = new THREE.Group();
  g.add(box(1.0, 0.04, 0.85, 0x9dbb8b, 0, 0.02, 0)); // pelouse
  g.add(box(0.94, 0.005, 0.12, 0xb0b6bc, 0, 0.045, 0.34)); // voie d'accès

  // tours de refroidissement : profil hyperbolique (3 tronçons) + col sombre
  for (const [tx, tz, s] of [[-0.3, -0.14, 1], [-0.05, 0.16, 0.85]] as const) {
    g.add(cyl(0.115 * s, 0.17 * s, 0.34 * s, 0xe9edef, tx, 0.17 * s + 0.04, tz));
    g.add(cyl(0.1 * s, 0.115 * s, 0.1 * s, 0xe9edef, tx, 0.39 * s + 0.04, tz));
    g.add(cyl(0.115 * s, 0.1 * s, 0.1 * s, 0xdfe4e7, tx, 0.49 * s + 0.04, tz));
    g.add(cyl(0.117 * s, 0.117 * s, 0.02 * s, 0xaeb6bc, tx, 0.545 * s + 0.04, tz)); // couronne
    g.add(cyl(0.07 * s, 0.05 * s, 0.05 * s, 0xffffff, tx, 0.58 * s + 0.04, tz, 8)); // vapeur
  }

  // îlot réacteur : dôme sur tambour + porte
  g.add(cyl(0.15, 0.15, 0.17, 0xf3f4f6, 0.3, 0.125, -0.08));
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.15, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), mat(0xe8ebee));
  dome.position.set(0.3, 0.21, -0.08);
  g.add(dome);
  g.add(box(0.06, 0.09, 0.02, 0x5a6068, 0.3, 0.085, 0.075)); // porte

  // salle des turbines : hall à toit voûté + bandeau de fenêtres
  g.add(box(0.36, 0.11, 0.2, 0xcfd8dc, 0.26, 0.095, 0.26));
  const vault = cyl(0.1, 0.1, 0.36, 0xb8c2c8, 0.26, 0.15, 0.26, 10);
  vault.rotation.z = Math.PI / 2;
  vault.scale.set(1, 1, 0.55);
  g.add(vault);
  g.add(box(0.3, 0.03, 0.005, 0x50606e, 0.26, 0.1, 0.365)); // fenêtres
  return g;
}

function port(): THREE.Group {
  const g = new THREE.Group();
  g.add(box(1.0, 0.02, 0.5, 0x2f6ec4, 0, 0.01, 0.25)); // eau
  g.add(box(1.0, 0.06, 0.5, 0x9aa5b1, 0, 0.03, -0.25)); // terre-plein
  g.add(box(1.0, 0.07, 0.07, 0xb7c0ca, 0, 0.035, -0.02)); // front de quai

  // portiques porte-conteneurs
  const crane = 0x2464c8;
  for (const cx of [-0.28, 0.14] as const) {
    for (const lz of [-0.12, 0.02] as const) {
      g.add(box(0.045, 0.36, 0.045, crane, cx - 0.1, 0.24, lz));
      g.add(box(0.045, 0.36, 0.045, crane, cx + 0.1, 0.24, lz));
    }
    g.add(box(0.26, 0.05, 0.2, crane, cx, 0.44, -0.05)); // portique
    const boom = box(0.05, 0.04, 0.34, crane, cx, 0.47, 0.16); // flèche sur l'eau
    boom.rotation.x = 0.18;
    g.add(boom);
    g.add(box(0.07, 0.06, 0.07, 0xd9dde2, cx, 0.4, 0.0)); // cabine
  }

  // piles de conteneurs
  const containers: Array<[number, number, number, number]> = [
    [0.42, 0.075, -0.32, 0xe74c3c], [0.42, 0.135, -0.32, 0x27ae60], [0.42, 0.195, -0.32, 0xf1c40f],
    [-0.44, 0.075, -0.34, 0x8e44ad], [-0.44, 0.135, -0.34, 0xe67e22],
    [-0.02, 0.075, -0.36, 0x16a085],
  ];
  for (const [cx, cy, cz, cc] of containers) g.add(box(0.15, 0.055, 0.09, cc, cx, cy, cz));

  // cargo à quai : coque + château + conteneurs pontés
  g.add(box(0.5, 0.07, 0.16, 0xb03a2e, 0.1, 0.05, 0.3)); // coque
  g.add(box(0.5, 0.02, 0.14, 0x7b241c, 0.1, 0.095, 0.3)); // pavois
  g.add(box(0.09, 0.11, 0.12, 0xecf0f1, -0.11, 0.16, 0.3)); // château arrière
  g.add(box(0.14, 0.05, 0.1, 0x2980b9, 0.14, 0.13, 0.3));
  g.add(box(0.14, 0.05, 0.1, 0xc0392b, 0.3, 0.13, 0.3));
  return g;
}

function militaryBase(): THREE.Group {
  const g = new THREE.Group();
  g.add(box(1.0, 0.04, 0.8, 0x9a9478, 0, 0.02, 0)); // terrain sable
  const wall = 0x6e7566;
  g.add(box(0.94, 0.09, 0.045, wall, 0, 0.085, -0.36));
  g.add(box(0.94, 0.09, 0.045, wall, 0, 0.085, 0.36));
  g.add(box(0.045, 0.09, 0.76, wall, -0.47, 0.085, 0));
  g.add(box(0.045, 0.09, 0.76, wall, 0.47, 0.085, 0));

  // casernes en quinconce, toits sombres débordants
  for (const [bx, bz] of [[-0.2, -0.16], [-0.2, 0.12], [0.12, 0.16]] as const) {
    g.add(box(0.3, 0.1, 0.16, 0xb4bd9c, bx, 0.09, bz));
    g.add(box(0.33, 0.028, 0.19, 0x474c41, bx, 0.155, bz));
  }

  // mirador + antenne radar
  g.add(box(0.045, 0.28, 0.045, 0x4a4f45, 0.34, 0.18, -0.22));
  g.add(box(0.15, 0.09, 0.15, 0x8a8f7a, 0.34, 0.36, -0.22));
  g.add(box(0.17, 0.02, 0.17, 0x3d423a, 0.34, 0.42, -0.22));
  g.add(cyl(0.012, 0.012, 0.2, 0xd0d4d8, 0.15, 0.52, -0.22, 6)); // mât
  const dish = cyl(0.07, 0.07, 0.02, 0xd0d4d8, 0.15, 0.6, -0.22, 10);
  dish.rotation.x = 1.1;
  g.add(dish);
  g.add(cyl(0.012, 0.012, 0.42, 0x9aa2ab, 0.15, 0.31, -0.22, 6)); // pied du radar
  return g;
}

function airport(): THREE.Group {
  const g = new THREE.Group();
  g.add(box(1.05, 0.03, 0.62, 0x7f8b7a, 0, 0.015, 0.02)); // plateforme herbeuse
  g.add(box(1.0, 0.035, 0.2, 0x50555b, 0, 0.02, 0.2)); // piste
  for (let i = 0; i < 7; i++) g.add(box(0.07, 0.038, 0.016, 0xe8e8e8, -0.42 + i * 0.14, 0.021, 0.2)); // axe pointillé
  g.add(box(0.5, 0.034, 0.08, 0x60666d, -0.1, 0.019, 0.0)); // taxiway

  // terminal vitré + tour de contrôle
  g.add(box(0.42, 0.1, 0.14, 0xd4d8dd, -0.12, 0.07, -0.2));
  g.add(box(0.42, 0.035, 0.005, 0x67b0d8, -0.12, 0.075, -0.128)); // vitrage
  g.add(box(0.46, 0.02, 0.17, 0x9aa2ab, -0.12, 0.13, -0.2)); // toiture
  g.add(cyl(0.035, 0.05, 0.3, 0xd0d4d8, 0.28, 0.17, -0.22, 8));
  g.add(cyl(0.085, 0.06, 0.06, 0x67b0d8, 0.28, 0.35, -0.22, 8)); // vigie
  g.add(cyl(0.09, 0.09, 0.015, 0x596066, 0.28, 0.39, -0.22, 8));

  // petit avion au parking
  const fuselage = cyl(0.035, 0.035, 0.26, 0xf4f6f8, 0.28, 0.055, 0.02, 8);
  fuselage.rotation.x = Math.PI / 2;
  g.add(fuselage);
  g.add(box(0.3, 0.012, 0.06, 0xf4f6f8, 0.28, 0.05, 0.02)); // ailes
  g.add(box(0.1, 0.05, 0.014, 0xe74c3c, 0.28, 0.075, -0.1)); // dérive
  return g;
}

function dam(): THREE.Group {
  const g = new THREE.Group();
  // gorge : deux berges rocheuses
  g.add(box(0.26, 0.24, 0.55, 0x8a8274, -0.37, 0.12, 0));
  g.add(box(0.26, 0.24, 0.55, 0x8a8274, 0.37, 0.12, 0));
  g.add(box(0.2, 0.28, 0.4, 0x7c7568, -0.4, 0.14, -0.05)); // relief
  g.add(box(0.2, 0.28, 0.4, 0x7c7568, 0.4, 0.14, -0.05));

  // mur du barrage : parement incliné + crête + piliers déversoirs
  const face = box(0.5, 0.24, 0.09, 0xc7ced5, 0, 0.12, 0.02);
  face.rotation.x = -0.18;
  g.add(face);
  g.add(box(0.52, 0.045, 0.14, 0xa8b0b8, 0, 0.25, -0.02)); // crête
  for (const px of [-0.15, 0, 0.15] as const) g.add(box(0.035, 0.1, 0.1, 0x99a1a9, px, 0.19, 0.05));

  // retenue amont (haute) et rivière aval (basse) + écume au pied
  g.add(box(0.48, 0.02, 0.3, 0x2f6ec4, 0, 0.21, -0.19));
  g.add(box(0.48, 0.02, 0.24, 0x74a8e8, 0, 0.015, 0.26));
  g.add(box(0.44, 0.025, 0.05, 0xdcebf7, 0, 0.02, 0.13));

  // usine hydroélectrique au pied
  g.add(box(0.2, 0.08, 0.1, 0xb9c1c9, 0.12, 0.055, 0.15));
  g.add(box(0.22, 0.02, 0.12, 0x596066, 0.12, 0.1, 0.15));
  return g;
}

function factory(): THREE.Group {
  const g = new THREE.Group();
  g.add(box(1.0, 0.03, 0.7, 0xaeb2b8, 0, 0.015, 0)); // dalle

  // halle principale + sheds (dents de scie) orientés
  g.add(box(0.56, 0.18, 0.4, 0xc26436, -0.12, 0.12, 0));
  for (const rx of [-0.32, -0.13, 0.06] as const) {
    const shed = box(0.18, 0.1, 0.4, 0x9e4e28, rx, 0.245, 0);
    shed.rotation.z = 0.55;
    g.add(shed);
    g.add(box(0.02, 0.1, 0.36, 0x86c5e8, rx + 0.075, 0.24, 0)); // verrière
  }
  g.add(box(0.5, 0.03, 0.005, 0x54402f, -0.12, 0.1, 0.203)); // bandeau fenêtres

  // annexe + cheminées cerclées
  g.add(box(0.24, 0.1, 0.2, 0xd4d8dd, 0.32, 0.08, 0.14));
  g.add(cyl(0.045, 0.055, 0.42, 0x9aa2ab, 0.3, 0.24, -0.16, 10));
  g.add(cyl(0.05, 0.05, 0.035, 0xc0392b, 0.3, 0.44, -0.16, 10));
  g.add(cyl(0.035, 0.045, 0.3, 0x9aa2ab, 0.42, 0.18, -0.06, 10));
  g.add(cyl(0.04, 0.04, 0.03, 0xc0392b, 0.42, 0.32, -0.06, 10));
  return g;
}

/** QG / administratif : perron, façade à colonnes, fronton, drapeau. */
function hq(): THREE.Group {
  const g = new THREE.Group();
  g.add(box(0.8, 0.03, 0.6, 0xb9bec5, 0, 0.015, 0)); // parvis
  g.add(box(0.56, 0.035, 0.4, 0xcfd4da, 0, 0.045, -0.04)); // perron
  g.add(box(0.5, 0.18, 0.3, 0xdcd6c8, 0, 0.15, -0.08)); // corps
  for (const cx of [-0.18, -0.06, 0.06, 0.18] as const) {
    g.add(cyl(0.02, 0.02, 0.16, 0xece7db, cx, 0.14, 0.085, 8)); // colonnes
  }
  g.add(box(0.54, 0.04, 0.34, 0xc8c2b4, 0, 0.26, -0.08)); // entablement
  const pediment = box(0.34, 0.1, 0.1, 0xd5cfc1, 0, 0.31, 0.05);
  pediment.rotation.z = Math.PI / 4;
  pediment.scale.y = 0.5;
  g.add(pediment);
  g.add(cyl(0.008, 0.008, 0.3, 0x9aa2ab, 0.32, 0.2, 0.18, 6)); // mât
  g.add(box(0.08, 0.05, 0.008, 0x2f6fd0, 0.36, 0.32, 0.18)); // drapeau
  return g;
}

/** Infrastructure/énergie : poste électrique clôturé + pylônes reliés. */
function infrastructure(): THREE.Group {
  const g = new THREE.Group();
  g.add(box(0.9, 0.03, 0.6, 0xa8a29a, 0, 0.015, 0)); // plateforme gravier
  // transformateurs
  g.add(box(0.16, 0.12, 0.12, 0x7a8188, -0.24, 0.09, 0.1));
  g.add(box(0.16, 0.12, 0.12, 0x7a8188, -0.02, 0.09, 0.1));
  g.add(cyl(0.03, 0.03, 0.08, 0xd0d4d8, -0.24, 0.19, 0.1, 8));
  g.add(cyl(0.03, 0.03, 0.08, 0xd0d4d8, -0.02, 0.19, 0.1, 8));
  // deux pylônes + câble
  for (const px of [-0.32, 0.3] as const) {
    g.add(box(0.035, 0.34, 0.035, 0x8e959c, px, 0.2, -0.16));
    g.add(box(0.2, 0.025, 0.025, 0x8e959c, px, 0.33, -0.16)); // traverse
  }
  g.add(box(0.62, 0.012, 0.012, 0x5a6068, -0.01, 0.31, -0.16)); // câble
  g.add(box(0.14, 0.09, 0.1, 0xd4d8dd, 0.3, 0.075, 0.14)); // local technique
  return g;
}

/** Recherche/université : bloc moderne, bandeau vitré, parabole. */
function research(): THREE.Group {
  const g = new THREE.Group();
  g.add(box(0.8, 0.03, 0.6, 0x9dbb8b, 0, 0.015, 0)); // campus
  g.add(box(0.44, 0.2, 0.26, 0xe8eaee, -0.1, 0.13, 0)); // bâtiment principal
  g.add(box(0.45, 0.05, 0.27, 0x67b0d8, -0.1, 0.15, 0)); // bandeau vitré
  g.add(box(0.2, 0.12, 0.2, 0xd4d8dd, 0.26, 0.09, -0.1)); // annexe
  g.add(cyl(0.012, 0.012, 0.14, 0x9aa2ab, 0.26, 0.22, -0.1, 6));
  const dish = cyl(0.09, 0.09, 0.025, 0xf0f2f4, 0.26, 0.31, -0.1, 12);
  dish.rotation.x = 0.9;
  g.add(dish);
  return g;
}

/** Hôpital : bloc blanc en L, croix rouge en toiture, auvent d'urgences. */
function hospital(): THREE.Group {
  const g = new THREE.Group();
  g.add(box(0.8, 0.03, 0.6, 0xb9bec5, 0, 0.015, 0)); // parking
  g.add(box(0.44, 0.2, 0.24, 0xf4f6f8, -0.08, 0.13, -0.06));
  g.add(box(0.2, 0.14, 0.34, 0xe9edef, 0.2, 0.1, 0.06)); // aile
  // croix rouge posée sur le toit
  g.add(box(0.16, 0.015, 0.05, 0xd93636, -0.08, 0.238, -0.06));
  g.add(box(0.05, 0.015, 0.16, 0xd93636, -0.08, 0.238, -0.06));
  g.add(box(0.16, 0.05, 0.1, 0xd93636, 0.2, 0.19, 0.06)); // enseigne sur l'aile
  g.add(box(0.18, 0.02, 0.12, 0xc7ccd2, -0.08, 0.045, 0.13)); // auvent
  return g;
}

/** Entrepôt/logistique : halle à toit cintré, caisses, aire de chargement. */
function depot(): THREE.Group {
  const g = new THREE.Group();
  g.add(box(0.95, 0.03, 0.6, 0xa8a29a, 0, 0.015, 0)); // dalle
  g.add(box(0.6, 0.14, 0.32, 0xc9a227, -0.1, 0.1, -0.06)); // halle
  const roof = cyl(0.16, 0.16, 0.6, 0xb08a1e, -0.1, 0.17, -0.06, 12);
  roof.rotation.z = Math.PI / 2;
  roof.scale.set(1, 1, 0.45);
  g.add(roof);
  for (const [dx, dz] of [[-0.3, 0.12], [-0.18, 0.12], [-0.06, 0.12]] as const) {
    g.add(box(0.09, 0.06, 0.004, 0x5a6068, dx, 0.06, dz + 0.045)); // portes de quai
  }
  // caisses/palettes
  g.add(box(0.1, 0.07, 0.08, 0x8f6b3f, 0.32, 0.065, 0.14));
  g.add(box(0.1, 0.07, 0.08, 0x8f6b3f, 0.32, 0.135, 0.14));
  g.add(box(0.1, 0.07, 0.08, 0xa2845e, 0.42, 0.065, 0.02));
  return g;
}

/** Monument : degrés, obélisque, deux arbres. */
function monument(): THREE.Group {
  const g = new THREE.Group();
  g.add(box(0.7, 0.03, 0.55, 0x9dbb8b, 0, 0.015, 0)); // esplanade verte
  g.add(box(0.3, 0.04, 0.3, 0xcfd4da, 0, 0.05, 0));
  g.add(box(0.22, 0.04, 0.22, 0xdde1e6, 0, 0.09, 0));
  g.add(cyl(0.028, 0.05, 0.42, 0xe8e4da, 0, 0.32, 0, 4)); // obélisque
  g.add(cyl(0.001, 0.03, 0.06, 0xe8e4da, 0, 0.56, 0, 4)); // pointe
  for (const [tx, tz] of [[-0.26, 0.16], [0.26, -0.14]] as const) {
    g.add(cyl(0.015, 0.02, 0.08, 0x6b4f35, tx, 0.06, tz, 6)); // tronc
    g.add(cyl(0.001, 0.07, 0.16, 0x4f7a3d, tx, 0.18, tz, 8)); // feuillage
  }
  return g;
}

/** Unité militaire : campement — tentes, mât et fanion. */
function unitCamp(): THREE.Group {
  const g = new THREE.Group();
  g.add(box(0.65, 0.03, 0.5, 0x6f6b52, 0, 0.015, 0)); // terrain
  for (const [tx, tz, s] of [[-0.16, -0.08, 1], [0.1, 0.12, 0.85], [0.16, -0.14, 0.7]] as const) {
    g.add(cyl(0.004, 0.11 * s, 0.14 * s, 0xd8d2c2, tx, 0.07 * s + 0.03, tz, 6)); // tente
  }
  g.add(box(0.16, 0.02, 0.1, 0x4a4636, -0.2, 0.04, 0.16)); // caisses
  g.add(box(0.08, 0.06, 0.06, 0x5c5744, -0.18, 0.08, 0.16));
  g.add(cyl(0.007, 0.007, 0.34, 0x8e959c, 0.24, 0.2, 0.05, 6)); // mât
  g.add(box(0.09, 0.05, 0.008, 0x8b1e1e, 0.285, 0.32, 0.05)); // fanion
  return g;
}

/** Bâtiment générique : petit complexe neutre (repli pour tags inconnus). */
function generic(): THREE.Group {
  const g = new THREE.Group();
  g.add(box(0.7, 0.03, 0.55, 0xb0b5bb, 0, 0.015, 0)); // parcelle
  g.add(box(0.3, 0.2, 0.22, 0x9fa8b5, -0.12, 0.13, -0.06)); // tour principale
  g.add(box(0.31, 0.02, 0.23, 0x717a86, -0.12, 0.24, -0.06)); // toit
  g.add(box(0.26, 0.1, 0.18, 0xb9c1cc, 0.16, 0.08, 0.1)); // annexe
  g.add(box(0.27, 0.015, 0.19, 0x828b97, 0.16, 0.14, 0.1));
  g.add(box(0.26, 0.025, 0.005, 0x5b87a8, -0.12, 0.16, 0.052)); // bandeau vitré
  g.add(box(0.26, 0.025, 0.005, 0x5b87a8, -0.12, 0.1, 0.052));
  g.add(box(0.1, 0.05, 0.08, 0xd4d8dd, 0.02, 0.045, 0.2)); // entrée
  return g;
}

const BUILDERS: Record<StructureType, () => THREE.Group> = {
  nuclear_plant: nuclearPlant,
  port,
  military_base: militaryBase,
  airport,
  dam,
  factory,
  hq,
  infrastructure,
  research,
  hospital,
  depot,
  monument,
  finance: generic,
  policy: generic,
  unit: unitCamp,
  generic,
};

/** Ruines : sol calciné, pans de murs brisés, décombres, fumée. */
function ruins(): THREE.Group {
  const g = new THREE.Group();
  g.add(box(0.75, 0.025, 0.6, 0x57534d, 0, 0.012, 0)); // sol calciné
  // pans de murs
  g.add(box(0.32, 0.15, 0.03, 0x8f887e, -0.14, 0.1, -0.14));
  g.add(box(0.03, 0.11, 0.26, 0x8f887e, -0.29, 0.08, -0.02));
  const brokenWall = box(0.2, 0.09, 0.03, 0x837c72, 0.14, 0.06, 0.12);
  brokenWall.rotation.z = 0.25;
  g.add(brokenWall);
  // décombres
  const rubbleColors = [0x6f6a63, 0x7c766e, 0x655f58];
  const rubble: Array<[number, number, number, number]> = [
    [0.06, 0.05, -0.02, 0], [0.2, 0.04, -0.08, 0.5], [-0.04, 0.045, 0.14, 0.9],
    [0.3, 0.035, 0.04, 0.3], [-0.16, 0.04, 0.06, 0.7],
  ];
  rubble.forEach(([rx, rh, rz, rot], i) => {
    const chunk = box(0.1, rh * 2, 0.08, rubbleColors[i % 3]!, rx, rh, rz);
    chunk.rotation.y = rot;
    g.add(chunk);
  });
  // fumée stylisée
  for (const [sy, sr] of [[0.22, 0.05], [0.32, 0.07], [0.43, 0.09]] as const) {
    const puff = new THREE.Mesh(
      new THREE.SphereGeometry(sr, 8, 6),
      mat(0x4a4642, { transparent: true, opacity: 0.55, flatShading: false }),
    );
    puff.position.set(-0.05 + sy * 0.15, sy, -0.1);
    g.add(puff);
  }
  return g;
}

export function makeModel(type: StructureType, state: StructureState, seed = ''): THREE.Group {
  if (state === 'under_construction') return constructionSite(type);
  if (state === 'destroyed') return ruins();
  return assetModelFor(type, seed) ?? BUILDERS[type]();
}

export function disposeModel(group: THREE.Object3D): void {
  group.traverse((child) => {
    // Les clones d'assets partagent géométries/matériaux : ne pas les détruire.
    if (child.userData['paxSharedAsset']) return;
    const mesh = child as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(material)) material.forEach((m) => m.dispose());
    else if (material) material.dispose();
  });
}
