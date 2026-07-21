/**
 * Acquisition et suivi du moteur de carte du jeu (three.js custom).
 * Stratégie validée en Phase 0 : le moteur vit dans un useRef d'un composant
 * React au-dessus du canvas ; on le reconnaît par sa forme, jamais par des
 * noms minifiés.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { adapters } from './config/adapters';

export interface EngineView {
  center: [number, number];
  zoom: number;
}

/** Sous-ensemble structurel du moteur que l'overlay consomme. */
export interface PaxEngine {
  renderer: { domElement?: HTMLCanvasElement };
  scene: unknown;
  worldGroup: unknown;
  projection: string;
  visualZoom?: number;
  mercatorToScreen(mx: number, my: number): { x: number; y: number; visible?: boolean };
  on(event: string, cb: (payload: unknown) => void): void;
  off?(event: string, cb: (payload: unknown) => void): void;
}

export interface BridgeCallbacks {
  onAcquired(engine: PaxEngine): void;
  onViewChange(view: EngineView): void;
  onLost(): void;
}

function fiberOf(el: Element): any {
  const key = Object.keys(el).find((k) => k.startsWith(adapters.engine.fiberKeyPrefix));
  return key ? (el as any)[key] : null;
}

/** Cherche l'instance moteur en remontant les hooks des fibers au-dessus de chaque canvas. */
export function findEngine(): PaxEngine | null {
  for (const canvas of Array.from(document.querySelectorAll('canvas'))) {
    const parent = canvas.parentElement;
    if (!parent) continue;
    let fiber = fiberOf(parent);
    for (let hop = 0; fiber && hop < adapters.engine.maxHopsUp; hop++, fiber = fiber.return) {
      let state = fiber.memoizedState;
      for (let i = 0; state && i < adapters.engine.maxHooksPerFiber; i++, state = state.next) {
        const value = state.memoizedState;
        if (adapters.engine.looksLikeEngine(value)) return value as PaxEngine;
        const current = value && typeof value === 'object' ? (value as any).current : null;
        if (adapters.engine.looksLikeEngine(current)) return current as PaxEngine;
      }
    }
  }
  return null;
}

let activeEngine: PaxEngine | null = null;

/** Accès pour les autres modules (render3d à l'étape 3). */
export function getEngine(): PaxEngine | null {
  return activeEngine;
}

const POLL_MS = 1500;

export function startEngineBridge(cb: BridgeCallbacks): void {
  let viewHandler: ((payload: unknown) => void) | null = null;

  const tryAcquire = () => {
    if (activeEngine) return;
    // Solo (/game/…) ET multijoueur (/live/…) : même moteur de carte.
    if (!adapters.gameUrl.test(location.pathname) && !adapters.liveUrl.test(location.pathname)) return;
    const found = findEngine();
    if (!found) return;

    viewHandler = (payload) => {
      const p = payload as { center?: unknown; zoom?: unknown } | undefined;
      if (p && Array.isArray(p.center) && p.center.length === 2 && typeof p.zoom === 'number') {
        cb.onViewChange({ center: p.center as [number, number], zoom: p.zoom });
      }
    };
    found.on(adapters.engine.events.viewChange, viewHandler);
    activeEngine = found;
    cb.onAcquired(found);
  };

  const checkAlive = () => {
    if (!activeEngine) return;
    // Le canvas du renderer sort du DOM quand le jeu démonte la carte (navigation SPA).
    const canvas = activeEngine.renderer?.domElement;
    if (canvas?.isConnected) return;
    if (viewHandler && activeEngine.off) {
      try {
        activeEngine.off(adapters.engine.events.viewChange, viewHandler);
      } catch {
        // le moteur est déjà détruit : rien à détacher
      }
    }
    activeEngine = null;
    viewHandler = null;
    cb.onLost();
  };

  setInterval(() => {
    try {
      checkAlive();
      tryAcquire();
    } catch {
      // ne jamais casser le jeu : on retentera au tick suivant
    }
  }, POLL_MS);

  try {
    tryAcquire();
  } catch {
    // idem : le poll prendra le relais
  }
}
