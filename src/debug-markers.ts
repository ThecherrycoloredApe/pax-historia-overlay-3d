/**
 * Étape 2 — validation visuelle de l'engine bridge : pastilles DOM posées sur
 * des villes connues, repositionnées via engine.mercatorToScreen.
 * Ce module valide le pipeline lat/lng → mercator → écran qui servira tel quel
 * au canvas three.js (étape 3) ; il restera ensuite disponible comme outil de
 * diagnostic derrière un flag.
 */

import { adapters } from './config/adapters';
import type { PaxEngine } from './engine-bridge';
import { lngLatToMercator, wrapToNearest } from './lib/mercator';
import { log } from './lib/log';

export interface TestPoint {
  name: string;
  lng: number;
  lat: number;
  color?: string;
}

const DEFAULT_COLOR = '#ff3b30';

export function installDebugMarkers(engine: PaxEngine, points: TestPoint[]): () => void {
  const canvas = engine.renderer?.domElement;
  if (!canvas) return () => {};

  const container = document.createElement('div');
  container.dataset.paxOverlay = 'debug-markers';
  Object.assign(container.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    width: '0',
    height: '0',
    pointerEvents: 'none',
    zIndex: '30',
  });
  document.body.appendChild(container);

  const markers = points.map((p) => {
    const el = document.createElement('div');
    Object.assign(el.style, {
      position: 'absolute',
      transform: 'translate(-50%, -50%)',
      width: '10px',
      height: '10px',
      borderRadius: '50%',
      background: p.color ?? DEFAULT_COLOR,
      boxShadow: '0 0 0 2px rgba(255,255,255,0.9)',
    });
    const label = document.createElement('span');
    label.textContent = p.name;
    Object.assign(label.style, {
      position: 'absolute',
      left: '12px',
      top: '-6px',
      font: '11px system-ui, sans-serif',
      color: '#fff',
      textShadow: '0 1px 2px #000',
      whiteSpace: 'nowrap',
    });
    el.appendChild(label);
    container.appendChild(el);
    const merc = lngLatToMercator(p.lng, p.lat);
    return { el, mx: merc.x, my: merc.y };
  });

  // Référence de wrap : x mercator du centre de vue (mis à jour par view:change).
  let centerMx = 0;
  let rafPending = false;

  const reposition = () => {
    rafPending = false;
    const rect = canvas.getBoundingClientRect();
    for (const m of markers) {
      let screen: { x: number; y: number; visible?: boolean };
      try {
        screen = engine.mercatorToScreen(wrapToNearest(m.mx, centerMx), m.my);
      } catch {
        continue; // moteur en cours de destruction : le bridge signalera la perte
      }
      const visible = screen.visible !== false;
      m.el.style.display = visible ? '' : 'none';
      if (visible) {
        m.el.style.left = `${rect.left + screen.x}px`;
        m.el.style.top = `${rect.top + screen.y}px`;
      }
    }
  };

  const schedule = () => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(reposition);
  };

  const onViewChange = (payload: unknown) => {
    const p = payload as { center?: [number, number] } | undefined;
    if (p && Array.isArray(p.center) && typeof p.center[0] === 'number') {
      centerMx = lngLatToMercator(p.center[0], 0).x;
    }
    schedule();
  };

  engine.on(adapters.engine.events.viewChange, onViewChange);
  // Suivi fluide pendant le drag/zoom : view:change peut n'arriver qu'en fin de
  // geste ; pointermove/wheel garantissent un recalage par frame (coalescé rAF).
  canvas.addEventListener('pointermove', schedule, { passive: true });
  canvas.addEventListener('wheel', schedule, { passive: true });
  window.addEventListener('resize', schedule);
  schedule();

  log(`marqueurs de validation posés (${markers.length})`);

  return () => {
    try {
      engine.off?.(adapters.engine.events.viewChange, onViewChange);
    } catch {
      // moteur déjà détruit
    }
    canvas.removeEventListener('pointermove', schedule);
    canvas.removeEventListener('wheel', schedule);
    window.removeEventListener('resize', schedule);
    container.remove();
  };
}
