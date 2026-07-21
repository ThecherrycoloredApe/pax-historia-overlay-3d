/**
 * Point d'entrée main world (tous frames, document_start).
 * Top frame : engine bridge + lecture d'état + cycle de vie des structures.
 * Tous frames : tap diagnostique de /api/simple-chat.
 */

import { adapters } from './config/adapters';
import { installFetchTap } from './fetch-tap';
import { startEngineBridge, type PaxEngine } from './engine-bridge';
import { createStructurePanel } from './structure-panel';
import { startGameStateWatcher, latestExcludedFeatures, injectLiveFeatures } from './game-state';
import { StructureTracker, type PlacedStructure } from './structures';
import { featureTypeFromTags } from './parser';
import { loadAssetTemplates } from './render3d/asset-models';
import { createLabelHider } from './label-hider';
import { installDebugMarkers, type TestPoint } from './debug-markers';
import { installOverlay, type Overlay } from './render3d/overlay';
import { relayToTop, onBridgeMessage } from './lib/messages';
import { log, warn } from './lib/log';

/** Marqueurs de diagnostic (étape 2) — activables via localStorage.paxOverlayDebug = '1'. */
const TEST_POINTS: TestPoint[] = [
  { name: 'Paris', lng: 2.3522, lat: 48.8566 },
  { name: 'Lyon', lng: 4.8357, lat: 45.764, color: '#34c759' },
  { name: 'Marseille', lng: 5.3698, lat: 43.2965, color: '#007aff' },
  { name: 'London', lng: -0.1276, lat: 51.5072 },
  { name: 'New York', lng: -74.006, lat: 40.7128 },
  { name: 'Tokyo', lng: 139.6917, lat: 35.6895 },
];

function debugMarkersEnabled(): boolean {
  try {
    return localStorage.getItem('paxOverlayDebug') === '1';
  } catch {
    return false;
  }
}

/**
 * Multijoueur : l'état ne transite pas par le cache React Query — la seule
 * source de features est l'appel setFeatures(features) que le jeu fait à son
 * calque de carte. On trouve le calque (sonde périodique : il n'existe
 * qu'après l'acquisition du moteur) puis on enveloppe sa méthode de façon
 * passive : capture de l'argument, exécution strictement identique.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
let liveLayer: any = null;
let liveLayerAttempts = 0;

function findFeatureLayer(engine: object): any {
  // Recherche en largeur sur 2 niveaux : le calque peut être une propriété
  // directe du moteur (cas solo) ou imbriqué un cran plus bas.
  const seen = new Set<object>();
  let level: object[] = [engine];
  for (let depth = 0; depth < 2 && level.length; depth++) {
    const next: object[] = [];
    for (const obj of level) {
      let values: unknown[];
      try {
        values = Object.values(obj);
      } catch {
        continue;
      }
      for (const v of values) {
        if (!v || typeof v !== 'object' || seen.has(v)) continue;
        seen.add(v);
        if (typeof (v as any).setFeatureLabelOpacity === 'function') return v;
        next.push(v);
      }
    }
    level = next;
  }
  return null;
}

let setFeaturesTapped = false;

function installSetFeaturesTap(layer: any): void {
  if (setFeaturesTapped) return;
  // Posé sur le PROTOTYPE : survit aux recréations du calque (navigation SPA).
  const proto = Object.getPrototypeOf(layer);
  const target = proto && typeof proto.setFeatures === 'function' ? proto : layer;
  const original = target?.setFeatures;
  if (typeof original !== 'function') return;
  setFeaturesTapped = true;
  target.setFeatures = function (this: unknown, ...args: unknown[]) {
    try {
      injectLiveFeatures(args);
    } catch {
      // observation seule : jamais casser le jeu
    }
    return original.apply(this, args as never[]);
  };
  log('🪝 tap setFeatures posé (capture passive des features live)');
}

/** @returns true quand le tap est posé (ou abandon silencieux). */
function ensureLiveTap(engine: object): boolean {
  if (setFeaturesTapped) return true;
  if (++liveLayerAttempts > 30) return true; // calque introuvable : abandon
  if (!liveLayer) liveLayer = findFeatureLayer(engine);
  if (!liveLayer) return false;
  installSetFeaturesTap(liveLayer);
  return setFeaturesTapped;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

try {
  installFetchTap();

  if (window === window.top) {
    log('page script chargé (top frame) — v0.2 —', location.pathname);
    let removeMarkers: (() => void) | null = null;
    let overlay: Overlay | null = null;
    let overlayEnabled = true;
    let models3dEnabled = true;
    let layerProbeTimer: number | null = null;
    // Filtre par catégorie (états/types masqués), mémorisé par partie.
    const hiddenStates = new Set<string>();
    const hiddenTypes = new Set<string>();
    let activeGameId: string | null = null;
    const tracker = new StructureTracker();
    const labelHider = createLabelHider();
    let currentEngine: PaxEngine | null = null;
    // Panneau intégré : liste en direct + recherche + localisation au clic.
    const panel = createStructurePanel({
      getStructures: () => tracker.getAll(),
      locate: (s) => {
        try {
          /* eslint-disable @typescript-eslint/no-explicit-any */
          const anyEngine = currentEngine as any;
          if (!anyEngine || typeof anyEngine.flyTo !== 'function') return;
          try {
            anyEngine.flyTo({ center: [s.lng, s.lat], zoom: 7.2 });
          } catch {
            anyEngine.flyTo(s.lng, s.lat, 7.2);
          }
          /* eslint-enable @typescript-eslint/no-explicit-any */
          overlay?.pulse(s.id);
        } catch {
          // jamais casser le jeu
        }
      },
      onFilterChange: (states, types) => {
        hiddenStates.clear();
        for (const s of states) hiddenStates.add(s);
        hiddenTypes.clear();
        for (const t of types) hiddenTypes.add(t);
        pushToOverlay();
        applyMasking();
        if (activeGameId) relayToTop({ type: 'filter:save', gameId: activeGameId, states, types });
      },
    });
    let restoreRequestedFor: string | null = null;
    // Le watcher repasse toutes les 5 s même sans événement (retente les
    // positions, suit les déplacements) : on ne loggue que ce qui change.
    const warnedNames = new Set<string>();
    let lastCoverage = '';
    let lastExcluded = '';

    const isVisible = (s: PlacedStructure) => !hiddenStates.has(s.state) && !hiddenTypes.has(s.type);
    const pushToOverlay = () => overlay?.setStructures(tracker.getAll().filter(isVisible));
    // Masque UNIQUEMENT les symboles du jeu couverts par une icône VISIBLE : une
    // catégorie filtrée récupère donc son symbole d'origine (pas de trou).
    const applyMasking = () =>
      labelHider.setIds(
        tracker
          .getAll()
          .filter(isVisible)
          .filter((s) => s.source === 'mapChange' && s.id.startsWith('mc:'))
          .map((s) => s.id.slice(3)),
      );
    const save = (gameId: string) =>
      relayToTop({ type: 'structures:save', gameId, structures: tracker.serialize() });

    // Modèles Kenney (CC0) : chargement async, re-push quand prêts.
    loadAssetTemplates().then(pushToOverlay);

    // Messages du content script : restauration + pilotage depuis le popup.
    onBridgeMessage((msg) => {
      switch (msg.type) {
        case 'structures:restore': {
          activeGameId = msg.gameId;
          overlayEnabled = msg.enabled;
          overlay?.setVisible(overlayEnabled);
          panel.setVisible(overlayEnabled);
          models3dEnabled = msg.models3d;
          overlay?.setModelsEnabled(models3dEnabled);
          labelHider.setEnabled(msg.hideLabels);
          // Filtre par catégorie persisté pour cette partie (états/types masqués).
          hiddenStates.clear();
          for (const s of msg.hiddenStates) hiddenStates.add(s);
          hiddenTypes.clear();
          for (const t of msg.hiddenTypes) hiddenTypes.add(t);
          panel.setFilter(msg.hiddenStates, msg.hiddenTypes);
          const changed =
            tracker.restore(msg.gameId, msg.structures as PlacedStructure[]) ||
            tracker.applyTombstones(msg.tombstones);
          // Masque sans attendre la première lecture d'état — en multi (F5 à
          // froid), les données peuvent n'arriver qu'au prochain tour : les
          // icônes restaurées doivent éteindre leurs symboles du jeu tout de
          // suite (invariant « masqué ⇒ remplacé », filtre appliqué).
          applyMasking();
          pushToOverlay();
          if (changed) {
            log(`💾 ${msg.structures.length} structure(s) restaurée(s) depuis le storage`);
            // Re-sauvegarde immédiate : purge du storage des entrées périmées.
            save(msg.gameId);
          }
          panel.refresh();
          break;
        }
        case 'structures:tombstones':
          if (tracker.applyTombstones(msg.ids)) {
            log('🗑️ suppression(s) manuelle(s) appliquée(s) depuis le popup');
            pushToOverlay();
            applyMasking();
            save(msg.gameId);
          }
          break;
        case 'overlay:enabled':
          overlayEnabled = msg.enabled;
          overlay?.setVisible(overlayEnabled);
          panel.setVisible(overlayEnabled);
          log(overlayEnabled ? '👁️ overlay activé' : '🙈 overlay masqué (popup)');
          break;
        case 'labels:hide':
          labelHider.setEnabled(msg.hide);
          log(msg.hide ? '🔇 labels du jeu masqués (popup)' : '🔊 labels du jeu restaurés (popup)');
          break;
        case 'models:enabled':
          models3dEnabled = msg.enabled;
          overlay?.setModelsEnabled(models3dEnabled);
          log(msg.enabled ? '🏙️ bâtiments 3D activés (popup)' : '⭕ icônes partout (popup)');
          break;
      }
    });

    startGameStateWatcher({
      onNewEvents: (events, context) => {
        activeGameId = context.gameId;
        if (events.length || context.initial) {
          log(
            context.initial ? 'événements historiques lus' : 'NOUVEAUX événements',
            events.map((c) => `[tour ${c.roundNo}] ${c.event.title}`),
            `— ${context.mapFeatures.length} mapFeatures disponibles`,
          );
          relayToTop({
            type: 'events:new',
            gameId: context.gameId,
            initial: context.initial,
            count: events.length,
            titles: events.map((c) => c.event.title).slice(0, 10),
          });
        }

        if (restoreRequestedFor !== context.gameId) {
          restoreRequestedFor = context.gameId;
          warnedNames.clear();
          lastCoverage = '';
          lastExcluded = '';
          relayToTop({ type: 'structures:request', gameId: context.gameId });
        }

        // Diagnostic : ce qui garde le rendu du jeu (hors couverture). Les
        // simples villes du preset sont résumées en compteur ; le tableau ne
        // montre que les cas intéressants (capitales, symboles custom, sans
        // position) — c'est là que se cachent les Secretariats & drapeaux.
        const excluded = latestExcludedFeatures(context.game);
        const exKey = excluded.map((e) => e.id).sort().join(',');
        if (excluded.length && exKey !== lastExcluded) {
          lastExcluded = exKey;
          // Les villes/capitales du preset (tag city) sont attendues : compteur
          // seul. On ne liste que les cas à examiner (position illisible…).
          const cityTagged = excluded.filter((e) => e.tags.includes('city'));
          const mystery = excluded.filter((e) => !e.tags.includes('city'));
          log(
            `🚫 ${excluded.length} feature(s) HORS couverture (rendu du jeu conservé) : ${cityTagged.length} villes/capitales du preset, ${mystery.length} cas à examiner`,
          );
          for (const e of mystery.slice(0, 60)) {
            log(`🚫 ${e.name} — tags [${e.tags.join(', ')}] — symbole ${e.symbol ?? '∅'} — ${e.reason}`);
          }
        }
        const { added, promoted, destroyed, moved, skipped } = tracker.processEvents(events, context);
        // Invariant « masqué ⇒ remplacé » : on n'éteint le symbole du jeu QUE pour
        // les features couvertes par une icône VISIBLE (filtre appliqué). Une
        // feature non plaçable — ou une catégorie masquée — garde son rendu.
        applyMasking();
        // Bilan de couverture : loggé uniquement quand les chiffres bougent.
        if (context.aiFeatures.length) {
          const all = tracker.getAll();
          const coverage = `📊 couverture : ${context.aiFeatures.length} feature(s) sur la carte, ${all.filter((s) => s.source === 'mapChange').length} représentée(s) (${all.filter((s) => s.type === 'unit').length} ⚔️) — détail : localStorage.paxOverlayDebug='1'`;
          if (coverage !== lastCoverage) {
            lastCoverage = coverage;
            log(coverage);
            try {
              if (localStorage.getItem('paxOverlayDebug') === '1') {
                console.table(
                  context.aiFeatures.slice(0, 300).map(({ feature }) => ({
                    nom: feature.name,
                    tags: (feature.tags ?? []).join(', '),
                    type: featureTypeFromTags(feature.tags ?? [], feature.name),
                  })),
                );
              }
            } catch {
              // console.table indisponible : sans importance
            }
          }
        }
        if (context.initial) {
          // Chargement initial : un résumé suffit (le détail inondait la console).
          if (added.length || promoted.length || destroyed.length) {
            log(
              `🏗️ balayage initial : ${added.length} structure(s) posée(s), ${promoted.length} achèvement(s), ${destroyed.length} ruine(s)`,
            );
          }
        } else {
          for (const s of added) {
            const label =
              s.source === 'mapChange'
                ? `bâtiment du jeu (${s.type})`
                : s.state === 'built'
                  ? 'structure détectée (déjà achevée)'
                  : 'chantier détecté';
            log(`🏗️ ${label} :`, s.id, `(${s.lng.toFixed(3)}, ${s.lat.toFixed(3)})`);
          }
          for (const s of promoted) log('✅ chantier terminé :', s.id, s.builtDate ?? '(délai in-game écoulé)');
          for (const s of destroyed) log('💥 structure détruite → ruines :', s.id, s.destroyedDate ?? '');
        }
        // Diagnostic : seules les positions introuvables signalent un vrai trou
        // — une seule fois par nom, et JAMAIS au premier passage (la géométrie
        // de carte n'est souvent pas encore chargée ; le balayage retente).
        for (const sk of skipped) {
          if (sk.reason === 'position-introuvable' && !context.initial && !warnedNames.has(sk.name)) {
            warnedNames.add(sk.name);
            warn('⚠️ feature du jeu SANS bâtiment (position introuvable) :', sk.name, sk.change);
          }
        }
        if (added.length || promoted.length || destroyed.length || moved) {
          pushToOverlay();
          save(context.gameId);
          panel.refresh();
        }
      },
    });

    startEngineBridge({
      onAcquired: (engine) => {
        let visualZoom: number | null = null;
        try {
          visualZoom = typeof engine.visualZoom === 'number' ? engine.visualZoom : null;
        } catch {
          // getter capricieux : sans importance ici
        }
        relayToTop({ type: 'engine:acquired', projection: engine.projection, visualZoom });

        removeMarkers?.();
        removeMarkers = debugMarkersEnabled() ? installDebugMarkers(engine, TEST_POINTS) : null;

        overlay?.destroy();
        overlay = installOverlay(engine);
        overlay?.setVisible(overlayEnabled);
        overlay?.setModelsEnabled(models3dEnabled);
        labelHider.attach(engine);
        currentEngine = engine;
        panel.attach();
        pushToOverlay();

        try {
          const liveMatch = location.pathname.match(adapters.liveUrl);
          if (liveMatch) {
            // F5 à froid en multi : restaure tout de suite les structures déjà
            // sauvegardées pour cette partie (la capture live mettra à jour).
            const uuid = liveMatch[1]!;
            if (restoreRequestedFor !== uuid) {
              restoreRequestedFor = uuid;
              relayToTop({ type: 'structures:request', gameId: uuid });
            }
            if (layerProbeTimer !== null) clearInterval(layerProbeTimer);
            layerProbeTimer = window.setInterval(() => {
              try {
                if (ensureLiveTap(engine) && layerProbeTimer !== null) {
                  clearInterval(layerProbeTimer);
                  layerProbeTimer = null;
                }
              } catch {
                // best-effort : jamais casser le jeu
              }
            }, 3_000);
          }
        } catch {
          // diagnostic best-effort : jamais casser le jeu
        }
      },
      onViewChange: (view) => relayToTop({ type: 'view:change', ...view }),
      onLost: () => {
        removeMarkers?.();
        removeMarkers = null;
        overlay?.destroy();
        overlay = null;
        labelHider.detach();
        currentEngine = null;
        panel.detach();
        if (layerProbeTimer !== null) {
          clearInterval(layerProbeTimer);
          layerProbeTimer = null;
        }
        relayToTop({ type: 'engine:lost' });
      },
    });
  }
} catch (e) {
  // Ne jamais casser le jeu : l'overlay se désactive silencieusement.
  warn('désactivé suite à une erreur d’initialisation', e);
}
