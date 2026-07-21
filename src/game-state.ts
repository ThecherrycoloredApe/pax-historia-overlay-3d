/**
 * Lecture de l'état de partie (étape 4).
 *
 * L'état ne transite ni par fetch JSON ni par Firestore : il vit dans le
 * cache React Query du jeu, clé `simpleGames/{gameId}` (voir Phase 0 §3).
 * Source primaire : le QueryClient, trouvé une fois via le fiber React,
 * puis ABONNEMENT à son cache → détection des nouveaux événements sans
 * polling. Fallback : walk périodique du fiber à la recherche de l'objet
 * game (signature {rounds, playerCountry, presetUID}).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { adapters } from './config/adapters';
import type { GameEvent } from './parser';
import type { MapFeature } from './geo';
import { mercatorToLngLat } from './lib/mercator';
import { log } from './lib/log';

export interface GameRound {
  completed?: boolean;
  startDate?: string;
  [key: string]: unknown;
}

export interface GameState {
  rounds?: Record<string, GameRound>;
  playerCountry?: string;
  presetUID?: string;
  title?: string;
  [key: string]: unknown;
}

export interface CollectedEvent {
  event: GameEvent;
  roundNo: string;
}

export interface NewEventsContext {
  gameId: string;
  game: GameState;
  mapFeatures: MapFeature[];
  /**
   * Features créées par l'IA (clé de round.mapFeatures + donnée) — reconnues
   * à leur forme de localisation `oLng/oLat` (les features du preset ont
   * `longitude/latitude`). Source de vérité pour la couverture en bâtiments
   * et le masquage des symboles/labels du jeu.
   */
  aiFeatures: Array<{ id: string; feature: MapFeature }>;
  /**
   * Centroïde d'une région (depuis la géométrie de carte en cache) — fallback
   * de position quand une feature créée n'est pas retrouvée par son nom.
   */
  regionCentroid: (regionID: string) => { lng: number; lat: number } | null;
  /** true pour la première lecture (événements historiques de la partie). */
  initial: boolean;
}

export interface GameStateCallbacks {
  onNewEvents(events: CollectedEvent[], context: NewEventsContext): void;
}

interface CachedQuery {
  queryKey?: unknown[];
  state?: { data?: unknown };
}

interface QueryClientLike {
  getQueryData(key: unknown[]): unknown;
  getQueryCache(): {
    subscribe(listener: (event: { type?: string; query?: CachedQuery }) => void): () => void;
    getAll?(): CachedQuery[];
  };
  setQueryData(key: unknown[], data: unknown): unknown;
}

function looksLikeQueryClient(o: any): o is QueryClientLike {
  return (
    !!o &&
    typeof o === 'object' &&
    typeof o.getQueryData === 'function' &&
    typeof o.getQueryCache === 'function' &&
    typeof o.setQueryData === 'function'
  );
}

function looksLikeGame(o: any): o is GameState {
  return !!o && typeof o === 'object' && adapters.state.gameSignatureKeys.every((k) => k in o);
}

function fiberOf(el: Element): any {
  const key = Object.keys(el).find((k) => k.startsWith(adapters.engine.fiberKeyPrefix));
  return key ? (el as any)[key] : null;
}

/** Racines React distinctes atteignables depuis quelques éléments ancres. */
function findReactRoots(): any[] {
  const anchors: Array<Element | null> = [
    document.querySelector('header'),
    document.querySelector('canvas')?.parentElement ?? null,
    ...Array.from(document.body?.children ?? []),
  ];
  const roots = new Set<any>();
  for (const el of anchors) {
    if (!el) continue;
    let fiber = fiberOf(el);
    while (fiber && fiber.return) fiber = fiber.return;
    if (fiber) roots.add(fiber);
  }
  return [...roots];
}

const MAX_FIBERS = 30_000;

function traverseFibers(visit: (fiber: any) => boolean): void {
  for (const root of findReactRoots()) {
    const stack = [root];
    let count = 0;
    while (stack.length && count < MAX_FIBERS) {
      const fiber = stack.pop();
      if (!fiber) continue;
      count++;
      if (visit(fiber)) return;
      if (fiber.child) stack.push(fiber.child);
      if (fiber.sibling) stack.push(fiber.sibling);
    }
  }
}

export function findQueryClient(): QueryClientLike | null {
  let found: QueryClientLike | null = null;
  traverseFibers((fiber) => {
    const client = fiber.memoizedProps?.client ?? fiber.pendingProps?.client;
    if (looksLikeQueryClient(client)) {
      found = client;
      return true;
    }
    return false;
  });
  return found;
}

/** Fallback sans QueryClient : cherche l'objet game dans les props/hooks. */
export function findGameViaFiber(): GameState | null {
  let found: GameState | null = null;
  traverseFibers((fiber) => {
    const props = fiber.memoizedProps;
    if (props && typeof props === 'object') {
      for (const value of Object.values(props)) {
        if (looksLikeGame(value)) {
          found = value;
          return true;
        }
      }
    }
    let state = fiber.memoizedState;
    for (let i = 0; state && i < 40; i++, state = state.next) {
      const v = state.memoizedState;
      if (looksLikeGame(v)) {
        found = v;
        return true;
      }
    }
    return false;
  });
  return found;
}

export function currentGameId(): string | null {
  const m = location.pathname.match(adapters.gameUrl);
  return m ? (m[1] ?? null) : null;
}

/**
 * Pages /live/ : les événements ne sont pas (toujours) dans le cache React
 * Query — on cherche directement dans le fiber des tableaux d'événements
 * (title+description) et un conteneur mapFeatures, où qu'ils soient.
 */
function scanFibersForLiveData(): { events: GameEvent[]; mapFeatures: Record<string, unknown> | null } {
  const events: GameEvent[] = [];
  const seenKeys = new Set<string>();
  let mapFeatures: Record<string, unknown> | null = null;

  const looksLikeFeature = (f: any) =>
    !!f && typeof f === 'object' && typeof f.name === 'string' && !!f.location && typeof f.location === 'object';

  const consider = (v: any) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      const first = v[0];
      if (
        first &&
        typeof first.title === 'string' &&
        (typeof first.description === 'string' || typeof first.date === 'string' || Array.isArray(first.mapChanges))
      ) {
        for (const e of v) {
          if (!e || typeof e.title !== 'string') continue;
          const k = `${e.date ?? ''}|${e.title}`;
          if (!seenKeys.has(k)) {
            seenKeys.add(k);
            events.push(e);
          }
        }
      } else if (!mapFeatures && v.length >= 10 && looksLikeFeature(first)) {
        // Tableau de features (mode live) → objet indexé par id.
        const out: Record<string, unknown> = {};
        for (let i = 0; i < v.length; i++) {
          const f: any = v[i];
          if (looksLikeFeature(f)) out[typeof f.id === 'string' && f.id ? f.id : String(i)] = f;
        }
        if (Object.keys(out).length >= 10) mapFeatures = out;
      }
      return;
    }
    const mf = v.mapFeatures;
    if (!mapFeatures && mf && typeof mf === 'object' && !Array.isArray(mf)) {
      const sample: any = Object.values(mf)[0];
      if (looksLikeFeature(sample)) mapFeatures = mf;
    }
    if (!mapFeatures) {
      // Objet directement indexé par id dont les valeurs sont des features.
      const vals = Object.values(v);
      if (vals.length >= 10 && looksLikeFeature(vals[0]) && looksLikeFeature(vals[Math.min(5, vals.length - 1)])) {
        mapFeatures = v as Record<string, unknown>;
      }
    }
  };

  traverseFibers((fiber) => {
    const props = fiber.memoizedProps;
    if (props && typeof props === 'object') {
      consider(props);
      for (const value of Object.values(props)) consider(value);
    }
    let state = fiber.memoizedState;
    for (let i = 0; state && i < 40; i++, state = state.next) consider(state.memoizedState);
    return false;
  });

  return { events, mapFeatures };
}

export function collectEvents(game: GameState): CollectedEvent[] {
  const out: CollectedEvent[] = [];
  const rounds = game?.rounds;
  if (!rounds || typeof rounds !== 'object') return out;
  for (const [roundNo, round] of Object.entries(rounds)) {
    const events = (round as any)?.[adapters.state.roundEventsKey];
    if (!Array.isArray(events)) continue;
    for (const event of events) {
      if (event && typeof event.title === 'string') out.push({ event, roundNo });
    }
  }
  return out;
}

/**
 * mapFeatures du round le plus récent qui en possède.
 * ⚠️ round.mapFeatures est un OBJET indexé par id de feature (ex "4kpe55ze"),
 * pas un array (vérifié en live le 2026-07-15).
 */
export function latestMapFeatures(game: GameState): MapFeature[] {
  const raw = latestMapFeaturesRaw(game);
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : Object.values(raw);
  return list.filter(
    (f: any): f is MapFeature =>
      !!f &&
      typeof f.name === 'string' &&
      !!f.location &&
      (typeof f.location.longitude === 'number' || typeof f.location.oLng === 'number'),
  );
}

function latestMapFeaturesRaw(game: GameState): Record<string, unknown> | unknown[] | null {
  const rounds = game?.rounds;
  if (!rounds || typeof rounds !== 'object') return null;
  const roundNos = Object.keys(rounds).sort((a, b) => Number(b) - Number(a));
  for (const no of roundNos) {
    const features = (rounds[no] as any)?.[adapters.state.roundMapFeaturesKey];
    if (features && Object.keys(features).length) return features;
  }
  return null;
}

/**
 * Features « couvrables » du round courant : tout ce qui n'est PAS une ville du
 * preset (tags city/capital). Les features IA ont oLng/oLat, mais certaines
 * customs sont stockées en longitude/latitude — on accepte les deux formes.
 */
export function latestAiFeatures(game: GameState): Array<{ id: string; feature: MapFeature }> {
  const raw = latestMapFeaturesRaw(game);
  if (!raw || Array.isArray(raw)) return [];
  return Object.entries(raw)
    .filter(([, f]: [string, any]) => {
      if (!f || typeof f.name !== 'string' || !f.location) return false;
      const tags: string[] = Array.isArray(f.tags) ? f.tags : [];
      // Seules les villes du PRESET gardent leur rendu du jeu (étoile, label).
      // Une feature créée par l'IA est couverte MÊME taguée city : l'IA tague
      // `city` ses hubs (Prisme Varsovie…). Discriminant fiable : le preset
      // stocke la position en longitude/latitude, l'IA en oLng/oLat ou région.
      const presetForm =
        typeof f.location.longitude === 'number' && typeof f.location.oLng !== 'number';
      if (tags.includes('city') && presetForm) return false;
      // Position directe OU regionID seul (résolu ensuite via le centroïde).
      return (
        typeof f.location.oLng === 'number' ||
        typeof f.location.longitude === 'number' ||
        typeof f.location.regionID === 'string'
      );
    })
    .map(([id, feature]) => ({ id, feature: feature as MapFeature }));
}

export interface ExcludedFeature {
  id: string;
  name: string;
  tags: string[];
  symbol?: string;
  reason: string;
}

/**
 * Diagnostic : features du round courant HORS couverture (elles gardent le
 * rendu du jeu). Miroir exact du filtre de latestAiFeatures, avec la raison.
 */
export function latestExcludedFeatures(game: GameState): ExcludedFeature[] {
  const raw = latestMapFeaturesRaw(game);
  if (!raw || Array.isArray(raw)) return [];
  const out: ExcludedFeature[] = [];
  for (const [id, f] of Object.entries(raw) as Array<[string, any]>) {
    if (!f || typeof f.name !== 'string') continue;
    const tags: string[] = Array.isArray(f.tags) ? f.tags : [];
    const presetForm =
      !!f.location && typeof f.location.longitude === 'number' && typeof f.location.oLng !== 'number';
    const isCity = tags.includes('city') && presetForm;
    const hasPos =
      !!f.location &&
      (typeof f.location.oLng === 'number' ||
        typeof f.location.longitude === 'number' ||
        typeof f.location.regionID === 'string');
    if (!isCity && hasPos) continue; // couverte
    out.push({
      id,
      name: f.name,
      tags,
      symbol: typeof f.displaySymbol === 'string' ? f.displaySymbol : undefined,
      reason: isCity
        ? tags.includes('capital')
          ? 'tags ville+capitale'
          : 'tag ville'
        : !f.location
          ? 'sans location'
          : 'position illisible',
    });
  }
  return out;
}

/**
 * Features capturées en live via le tap posé sur featureLayer.setFeatures
 * (page-inject) : en multijoueur, l'état ne transite pas par le cache React
 * Query — cette capture passive est notre source de features.
 */
let injectedLiveFeatures: Record<string, MapFeature> | null = null;
let capturedLogged = false;
let rawLogged = false;

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Extrait une liste de features de n'importe quelle forme plausible. */
function toFeatureList(raw: any): any[] {
  if (!raw || typeof raw !== 'object') return [];
  if (raw instanceof Map) return [...raw.values()];
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.features)) return raw.features;
  if (raw.features instanceof Map) return [...raw.features.values()];
  if (raw.features && typeof raw.features === 'object') return Object.values(raw.features);
  return Object.values(raw);
}

/** Capture passive depuis les taps posés sur le calque (args de l'appel). */
export function injectLiveFeatures(args: unknown[]): void {
  try {
    // Premier appel : log INCONDITIONNEL (même si la normalisation échoue).
    if (!rawLogged) {
      rawLogged = true;
      const shapes = args.map((a: any) => {
        if (Array.isArray(a)) return `Array(${a.length})`;
        if (a instanceof Map) return `Map(${a.size})`;
        if (a && typeof a === 'object') return `{${Object.keys(a).slice(0, 6).join(',')}}`;
        return typeof a;
      });
      let sample = '∅';
      try {
        const first = toFeatureList(args[0])[0];
        if (first !== undefined) sample = JSON.stringify(first).slice(0, 600);
      } catch {
        sample = '(non sérialisable)';
      }
      log('🪝 setFeatures appelé —', args.length, 'arg(s) :', shapes.join(' | '), '— 1er élément :', sample);
    }
    for (const arg of args) {
      const list = toFeatureList(arg);
      if (!list.length) continue;
      const out: Record<string, MapFeature> = {};
      for (let i = 0; i < list.length; i++) {
        const f: any = list[i];
        if (!f || typeof f !== 'object') continue;
        const name = typeof f.name === 'string' ? f.name : typeof f.label === 'string' ? f.label : null;
        if (!name) continue;
        const id = typeof f.id === 'string' && f.id ? f.id : String(i);
        if (f.location && typeof f.location === 'object') {
          out[id] = { ...f, name } as MapFeature;
        } else if (
          Array.isArray(f.position) &&
          typeof f.position[0] === 'number' &&
          typeof f.position[1] === 'number'
        ) {
          // Format live : {label, position:[lng,lat], tags…}. Les villes (tag
          // city) prennent la forme « preset » (longitude/latitude → exclues,
          // rendu du jeu conservé) ; le reste la forme « IA » (couverte).
          const tags: string[] = Array.isArray(f.tags) ? f.tags : [];
          const [lng, lat] = f.position as [number, number];
          out[id] = {
            ...f,
            name,
            location: tags.includes('city')
              ? { longitude: lng, latitude: lat }
              : { oLng: lng, oLat: lat, regionID: typeof f.regionID === 'string' ? f.regionID : undefined },
          } as MapFeature;
        } else if (typeof f.mercX === 'number' && typeof f.mercY === 'number') {
          // Format calque : position mercator → oLng/oLat (forme « feature IA »).
          const ll = mercatorToLngLat({ x: f.mercX, y: f.mercY });
          out[id] = { ...f, name, location: { oLng: ll.lng, oLat: ll.lat } } as MapFeature;
        }
      }
      if (Object.keys(out).length < 5) continue;
      injectedLiveFeatures = out;
      if (!capturedLogged) {
        capturedLogged = true;
        log('🪝 features live capturées :', Object.keys(out).length, '— le pipeline démarre');
      }
      return;
    }
  } catch {
    // capture best-effort : jamais casser le jeu
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const eventKey = (c: CollectedEvent) => `${c.roundNo}|${c.event.date}|${c.event.title}`;

const RESUBSCRIBE_POLL_MS = 5_000;

export function startGameStateWatcher(cb: GameStateCallbacks): () => void {
  let client: QueryClientLike | null = null;
  let unsubscribe: (() => void) | null = null;
  let watchedGameId: string | null = null;
  let seen = new Set<string>();
  let primed = false;
  let checkQueued = false;
  const centroidCache = new Map<string, { lng: number; lat: number } | null>();

  /**
   * La géométrie de carte est aussi dans le cache React Query, sous la clé
   * ["mapGeometry", game.mapGeometryDocumentID] : geometry[regionID].centroid
   * est un Point GeoJSON sérialisé en string.
   */
  const makeRegionCentroid = (game: GameState) => (regionID: string) => {
    if (!regionID) return null;
    // ⚠️ ne JAMAIS mettre les échecs en cache : la géométrie peut ne pas être
    // encore chargée au premier passage (elle arrive après les événements).
    const cached = centroidCache.get(regionID);
    if (cached) return cached;
    try {
      const docId = (game as any).mapGeometryDocumentID;
      let geo: any = client && docId ? client.getQueryData(['mapGeometry', docId]) : null;
      if (!geo?.geometry && client?.getQueryCache().getAll) {
        // clé inconnue/différente : une seule géométrie par page, on la scanne
        const q = client
          .getQueryCache()
          .getAll!()
          .find((c) => Array.isArray(c.queryKey) && c.queryKey[0] === 'mapGeometry' && c.state?.data);
        geo = q?.state?.data ?? geo;
      }
      const entry = geo?.geometry?.[regionID] ?? geo?.[regionID];
      let point: any = entry?.centroid ?? entry;
      if (typeof point === 'string') point = JSON.parse(point);
      const coords = Array.isArray(point) ? point : point?.coordinates;
      if (Array.isArray(coords) && typeof coords[0] === 'number' && typeof coords[1] === 'number') {
        const result = { lng: coords[0], lat: coords[1] };
        centroidCache.set(regionID, result);
        return result;
      }
    } catch {
      // géométrie illisible : on retentera au prochain passage
    }
    return null;
  };

  const readGame = (gameId: string): GameState | null => {
    if (client) {
      const data = client.getQueryData([adapters.state.reactQueryKey(gameId)]);
      if (looksLikeGame(data)) return data;
    }
    const viaFiber = findGameViaFiber();
    return viaFiber && looksLikeGame(viaFiber) ? viaFiber : null;
  };

  /**
   * Les parties multijoueur n'ont pas forcément l'URL /game/{uuid} ni la clé
   * simpleGames/… : en dernier recours, on scanne le cache à la recherche de
   * toute donnée qui a la FORME d'un état de partie.
   */
  const scanCacheForGame = (): { game: GameState; id: string } | null => {
    try {
      const all = client?.getQueryCache().getAll?.() ?? [];
      for (const q of all) {
        const data = q.state?.data;
        if (looksLikeGame(data)) {
          const uid = (data as any).UID;
          const key = Array.isArray(q.queryKey) ? String(q.queryKey[0]) : 'unknown';
          return { game: data, id: typeof uid === 'string' && uid ? uid : key };
        }
      }
    } catch {
      // cache illisible : tant pis pour le scan
    }
    return null;
  };

  /**
   * Live : la signature exacte d'une partie solo n'est pas garantie — tout
   * objet du cache qui porte un objet `rounds` non vide fait l'affaire.
   */
  const scanCacheForRounds = (): { game: GameState; id: string } | null => {
    try {
      const all = client?.getQueryCache().getAll?.() ?? [];
      for (const q of all) {
        const data: any = q.state?.data;
        const rounds = data?.rounds;
        if (rounds && typeof rounds === 'object' && !Array.isArray(rounds) && Object.keys(rounds).length) {
          const uid = typeof data.UID === 'string' && data.UID ? data.UID : null;
          const key = Array.isArray(q.queryKey) ? String(q.queryKey[0]) : 'unknown';
          return { game: data as GameState, id: uid ?? key };
        }
      }
    } catch {
      // cache illisible : tant pis pour le scan
    }
    return null;
  };

  const diagnosedPaths = new Set<string>();

  /**
   * Parties multijoueur /live/{uuid} : reconstruit un pseudo-état de partie à
   * partir des requêtes ["liveGame","events",{roundNumber:N}] du cache.
   * Le schéma des événements est le même générateur qu'en solo.
   */
  const readLiveGame = (): { game: GameState; id: string } | null => {
    const m = location.pathname.match(adapters.liveUrl);
    if (!m || !client?.getQueryCache().getAll) return null;
    const uuid = m[1]!;
    const rounds: Record<string, unknown> = {};
    for (const q of client.getQueryCache().getAll!()) {
      const key = q.queryKey;
      if (!Array.isArray(key) || key[0] !== 'liveGame' || key[1] !== 'events') continue;
      const roundNo = String((key[2] as any)?.roundNumber ?? Object.keys(rounds).length);
      const data: any = q.state?.data;
      const events = Array.isArray(data) ? data : Array.isArray(data?.events) ? data.events : [];
      const valid = events.filter((e: any) => e && typeof e.title === 'string');
      if (valid.length) rounds[roundNo] = { [adapters.state.roundEventsKey]: valid };
    }
    // Sources de features par priorité : capture setFeatures (tap posé par
    // page-inject), puis scan du fiber en secours (coûteux : seulement si la
    // capture n'a encore rien donné).
    const scan = injectedLiveFeatures
      ? { events: [] as GameEvent[], mapFeatures: null }
      : scanFibersForLiveData();
    const liveFeatures = injectedLiveFeatures ?? scan.mapFeatures;
    // Même sans événements : les mapFeatures suffisent (le balayage couvre tout).
    if (!Object.keys(rounds).length && (scan.events.length || liveFeatures)) {
      rounds['1'] = { [adapters.state.roundEventsKey]: scan.events };
    }
    const roundNos = Object.keys(rounds).sort((a, b) => Number(b) - Number(a));
    if (roundNos.length && liveFeatures) {
      (rounds[roundNos[0]!] as any)[adapters.state.roundMapFeaturesKey] = liveFeatures;
    }
    if (!roundNos.length) return null;
    return { game: { rounds } as GameState, id: uuid };
  };

  const check = () => {
    checkQueued = false;
    const urlGameId = currentGameId();
    let gameId = urlGameId;
    let game = gameId ? readGame(gameId) : null;

    // Multijoueur : modèle liveGame dédié.
    const liveMatch = location.pathname.match(adapters.liveUrl);
    if (!game) {
      const live = readLiveGame();
      if (live) {
        game = live.game;
        gameId = live.id;
      }
    }
    // Live : tout objet du cache portant des rounds fait l'affaire.
    if (!game && liveMatch) {
      const scanned = scanCacheForRounds();
      if (scanned) {
        game = scanned.game;
        gameId = liveMatch[1] ?? scanned.id;
      }
    }

    // Fallback : page avec carte mais URL/clé non reconnues.
    if (!game && document.querySelector('canvas')) {
      const scanned = scanCacheForGame();
      if (scanned) {
        game = scanned.game;
        gameId = urlGameId ?? scanned.id;
      } else if (
        (urlGameId || liveMatch) &&
        client?.getQueryCache().getAll &&
        !diagnosedPaths.has(location.pathname)
      ) {
        diagnosedPaths.add(location.pathname);
        const keys = (client.getQueryCache().getAll?.() ?? [])
          .map((q) => JSON.stringify(q.queryKey).slice(0, 80))
          .slice(0, 30);
        log('🔍 aucun état de partie reconnu sur', location.pathname, '— clés du cache :', keys);
      }
    }

    if (!gameId || !game) {
      if (!urlGameId) watchedGameId = null;
      return;
    }
    if (gameId !== watchedGameId) {
      watchedGameId = gameId;
      seen = new Set();
      centroidCache.clear();
      primed = false;
    }

    const collected = collectEvents(game);
    const fresh = collected.filter((c) => !seen.has(eventKey(c)));
    for (const c of fresh) seen.add(eventKey(c));
    // On passe TOUJOURS la main, même sans événement frais : le balayage des
    // features doit pouvoir retenter les positions (la géométrie de carte
    // arrive APRÈS les premiers événements), suivre les déplacements et
    // détecter les disparitions. Le récepteur ne loggue/sauve que les diffs.

    const context: NewEventsContext = {
      gameId,
      game,
      mapFeatures: latestMapFeatures(game),
      aiFeatures: latestAiFeatures(game),
      regionCentroid: makeRegionCentroid(game),
      initial: !primed,
    };
    primed = true;
    cb.onNewEvents(fresh, context);
  };

  const scheduleCheck = () => {
    if (checkQueued) return;
    checkQueued = true;
    setTimeout(check, 50); // coalesce les rafales de notifications du cache
  };

  const trySubscribe = () => {
    if (client) return;
    client = findQueryClient();
    if (!client) return;
    try {
      unsubscribe = client.getQueryCache().subscribe((event) => {
        try {
          const key = event?.query?.queryKey;
          const gameId = currentGameId();
          const matchesUrlKey =
            gameId && Array.isArray(key) && key[0] === adapters.state.reactQueryKey(gameId);
          // multijoueur : mises à jour liveGame, ou donnée à la forme d'un game
          const isLive = Array.isArray(key) && key[0] === 'liveGame';
          const looksGame = looksLikeGame(event?.query?.state?.data);
          if (matchesUrlKey || isLive || looksGame) scheduleCheck();
        } catch {
          // une notification malformée ne doit pas casser l'abonnement
        }
      });
      log('QueryClient trouvé — abonnement au cache actif');
      scheduleCheck();
    } catch {
      client = null;
    }
  };

  // Poll léger : (ré)abonnement, navigation SPA, et filet de sécurité si une
  // mise à jour du cache n'a pas déclenché de notification exploitable.
  const timer = setInterval(() => {
    try {
      trySubscribe();
      scheduleCheck();
    } catch {
      // on retentera au tick suivant
    }
  }, RESUBSCRIBE_POLL_MS);

  try {
    trySubscribe();
  } catch {
    // le poll prendra le relais
  }

  return () => {
    clearInterval(timer);
    try {
      unsubscribe?.();
    } catch {
      // cache déjà détruit
    }
  };
}
