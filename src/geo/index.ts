/**
 * Géocodage — jointure nom ↔ mapFeatures du jeu.
 * Deux formes de localisation coexistent (vérifié en live) :
 *  - features du preset : location.{longitude, latitude}
 *  - features créées par l'IA : location.{oLng, oLat} (position résolue dans la
 *    région, oPlacement:"random") — il faut accepter les deux.
 */

export interface MapFeatureLocation {
  longitude?: number;
  latitude?: number;
  oLng?: number;
  oLat?: number;
  regionID?: string;
}

export interface MapFeature {
  name: string;
  location: MapFeatureLocation;
  type?: string;
  tags?: string[];
  displaySymbol?: string;
}

export function featureLngLat(f: MapFeature): { lng: number; lat: number } | null {
  const loc = f?.location;
  if (!loc) return null;
  const lng = typeof loc.longitude === 'number' ? loc.longitude : loc.oLng;
  const lat = typeof loc.latitude === 'number' ? loc.latitude : loc.oLat;
  return typeof lng === 'number' && typeof lat === 'number' ? { lng, lat } : null;
}

function normalize(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();
}

export function findFeatureByName(name: string, features: MapFeature[]): MapFeature | null {
  const wanted = normalize(name);
  if (!wanted) return null;

  let prefixMatch: MapFeature | null = null;
  for (const feature of features) {
    if (!featureLngLat(feature)) continue;
    const candidate = normalize(feature.name);
    if (candidate === wanted) return feature;
    if (!prefixMatch && (candidate.startsWith(wanted) || wanted.startsWith(candidate))) {
      prefixMatch = feature;
    }
  }
  return prefixMatch;
}

/** Résout les tags d'un événement vers des lieux connus, sans doublon. */
export function resolveTags(
  tagTexts: string[],
  features: MapFeature[],
): Array<{ tag: string; feature: MapFeature }> {
  const seen = new Set<string>();
  const resolved: Array<{ tag: string; feature: MapFeature }> = [];
  for (const tag of tagTexts) {
    const feature = findFeatureByName(tag, features);
    if (feature && !seen.has(feature.name)) {
      seen.add(feature.name);
      resolved.push({ tag, feature });
    }
  }
  return resolved;
}
