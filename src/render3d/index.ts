/**
 * Rendu 3D — étape 3.
 * Prévu : canvas WebGL transparent (position:absolute, pointer-events:none)
 * au-dessus du canvas du jeu, positions via engine.mercatorToScreen, re-render
 * uniquement sur view:change ou changement de structures (rendu on-demand,
 * comme le moteur du jeu). three.js sera embarqué en local (CSP MV3).
 */

import type { StructureType } from '../parser';

export interface PlacedStructure {
  id: string;
  type: StructureType;
  placeName: string;
  longitude: number;
  latitude: number;
  /** Date in-game de l'événement d'origine (diagnostic + futur retrait). */
  eventDate: string;
}
