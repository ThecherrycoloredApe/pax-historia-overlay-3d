/**
 * Masque les labels des features créées par l'IA (jamais ceux des villes du
 * preset) pour désencombrer la carte — la fiche s'affiche au clic sur nos
 * bâtiments 3D à la place.
 *
 * S'appuie sur l'API interne du feature layer (`setFeatureLabelOpacity`),
 * trouvée structurellement. Best-effort absolu : si le build du site change
 * la signature, tout échoue en silence et les labels restent visibles.
 * Ré-application périodique : le layer reconstruit ses buffers à chaque
 * setFeatures (nouvel événement, zoom…), ce qui réinitialise les opacités.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { PaxEngine } from './engine-bridge';
import { adapters } from './config/adapters';
import { log, warn } from './lib/log';

const REAPPLY_MS = 3_000;

/** Couche trouvée + noms des méthodes retenues (ils peuvent changer). */
type Layer = { obj: any; labelFn: string; symbolFn: string | null };

/**
 * Noms de méthodes d'un objet, PROTOTYPE COMPRIS : les classes minifiées du
 * jeu portent leurs méthodes sur le prototype, où `Object.keys` ne voit rien.
 */
function methodNames(o: any): string[] {
  const out = new Set<string>();
  for (let p = o; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    for (const n of Object.getOwnPropertyNames(p)) {
      try {
        if (typeof o[n] === 'function') out.add(n);
      } catch {
        // getter qui jette : on l'ignore
      }
    }
  }
  return [...out];
}

const pick = (o: any, names: readonly string[], pattern: RegExp): string | null =>
  names.find((n) => typeof o[n] === 'function') ??
  methodNames(o).find((n) => pattern.test(n)) ??
  null;

/**
 * Cherche la couche des features en largeur depuis le moteur. L'ancienne
 * version ne regardait QUE les propriétés directes : le jour où le jeu a
 * déplacé la couche d'un cran, le masquage s'est arrêté sans un bruit.
 */
function findLayer(engine: any): Layer | null {
  const cfg = adapters.engine.featureLayer;

  // 1. Résolution DIRECTE de la vraie couche. Indispensable : le moteur
  //    expose les mêmes noms de méthodes en façade, mais elles délèguent à un
  //    `_featureLayer` qui vaut null — les appels y disparaissent en silence.
  //    Sans ce passage, l'exploration ci-dessous s'arrête sur le moteur
  //    lui-même (profondeur 0) et le masquage ne fait plus rien.
  const direct = cfg.resolveLayer(engine);
  if (direct) {
    const labelFn = pick(direct, cfg.labelOpacityMethods, cfg.labelOpacityPattern);
    if (labelFn) {
      return {
        obj: direct,
        labelFn,
        symbolFn: pick(direct, cfg.symbolOpacityMethods, cfg.symbolOpacityPattern),
      };
    }
  }

  // 2. Repli : exploration en largeur (retombera sur la façade du moteur).
  const seen = new Set<any>();
  const queue: Array<{ o: any; depth: number }> = [{ o: engine, depth: 0 }];
  let budget = cfg.maxNodes;

  while (queue.length && budget-- > 0) {
    const { o, depth } = queue.shift()!;
    if (!o || typeof o !== 'object' || seen.has(o)) continue;
    seen.add(o);

    const labelFn = pick(o, cfg.labelOpacityMethods, cfg.labelOpacityPattern);
    if (labelFn) {
      return { obj: o, labelFn, symbolFn: pick(o, cfg.symbolOpacityMethods, cfg.symbolOpacityPattern) };
    }

    if (depth >= cfg.maxDepth) continue;
    for (const [key, value] of Object.entries(o)) {
      if ((cfg.skipKeys as readonly string[]).includes(key)) continue;
      if (!value || typeof value !== 'object') continue;
      if (typeof Node !== 'undefined' && value instanceof Node) continue;
      queue.push({ o: value, depth: depth + 1 });
    }
  }
  return null;
}

const debugEnabled = (): boolean => {
  try {
    return localStorage.getItem('paxOverlayDebug') === '1';
  } catch {
    return false;
  }
};

/**
 * Cas vicieux : la couche est trouvée, les appels passent SANS exception, et
 * pourtant symboles et libellés restent affichés. Deux causes possibles, que
 * ce dump départage :
 *
 *  1. les identifiants du jeu ont changé — la couche ignore silencieusement
 *     des ids qu'elle ne connaît pas (comparer nos ids à ses clés) ;
 *  2. le jeu dessine désormais ses libellés en HTML par-dessus le canvas — la
 *     méthode existe encore mais ne pilote plus rien (compter les nœuds texte
 *     positionnés au-dessus de la carte).
 */
function dumpLayer(layer: Layer, ids: string[], engine: any): void {
  try {
    console.log(`[PaxOverlay] 🔍 nos ids (5 premiers, sur ${ids.length}) :`, ids.slice(0, 5));
    console.log(`[PaxOverlay] 🔍 objet piloté (${layer.labelFn}) :`, layer.obj);

    // LA question : le moteur reconnaît-il nos identifiants ? Une couche qui
    // reçoit un id inconnu l'ignore sans lever d'erreur — d'où 94 « succès »
    // sans effet visible. isFeatureVisible() répond directement, sans rien
    // modifier.
    const probe = ids.slice(0, 8).map((id) => {
      const read = (fn: string, target: any) => {
        try {
          return typeof target?.[fn] === 'function' ? String(target[fn](id)) : 'absent';
        } catch (e: any) {
          return `err: ${String(e?.message ?? e).slice(0, 30)}`;
        }
      };
      return {
        id,
        'moteur.isFeatureVisible': read('isFeatureVisible', engine),
        '_featureLayer.isFeatureVisible': read('isFeatureVisible', engine?._featureLayer),
      };
    });
    console.table(probe);

    // Les couches réellement enregistrées : celle qui dessine les features
    // aujourd'hui doit s'y trouver, avec un maillage non nul.
    const layers: any[] = engine?._registry?._layers ?? [];
    console.table(
      layers.map((l: any, i: number) => ({
        i,
        id: l?.id,
        classe: l?.constructor?.name,
        priorite: l?.renderPriority,
        lastViewZoom: l?._lastViewZoom,
        aLabelOpacity: typeof l?.setFeatureLabelOpacity === 'function',
        maillage: l?._shapeMesh || l?._internalMesh || l?._mesh ? 'oui' : 'non',
      })),
    );

    // Le moteur peut déléguer à une couche EXTERNE : si elle existe, c'est
    // elle qu'il faut piloter, pas _featureLayer.
    console.log('[PaxOverlay] 🔍 _externalFeatureLayer :', engine?._externalFeatureLayer);
    console.log('[PaxOverlay] 🔍 _featureLayer :', engine?._featureLayer);
  } catch (e) {
    warn('diagnostic du masquage indisponible', e);
  }
}

/**
 * Inventaire des méthodes plausibles exposées par le moteur, à coller dans un
 * rapport quand le masquage ne trouve plus sa couche : c'est ce qui permet de
 * remettre le bon nom dans adapters.engine.featureLayer.
 */
function describeEngine(engine: any): string {
  const cfg = adapters.engine.featureLayer;
  const interesting = /feature|label|opacity|alpha|symbol|marker|poi/i;
  const lines: string[] = [];
  const seen = new Set<any>();
  // Même parcours que findLayer : une couche ajoutée par une mise à jour du
  // jeu peut être imbriquée, pas forcément à la racine du moteur.
  const queue: Array<{ o: any; path: string; depth: number }> = [
    { o: engine, path: 'engine', depth: 0 },
  ];
  let budget = cfg.maxNodes;

  while (queue.length && budget-- > 0) {
    const { o, path, depth } = queue.shift()!;
    if (!o || typeof o !== 'object' || seen.has(o)) continue;
    seen.add(o);

    const fns = methodNames(o).filter((n) => interesting.test(n));
    if (fns.length) lines.push(`${path} → ${fns.join(', ')}`);

    if (depth >= cfg.maxDepth) continue;
    for (const [key, value] of Object.entries(o)) {
      if ((cfg.skipKeys as readonly string[]).includes(key)) continue;
      if (!value || typeof value !== 'object') continue;
      if (typeof Node !== 'undefined' && value instanceof Node) continue;
      queue.push({ o: value, path: `${path}.${key}`, depth: depth + 1 });
    }
  }
  return lines.length ? lines.join('\n') : '(aucune méthode plausible trouvée)';
}

export interface LabelHider {
  attach(engine: PaxEngine): void;
  detach(): void;
  setIds(ids: string[]): void;
  setEnabled(enabled: boolean): void;
  destroy(): void;
}

export function createLabelHider(): LabelHider {
  let engine: PaxEngine | null = null;
  let ids: string[] = [];
  let enabled = true;
  let announced = false;
  let diagnosed = false;

  const apply = (targetOpacity?: number) => {
    if (!engine || !ids.length) return;
    const layer = findLayer(engine);
    if (!layer) {
      // Le masquage est le SEUL mécanisme qui dépende de noms de méthodes du
      // jeu : quand il ne trouve plus sa couche, les symboles et libellés
      // d'origine réapparaissent sans que rien d'autre ne casse. On le dit une
      // fois, avec de quoi remettre le bon nom dans adapters.
      if (!diagnosed) {
        diagnosed = true;
        warn(
          'couche des features introuvable — symboles et libellés du jeu restent visibles.\n' +
            'Méthodes exposées par le moteur (à reporter dans adapters.engine.featureLayer) :\n' +
            describeEngine(engine),
        );
      }
      return;
    }
    const opacity = targetOpacity ?? (enabled ? 0 : 1);
    let ok = 0;
    let failed = 0;
    for (const id of ids) {
      // Symbole ET label : nos icônes/bâtiments remplacent l'affichage du jeu
      // (le hit-test du jeu reste actif → le clic ouvre toujours sa fiche).
      // ⚠️ try/catch PAR id : un id inconnu du layer (feature recréée/pas
      // encore synchronisée) ne doit pas empêcher de masquer les suivants.
      try {
        layer.obj[layer.labelFn](id, opacity);
        if (layer.symbolFn) {
          try {
            layer.obj[layer.symbolFn](id, opacity);
          } catch {
            // certaines features n'exposent pas l'opacité du symbole : le label suffit
          }
        }
        ok++;
      } catch {
        failed++;
      }
    }
    if (!announced && enabled && ok > 0) {
      announced = true;
      // La cible compte autant que le nombre : « couche feature » = la vraie
      // couche ; « moteur (façade) » = le repli, dont les appels sont sans
      // effet tant que engine._featureLayer vaut null.
      const cible = layer.obj?.id ? `couche « ${layer.obj.id} »` : 'moteur (façade)';
      log(
        `🔇 symboles+labels du jeu masqués : ${ok}/${ids.length} feature(s) ` +
          `sur la ${cible} via ${layer.labelFn}${layer.symbolFn ? ` + ${layer.symbolFn}` : ''}` +
          (failed ? ` (${failed} id(s) non reconnus par le layer, réessai auto)` : ''),
      );
      // ⚠️ « ok » ne prouve QUE l'absence d'exception, pas l'effet visuel : une
      // couche qui reçoit un id inconnu l'ignore sans rien dire. D'où ce dump.
      if (debugEnabled()) dumpLayer(layer, ids, engine);
    }
  };

  const timer = setInterval(() => {
    try {
      if (enabled) apply();
    } catch {
      // jamais casser le jeu
    }
  }, REAPPLY_MS);

  return {
    attach(e: PaxEngine) {
      engine = e;
      // Point d'entrée MANUEL : `__paxOverlay.diag()` dans la console.
      // Chercher une ligne de log au bon moment s'est révélé peu fiable (le
      // dump ne s'émet qu'une fois, au premier masquage réussi, et dépend d'un
      // drapeau localStorage). Une commande à la demande supprime ces aléas.
      try {
        (window as any).__paxOverlay = {
          diag() {
            if (!engine) return 'moteur de carte non acquis';
            console.log(`[PaxOverlay] 🔍 ${ids.length} id(s) à masquer :`, ids.slice(0, 5));
            const layer = findLayer(engine);
            if (!layer) {
              console.log('[PaxOverlay] 🔍 couche INTROUVABLE. Candidates :\n' + describeEngine(engine));
              return 'couche introuvable';
            }
            dumpLayer(layer, ids, engine);
            return 'diagnostic affiché ci-dessus';
          },
        };
      } catch {
        // jamais casser le jeu
      }
      apply();
    },
    detach() {
      engine = null;
    },
    setIds(next: string[]) {
      ids = next;
      apply();
    },
    setEnabled(next: boolean) {
      const restore = enabled && !next;
      enabled = next;
      apply(restore ? 1 : undefined);
    },
    destroy() {
      clearInterval(timer);
      apply(1);
      engine = null;
    },
  };
}
