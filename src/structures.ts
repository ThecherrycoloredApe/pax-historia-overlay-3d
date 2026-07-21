/**
 * Cycle de vie des structures détectées (étapes 5-6).
 *
 * Naissance : détection par mots-clés dans le texte d'un événement (annonce de
 * chantier) → état « under_construction ». Le jeu n'affiche RIEN à ce moment
 * (mapChanges vide, vérifié) : c'est le créneau de l'overlay.
 *
 * Promotion vers « built », trois déclencheurs (du plus fiable au filet) :
 *  1. un mapChanges `createMapFeature` compatible (famille de tags + ≤200 km) —
 *     le signal d'achèvement du jeu, qui n'arrive que des mois/années in-game
 *     après l'annonce, et parfois jamais (incompréhensions IA) ;
 *  2. mots-clés d'achèvement dans un événement ultérieur au même endroit ;
 *  3. délai in-game écoulé depuis l'annonce (filet anti-oubli de l'IA).
 */

import {
  detectStructures,
  COMPLETION_PATTERN,
  DESTRUCTION_PATTERN,
  FEATURE_FAMILY,
  UNIT_PATTERN,
  featureTypeFromTags,
  type GameEvent,
  type StructureType,
} from './parser';
import { resolveTags, featureLngLat, type MapFeature } from './geo';
import { lngLatToMercator } from './lib/mercator';
import type { CollectedEvent, NewEventsContext } from './game-state';

export type StructureState = 'under_construction' | 'built' | 'destroyed';

/** Ordre de progression : un état ne peut que « avancer » lors des fusions. */
const STATE_RANK: Record<StructureState, number> = { under_construction: 0, built: 1, destroyed: 2 };

export interface PlacedStructure {
  id: string;
  type: StructureType;
  placeName: string;
  /** Position finale sur la carte (ancrage ville + décalage « posé au sol »). */
  lng: number;
  lat: number;
  /** Point d'ancrage d'origine (la ville/feature résolue). */
  anchorLng?: number;
  anchorLat?: number;
  state: StructureState;
  /** Date in-game (event.date) de l'annonce. */
  startDate: string;
  builtDate?: string;
  destroyedDate?: string;
  roundNo: string;
  /** Version du schéma de placement (2 = décalage géographique appliqué). */
  v?: number;
  /** Origine : détection texte (défaut) ou createMapFeature du jeu. */
  source?: 'text' | 'mapChange';
  /** Nom de la feature du jeu (clé de retrait sur removeMapFeature). */
  gameFeatureName?: string;
}

/** Délai in-game au bout duquel un chantier est considéré terminé sans signal. */
const AUTO_COMPLETE_MONTHS = 18;
/** Distance max (mètres mercator) entre un createMapFeature et un chantier pour matcher. */
const MAPCHANGE_MATCH_METERS = 200_000;
/**
 * Anti-doublon feature-du-jeu ↔ structure texte : seulement en co-localisation
 * réelle (⚠️ 200 km supprimait des bâtiments légitimes autour des capitales).
 */
const TWIN_SUPPRESS_METERS = 12_000;
/** Distance max pour qu'un événement d'achèvement textuel matche un chantier. */
const COMPLETION_MATCH_METERS = 80_000;
/**
 * Décalage « posé sur la carte » : la structure ne se superpose pas au
 * symbole/label de la ville mais s'installe à quelques km, à une position
 * géographique FIXE (déterministe par id, donc stable entre sessions).
 */
const OFFSET_MIN_METERS = 8_000;
const OFFSET_MAX_METERS = 18_000;
/** Espacement minimal entre deux structures (anti-chevauchement). */
const MIN_SPACING_METERS = 4_000;

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Décale un point de quelques km dans une direction dérivée de `seed` (en mètres géographiques réels). */
function offsetAround(lng: number, lat: number, seed: string): { lng: number; lat: number } {
  const h = hashString(seed);
  const angle = ((h % 3600) / 3600) * 2 * Math.PI;
  const dist = OFFSET_MIN_METERS + (((h >>> 12) % 1000) / 1000) * (OFFSET_MAX_METERS - OFFSET_MIN_METERS);
  const dLat = (dist * Math.sin(angle)) / 111_320;
  const dLng = (dist * Math.cos(angle)) / (111_320 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  return { lng: lng + dLng, lat: lat + dLat };
}

const FAR = 1_000_000;

function nearestOccurrenceDistance(text: string, needle: string, from: number): number {
  let idx = -1;
  let best = FAR;
  while ((idx = text.indexOf(needle, idx + 1)) >= 0) {
    best = Math.min(best, Math.abs(idx - from));
  }
  return best;
}

function metersBetween(aLng: number, aLat: number, bLng: number, bLat: number): number {
  const a = lngLatToMercator(aLng, aLat);
  const b = lngLatToMercator(bLng, bLat);
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function parseGameDate(date: unknown): number | null {
  if (typeof date !== 'string') return null;
  const t = Date.parse(date);
  return Number.isFinite(t) ? t : null;
}

export function structuresFromEvent(event: GameEvent, features: MapFeature[], roundNo: string): PlacedStructure[] {
  const detections = detectStructures(event);
  if (!detections.length) return [];

  const tagTexts = (event.tags ?? []).map((t) => t?.text).filter((t): t is string => !!t);
  const resolved = resolveTags(tagTexts, features);
  if (!resolved.length) return [];

  const text = `${event.title}\n${event.description}`;
  // Un événement peut annoncer un chantier déjà achevé (« has completed… »).
  const state: StructureState = COMPLETION_PATTERN.test(text) ? 'built' : 'under_construction';
  const out: PlacedStructure[] = [];

  for (const detection of detections) {
    const keywordIdx = Math.max(0, text.indexOf(detection.matchedText));
    let best = resolved[0]!;
    let bestDist = Infinity;
    for (const candidate of resolved) {
      const dist = nearestOccurrenceDistance(text, candidate.tag, keywordIdx);
      if (dist < bestDist) {
        bestDist = dist;
        best = candidate;
      }
    }
    const pos = featureLngLat(best.feature);
    if (!pos) continue;
    const id = `${detection.type}@${best.feature.name}`;
    const placedPos = offsetAround(pos.lng, pos.lat, id);
    out.push({
      id,
      type: detection.type,
      placeName: best.feature.name,
      lng: placedPos.lng,
      lat: placedPos.lat,
      anchorLng: pos.lng,
      anchorLat: pos.lat,
      state,
      startDate: event.date,
      builtDate: state === 'built' ? event.date : undefined,
      roundNo,
      v: 2,
      source: 'text',
    });
  }
  return out;
}

export interface TrackerChange {
  added: PlacedStructure[];
  promoted: PlacedStructure[];
  destroyed: PlacedStructure[];
  /** Unités/features dont la position a suivi un déplacement du jeu. */
  moved: number;
  /** createMapFeature ignorés avec la raison — diagnostic des trous de couverture. */
  skipped: Array<{ name: string; reason: 'position-introuvable' | 'doublon'; change: unknown }>;
}

export class StructureTracker {
  private byId = new Map<string, PlacedStructure>();
  private gameId: string | null = null;
  private latestDateMs: number | null = null;
  /** Ids supprimés manuellement (popup) : ne jamais les recréer. */
  private tombstones = new Set<string>();
  /** Noms de TOUTES les features actuellement sur la carte (dernier balayage). */
  private liveNameCache: Set<string> | null = null;

  getAll(): PlacedStructure[] {
    return [...this.byId.values()];
  }

  /** Une structure existe-t-elle pour cet id ? (couverture réelle d'une feature) */
  has(id: string): boolean {
    return this.byId.has(id);
  }

  serialize(): PlacedStructure[] {
    return this.getAll();
  }

  /** Fusionne des structures persistées (l'état le plus avancé gagne). */
  restore(gameId: string, saved: PlacedStructure[]): boolean {
    this.setGame(gameId);
    let changed = false;
    for (const s of saved) {
      if (!s || typeof s.id !== 'string' || typeof s.lng !== 'number') continue;
      // Migration v1 : la position était l'ancrage ville → applique le décalage.
      if (!s.v || s.v < 2) {
        s.anchorLng = s.lng;
        s.anchorLat = s.lat;
        const placed = offsetAround(s.lng, s.lat, s.id);
        s.lng = placed.lng;
        s.lat = placed.lat;
        s.v = 2;
      }
      if (this.tombstones.has(s.id)) continue;
      const existing = this.byId.get(s.id);
      if (!existing) {
        // Ruines mapChange périmées : la feature est vivante sur la carte
        // (ex. ville détruite à tort par une version précédente) → purge.
        if (
          s.state === 'destroyed' &&
          s.source === 'mapChange' &&
          this.liveNameCache?.has(s.gameFeatureName ?? s.placeName)
        ) {
          changed = true; // la prochaine sauvegarde nettoiera le storage
          continue;
        }
        // Entrée héritée indexée par NOM alors que la feature est déjà suivie
        // par id (migration) : ne pas réimporter le doublon.
        const featureName = s.gameFeatureName ?? s.placeName;
        if (
          s.source === 'mapChange' &&
          s.id === `mc:${featureName}` &&
          [...this.byId.values()].some(
            (o) => o.id !== s.id && o.source === 'mapChange' && o.gameFeatureName === featureName,
          )
        ) {
          changed = true; // la prochaine sauvegarde nettoiera le storage
          continue;
        }
        this.byId.set(s.id, this.withSpacing(s));
        changed = true;
      } else if (STATE_RANK[s.state] > STATE_RANK[existing.state]) {
        // L'état des structures issues de la carte se re-dérive du jeu à chaque
        // lecture : ne jamais réimporter une destruction sauvegardée périmée
        // par-dessus une feature actuellement vivante (détruite→recréée).
        if (s.state === 'destroyed' && (s.source ?? existing.source) === 'mapChange') continue;
        existing.state = s.state;
        existing.builtDate = s.builtDate ?? existing.builtDate;
        existing.destroyedDate = s.destroyedDate ?? existing.destroyedDate;
        changed = true;
      }
    }
    return changed;
  }

  /** Suppressions manuelles (popup) : retire et bloque toute re-détection. */
  applyTombstones(ids: string[]): boolean {
    let changed = false;
    for (const id of ids) {
      if (!this.tombstones.has(id)) {
        this.tombstones.add(id);
        changed = true;
      }
      if (this.byId.delete(id)) changed = true;
    }
    return changed;
  }

  /** Écarte la structure si une autre occupe déjà le même coin de carte. */
  private withSpacing(s: PlacedStructure): PlacedStructure {
    const anchorLng = s.anchorLng ?? s.lng;
    const anchorLat = s.anchorLat ?? s.lat;
    for (let attempt = 0; attempt < 8; attempt++) {
      const pos = attempt === 0 ? { lng: s.lng, lat: s.lat } : offsetAround(anchorLng, anchorLat, `${s.id}#${attempt}`);
      let free = true;
      for (const other of this.byId.values()) {
        if (other.id !== s.id && metersBetween(pos.lng, pos.lat, other.lng, other.lat) < MIN_SPACING_METERS) {
          free = false;
          break;
        }
      }
      if (free) return { ...s, lng: pos.lng, lat: pos.lat };
    }
    return s;
  }

  private latestIsoDate(): string | undefined {
    return this.latestDateMs !== null ? new Date(this.latestDateMs).toISOString().slice(0, 10) : undefined;
  }

  private setGame(gameId: string): void {
    if (this.gameId !== gameId) {
      this.gameId = gameId;
      this.byId.clear();
      this.tombstones.clear();
      this.liveNameCache = null;
      this.latestDateMs = null;
    }
  }

  processEvents(events: CollectedEvent[], context: NewEventsContext): TrackerChange {
    this.setGame(context.gameId);
    const added: PlacedStructure[] = [];
    const promoted: PlacedStructure[] = [];
    const destroyed: PlacedStructure[] = [];
    const skipped: TrackerChange['skipped'] = [];
    let moved = 0;

    for (const { event, roundNo } of events) {
      const t = parseGameDate(event.date);
      if (t !== null && (this.latestDateMs === null || t > this.latestDateMs)) this.latestDateMs = t;

      // 1. nouvelles détections textuelles
      for (const s of structuresFromEvent(event, context.mapFeatures, roundNo)) {
        if (this.tombstones.has(s.id)) continue;
        const existing = this.byId.get(s.id);
        if (!existing) {
          const placed = this.withSpacing(s);
          this.byId.set(placed.id, placed);
          added.push(placed);
        } else if (existing.state === 'under_construction' && s.state === 'built') {
          existing.state = 'built';
          existing.builtDate = s.builtDate;
          promoted.push(existing);
        }
      }

      // 2a. mapChanges : promotion de chantiers, bâtiments génériques, retraits
      for (const change of event.mapChanges ?? []) {
        if (change?.type === 'removeMapFeature') {
          const name = (change as any).removedFeature?.name;
          if (typeof name === 'string') {
            // Le jeu retire par NOM ; nos structures sont indexées par id de
            // feature → retirer toutes celles qui portent ce nom.
            for (const s of [...this.byId.values()]) {
              if (s.source !== 'mapChange' || s.state === 'destroyed') continue;
              if (s.gameFeatureName !== name && s.id !== `mc:${name}`) continue;
              if (s.type === 'unit') {
                // Unité mobile retirée : elle quitte la carte, pas de ruines.
                this.byId.delete(s.id);
                moved++;
              } else {
                s.state = 'destroyed';
                s.destroyedDate = event.date;
                destroyed.push(s);
              }
            }
          }
          continue;
        }
        if (change?.type !== 'createMapFeature') continue;
        const feature = (change as any).feature as MapFeature | undefined;
        if (!feature || typeof feature.name !== 'string') continue;
        const tagBlob = `${(feature.tags ?? []).join(' ')} ${feature.name}`;
        const isUnit = UNIT_PATTERN.test(tagBlob);
        // Une feature issue d'un createMapFeature est créée par l'IA : elle est
        // toujours couvrable, même taguée city (l'IA tague `city` ses hubs —
        // seules les villes du PRESET gardent leur rendu du jeu).
        // Position : d'abord la feature stockée (nom), sinon le centroïde de sa
        // région — indispensable pour les features sans tags/nom retrouvable.
        const stored = context.mapFeatures.find((f) => f.name === feature.name);
        const directPos = stored ? featureLngLat(stored) : null;
        const centroid =
          directPos ?? (feature.location?.regionID ? context.regionCentroid(feature.location.regionID) : null);
        // Centroïde = repli grossier : décalage déterministe de quelques km pour
        // que les features d'une même région ne s'empilent pas au même point.
        const pos =
          directPos ?? (centroid ? offsetAround(centroid.lng, centroid.lat, `mc:${feature.name}`) : null);

        // Les unités mobiles ne terminent pas un chantier.
        let promotedByThisChange = false;
        if (!isUnit) {
          for (const s of this.byId.values()) {
            if (s.state !== 'under_construction') continue;
            if (!FEATURE_FAMILY[s.type].test(tagBlob)) continue;
            if (pos && metersBetween(pos.lng, pos.lat, s.lng, s.lat) > MAPCHANGE_MATCH_METERS) continue;
            s.state = 'built';
            s.builtDate = event.date;
            promoted.push(s);
            promotedByThisChange = true;
          }
        }

        // Structure (⚔️ campement pour les unités, bâtiment sinon) à sa position.
        if (promotedByThisChange) continue;
        if (!pos) {
          skipped.push({ name: feature.name, reason: 'position-introuvable', change });
          continue;
        }
        const featureType = featureTypeFromTags(feature.tags ?? [], feature.name);
        const id = `mc:${feature.name}`;
        if (this.tombstones.has(id)) continue;
        // Feature recréée après destruction (même nom) : ressusciter au lieu de
        // rester en ruines. Recherche aussi par nom de feature : le balayage
        // ré-indexe les structures vivantes par id de feature du jeu.
        const already =
          this.byId.get(id) ??
          [...this.byId.values()].find((s) => s.source === 'mapChange' && s.gameFeatureName === feature.name);
        if (already) {
          if (already.state === 'destroyed') {
            already.state = 'built';
            already.builtDate = event.date;
            already.destroyedDate = undefined;
            already.lng = pos.lng;
            already.lat = pos.lat;
            already.anchorLng = pos.lng;
            already.anchorLat = pos.lat;
            promoted.push(already);
          }
          continue;
        }
        // Évite le doublon avec une structure texte déjà construite au même endroit.
        const twin = [...this.byId.values()].some(
          (s) =>
            s.source !== 'mapChange' &&
            s.type === featureType &&
            metersBetween(pos.lng, pos.lat, s.lng, s.lat) <= TWIN_SUPPRESS_METERS,
        );
        if (twin) {
          skipped.push({ name: feature.name, reason: 'doublon', change });
          continue;
        }
        const structure: PlacedStructure = {
          id,
          type: featureType,
          placeName: feature.name,
          lng: pos.lng,
          lat: pos.lat,
          anchorLng: pos.lng,
          anchorLat: pos.lat,
          state: 'built',
          startDate: event.date,
          builtDate: event.date,
          roundNo,
          v: 2,
          source: 'mapChange',
          gameFeatureName: feature.name,
        };
        this.byId.set(id, structure);
        added.push(structure);
      }

      // 2b. promotion par mots-clés d'achèvement au même endroit
      const text = `${event.title}\n${event.description}`;
      const tagTexts = (event.tags ?? []).map((t) => t?.text).filter((x): x is string => !!x);
      const mentionsStructurePlace = (s: PlacedStructure, maxMeters: number): boolean => {
        if (text.toLowerCase().includes(s.placeName.toLowerCase())) return true;
        return resolveTags(tagTexts, context.mapFeatures).some((r) => {
          const pos = featureLngLat(r.feature);
          return pos !== null && metersBetween(pos.lng, pos.lat, s.lng, s.lat) <= maxMeters;
        });
      };
      if (COMPLETION_PATTERN.test(text)) {
        for (const s of this.byId.values()) {
          if (s.state !== 'under_construction') continue;
          if (!FEATURE_FAMILY[s.type].test(text)) continue;
          if (!mentionsStructurePlace(s, COMPLETION_MATCH_METERS)) continue;
          s.state = 'built';
          s.builtDate = event.date;
          promoted.push(s);
        }
      }

      // 2c. destruction par mots-clés au même endroit (chantier ou bâtiment)
      if (DESTRUCTION_PATTERN.test(text)) {
        for (const s of this.byId.values()) {
          if (s.state === 'destroyed') continue;
          if (!FEATURE_FAMILY[s.type].test(text)) continue;
          if (!mentionsStructurePlace(s, COMPLETION_MATCH_METERS)) continue;
          s.state = 'destroyed';
          s.destroyedDate = event.date;
          destroyed.push(s);
        }
      }
    }

    // 3. filet de couverture : TOUTE feature IA présente sur la carte reçoit un
    // bâtiment, même si son événement créateur a été consolidé ou perdu
    // (parties longues, multijoueur). Source de vérité : round.mapFeatures.
    // ⚠️ La liste de vie inclut TOUTES les features de la carte (villes/arcologies
    // comprises) : les exclusions de couverture ne sont pas des disparitions.
    const liveNames = new Set<string>(context.mapFeatures.map((f) => f.name));
    this.liveNameCache = liveNames;
    for (const { id: featureId, feature } of context.aiFeatures) {
      liveNames.add(feature.name);
      // Indexation par ID de feature du jeu : plusieurs features peuvent porter
      // le même nom (« Border Defenses » ×15) — chacune a SA structure.
      const sid = `mc:${featureId}`;
      if (this.tombstones.has(sid) || this.tombstones.has(`mc:${feature.name}`)) continue;
      const direct = featureLngLat(feature);
      const centroid =
        direct ?? (feature.location?.regionID ? context.regionCentroid(feature.location.regionID) : null);
      // Centroïde = repli grossier : décalage déterministe par id pour que les
      // features d'une même région ne s'empilent pas au même point.
      const pos = direct ?? (centroid ? offsetAround(centroid.lng, centroid.lat, sid) : null);
      if (!pos) {
        skipped.push({ name: feature.name, reason: 'position-introuvable', change: feature });
        continue;
      }
      // Migration : les sauvegardes précédentes étaient indexées par nom.
      const legacy = this.byId.get(`mc:${feature.name}`);
      if (legacy) {
        if (!this.byId.has(sid)) {
          this.byId.delete(legacy.id);
          legacy.id = sid;
          this.byId.set(sid, legacy);
        } else {
          // Doublon hérité (entrée par nom restaurée alors que l'entrée par id
          // existe déjà) : fusion — l'entrée par id fait foi.
          this.byId.delete(legacy.id);
        }
      }
      // Déjà suivie : round.mapFeatures est la source de vérité de l'existence.
      // Une feature présente ne peut pas être en ruines (ressuscite si besoin).
      const existing = this.byId.get(sid);
      if (existing) {
        existing.gameFeatureName = feature.name;
        if (existing.state === 'destroyed') {
          existing.state = 'built';
          existing.destroyedDate = undefined;
          promoted.push(existing);
        }
        if (direct) {
          // Position directe : on suit les déplacements du jeu (unités…).
          if (metersBetween(direct.lng, direct.lat, existing.lng, existing.lat) > 1_500) {
            existing.lng = direct.lng;
            existing.lat = direct.lat;
            existing.anchorLng = direct.lng;
            existing.anchorLat = direct.lat;
            moved++;
          }
        } else if (centroid && metersBetween(centroid.lng, centroid.lat, existing.lng, existing.lat) < 500) {
          // Sauvegarde posée PILE sur le centroïde (empilement d'une version
          // précédente) : on l'étale une fois vers sa position décalée.
          existing.lng = pos.lng;
          existing.lat = pos.lat;
          existing.anchorLng = centroid.lng;
          existing.anchorLat = centroid.lat;
          moved++;
        }
        continue;
      }
      const featureType = featureTypeFromTags(feature.tags ?? [], feature.name);
      const twin = [...this.byId.values()].some(
        (s) =>
          s.source !== 'mapChange' &&
          s.type === featureType &&
          metersBetween(pos.lng, pos.lat, s.lng, s.lat) <= TWIN_SUPPRESS_METERS,
      );
      if (twin) {
        skipped.push({ name: feature.name, reason: 'doublon', change: feature });
        continue;
      }
      const structure: PlacedStructure = {
        id: sid,
        type: featureType,
        placeName: feature.name,
        lng: pos.lng,
        lat: pos.lat,
        anchorLng: centroid?.lng ?? pos.lng,
        anchorLat: centroid?.lat ?? pos.lat,
        state: 'built',
        startDate: this.latestIsoDate() ?? '',
        builtDate: this.latestIsoDate(),
        roundNo: '',
        v: 2,
        source: 'mapChange',
        gameFeatureName: feature.name,
      };
      this.byId.set(sid, structure);
      added.push(structure);
    }
    // Une feature du jeu disparue de la carte = détruite (ruines) ; une unité
    // disparue est simplement retirée (dissoute/redéployée, pas un champ de ruines).
    if (context.aiFeatures.length) {
      for (const s of [...this.byId.values()]) {
        if (
          s.source === 'mapChange' &&
          s.gameFeatureName &&
          !liveNames.has(s.gameFeatureName) &&
          s.state !== 'destroyed'
        ) {
          if (s.type === 'unit') {
            this.byId.delete(s.id);
            moved++;
            continue;
          }
          s.state = 'destroyed';
          s.destroyedDate = this.latestIsoDate();
          destroyed.push(s);
        }
      }
    }

    // 4. promotion par délai in-game écoulé
    if (this.latestDateMs !== null) {
      const cutoff = AUTO_COMPLETE_MONTHS * 30 * 24 * 3600 * 1000;
      for (const s of this.byId.values()) {
        if (s.state !== 'under_construction') continue;
        const start = parseGameDate(s.startDate);
        if (start !== null && this.latestDateMs - start >= cutoff) {
          s.state = 'built';
          promoted.push(s);
        }
      }
    }

    return { added, promoted, destroyed, moved, skipped };
  }
}
