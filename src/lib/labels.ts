/** Libellés partagés popup ↔ tooltip de l'overlay. */

import type { StructureType } from '../parser';
import type { StructureState } from '../structures';

export const TYPE_LABEL: Record<StructureType, [emoji: string, label: string]> = {
  nuclear_plant: ['☢️', 'Centrale nucléaire'],
  port: ['⚓', 'Port'],
  military_base: ['🪖', 'Base militaire'],
  airport: ['✈️', 'Aéroport'],
  dam: ['💧', 'Barrage'],
  factory: ['🏭', 'Usine'],
  hq: ['🏛️', 'Administration / QG'],
  infrastructure: ['⚡', 'Infrastructure'],
  research: ['🔬', 'Recherche'],
  hospital: ['🏥', 'Hôpital'],
  depot: ['📦', 'Entrepôt'],
  monument: ['🗿', 'Monument'],
  finance: ['💰', 'Institution financière'],
  policy: ['📄', 'Administratif / réforme'],
  unit: ['⚔️', 'Unité militaire'],
  generic: ['🏢', 'Bâtiment'],
};

export const STATE_LABEL: Record<StructureState, string> = {
  under_construction: 'En chantier',
  built: 'Construit',
  destroyed: 'Détruit',
};
