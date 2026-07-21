/**
 * Canvas three.js transparent superposé au canvas du jeu.
 *
 * Principe : la scène vit en coordonnées Web Mercator (mètres), comme le
 * moteur du jeu. À chaque mise à jour, on dérive le frustum orthographique
 * depuis engine.mercatorToScreen (l'API de lecture stable) — jamais depuis
 * les internals du moteur. La projection étant affine en mode "mercator",
 * deux points suffisent par axe ; on vérifie la cohérence et on se cache
 * si elle est rompue (mode globe, build inattendu…).
 *
 * Anti-encombrement (mesuré jusqu'à 19 features du jeu par région) :
 *  - gating par zoom : les modèles disparaissent en vue monde/continent ;
 *  - placement en anneau : les structures partageant un même ancrage se
 *    répartissent autour du point au lieu de s'empiler ;
 *  - aucun label (le jeu en affiche déjà trop).
 *
 * Rendu on-demand : un render UNIQUEMENT sur view:change / interaction /
 * resize / changement de structures — coalescé dans un rAF, comme le jeu.
 */

import * as THREE from 'three';
import { adapters } from '../config/adapters';
import type { PaxEngine } from '../engine-bridge';
import { lngLatToMercator, wrapToNearest } from '../lib/mercator';
import { log } from '../lib/log';
import type { PlacedStructure } from '../structures';
import type { StructureType } from '../parser';
import { TYPE_LABEL, STATE_LABEL } from '../lib/labels';
import { makeModel, disposeModel, TYPE_COLORS } from './models';

export interface Overlay {
  setStructures(structures: PlacedStructure[]): void;
  setVisible(visible: boolean): void;
  /** false = pastilles partout, jamais de modèles 3D (option du popup). */
  setModelsEnabled(enabled: boolean): void;
  /** Fait pulser la pastille d'une structure (localisation depuis le panneau). */
  pulse(id: string): void;
  scheduleRender(): void;
  destroy(): void;
}

/**
 * Emprise au sol « réelle » (légèrement symbolique) par type, en mètres :
 * les modèles sont ancrés au monde et grossissent/rétrécissent avec le zoom,
 * comme le terrain. Bornés en pixels pour rester repérables de loin sans
 * avaler l'écran de près.
 */
const WORLD_SIZE_METERS: Record<StructureType, number> = {
  nuclear_plant: 2_400,
  port: 6_000,
  military_base: 3_500,
  airport: 4_800,
  dam: 2_000,
  factory: 1_700,
  hq: 1_300,
  infrastructure: 1_600,
  research: 1_500,
  hospital: 1_300,
  depot: 1_900,
  monument: 900,
  finance: 1_200,
  policy: 1_100,
  unit: 900,
  generic: 1_200,
};
const MAX_SCREEN_PX = 150;
/**
 * En dessous de cette taille écran, le modèle 3D serait illisible : on affiche
 * à la place une pastille-icône cliquable, qui redevient le bâtiment en zoomant.
 */
const ICON_BELOW_WORLD_PX = 10;
/**
 * Taille écran MINIMALE d'un modèle 3D affiché : dès la bascule icône→3D, le
 * bâtiment apparaît lisible (~24 px) puis grandit naturellement avec le zoom
 * (ancrage au monde). Sans ce plancher, les modèles n'étaient visibles qu'en
 * zoom extrême et semblaient « inutiles ».
 */
const MIN_MODEL_SCREEN_PX = 24;
const ICON_SIZE_PX = 26;
/** Un chantier occupe un peu moins que le bâtiment fini. */
const CONSTRUCTION_SCALE = 0.8;
/**
 * Au-delà (vue pays/continent), les MODÈLES 3D sont masqués — calé sur le zoom
 * de jeu réel (~11-12 crans de molette depuis la vue monde). Les ICÔNES, elles,
 * restent visibles à tous les niveaux de dézoom : elles rétrécissent juste un
 * peu en vue lointaine pour limiter l'encombrement.
 */
const HIDE_MODELS_ABOVE_METERS_PER_PX = 3_000;
/** Rétrécissement progressif des pastilles jusqu'à ce plancher en vue monde. */
const ICON_SIZE_MIN_PX = 14;
const ICON_SHRINK_END_MPP = 24_000;
/**
 * Au-delà, le jeu ne « voit » plus ses features (seuil d'apparition) : le clic
 * transmis tomberait dans le vide → notre clic ZOOME sur l'élément à la place.
 */
const CLICK_FLYTO_ABOVE_MPP = 1_500;
const FLYTO_TARGET_ZOOM = 7.2;
/**
 * Inclinaison des modèles (penchés VERS le viewer) : sous la caméra zénithale
 * du jeu on voit alors façade sud + toit — le look isométrique. Un signe
 * négatif montrerait le dessous des bâtiments (bug corrigé).
 */
const MODEL_TILT_X = 0.65;
/** Léger yaw pour révéler une façade latérale (vrai volume à l'éclairage). */
const MODEL_YAW_Y = 0.45;

/**
 * Dérive la transformation affine écran↔mercator via trois sondes.
 * Retourne null si la projection n'est pas affine (mode globe) ou incohérente.
 */
function deriveAffineView(engine: PaxEngine) {
  const PROBE = 200_000;
  const o = engine.mercatorToScreen(0, 0);
  const px = engine.mercatorToScreen(PROBE, 0);
  const py = engine.mercatorToScreen(0, PROBE);
  if (!o || !px || !py) return null;
  const kx = (px.x - o.x) / PROBE;
  const ky = (py.y - o.y) / PROBE;
  if (!isFinite(kx) || !isFinite(ky) || kx === 0 || ky === 0) return null;
  const shearX = Math.abs((py.x - o.x) / PROBE / kx);
  const shearY = Math.abs((px.y - o.y) / PROBE / ky);
  if (shearX > 0.01 || shearY > 0.01) return null;
  return {
    toMercX: (sx: number) => (sx - o.x) / kx,
    toMercY: (sy: number) => (sy - o.y) / ky,
    metersPerPixel: 1 / Math.abs(kx),
  };
}

export function installOverlay(engine: PaxEngine): Overlay | null {
  const gameCanvas = engine.renderer?.domElement;
  if (!gameCanvas) return null;

  const canvas = document.createElement('canvas');
  canvas.dataset.paxOverlay = 'render3d';
  Object.assign(canvas.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    pointerEvents: 'none',
    zIndex: '5',
  });
  document.body.appendChild(canvas);

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 1.15));
  const sun = new THREE.DirectionalLight(0xffffff, 1.5);
  sun.position.set(0.6, 1, 2);
  scene.add(sun);

  // Caméra orthographique en espace mercator, y vers le haut, regard -Z.
  const camera = new THREE.OrthographicCamera(0, 1, 1, 0, -1e8, 1e8);
  camera.position.z = 1e7;

  interface Placed {
    id: string;
    type: StructureType;
    data: PlacedStructure;
    wrapper: THREE.Group;
    shadow: THREE.Mesh;
    icon: HTMLDivElement;
    mx: number;
    my: number;
    isConstruction: boolean;
    /** Taille écran au dernier rendu (hit-test du clic). */
    screenSize: number;
  }
  let placed: Placed[] = [];
  let rafPending = false;
  let lastMetersPerPixel = 0;
  let modelsEnabled = true;
  let destroyed = false;
  let visible = true;

  // Pastilles-icônes (zoom intermédiaire) — DOM pour un rendu net et stylable.
  const iconContainer = document.createElement('div');
  iconContainer.dataset.paxOverlay = 'icons';
  Object.assign(iconContainer.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    width: '0',
    height: '0',
    pointerEvents: 'none',
    zIndex: '6',
  });
  document.body.appendChild(iconContainer);

  const cssColor = (n: number) => `#${n.toString(16).padStart(6, '0')}`;

  const makeIcon = (s: PlacedStructure): HTMLDivElement => {
    const el = document.createElement('div');
    const [emoji] = TYPE_LABEL[s.type] ?? ['🏢'];
    const glyph = s.state === 'destroyed' ? '💥' : s.state === 'under_construction' ? '🚧' : emoji;
    const bg = s.state === 'destroyed' ? '#3a3a3c' : cssColor(TYPE_COLORS[s.type] ?? 0x8e8e93);
    Object.assign(el.style, {
      position: 'absolute',
      width: `${ICON_SIZE_PX}px`,
      height: `${ICON_SIZE_PX}px`,
      borderRadius: '50%',
      display: 'none',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: '14px',
      lineHeight: '1',
      background: `radial-gradient(circle at 32% 28%, ${bg}, ${bg} 55%, rgba(0,0,0,0.35))`,
      border: '2px solid rgba(255,255,255,0.92)',
      boxShadow: '0 1px 5px rgba(0,0,0,0.5)',
      transform: 'translate(-50%, -50%)',
    });
    el.textContent = glyph;
    iconContainer.appendChild(el);
    return el;
  };

  // Fiche au SURVOL d'un bâtiment/icône (remplace les labels du jeu masqués).
  // Le clic n'est pas intercepté : il va au jeu, qui ouvre sa propre fiche.
  const tooltip = document.createElement('div');
  tooltip.dataset.paxOverlay = 'tooltip';
  Object.assign(tooltip.style, {
    position: 'fixed',
    display: 'none',
    zIndex: '40',
    pointerEvents: 'none',
    background: 'rgba(18, 20, 25, 0.92)',
    color: '#e8eaee',
    padding: '7px 10px',
    borderRadius: '8px',
    font: '12px/1.4 system-ui, sans-serif',
    maxWidth: '240px',
    boxShadow: '0 2px 10px rgba(0,0,0,0.4)',
    border: '1px solid rgba(255,255,255,0.12)',
  });
  document.body.appendChild(tooltip);
  const hideTooltip = () => {
    tooltip.style.display = 'none';
  };

  let hoveredId: string | null = null;

  /** Hit-test commun survol/clic sur nos bâtiments/pastilles affichés. */
  const hitTestPlaced = (ev: { clientX: number; clientY: number }): Placed | null => {
    const rect = gameCanvas.getBoundingClientRect();
    const sx = ev.clientX - rect.left;
    const sy = ev.clientY - rect.top;
    const centerMx = (camera.left + camera.right) / 2;
    let best: Placed | null = null;
    let bestDist = Infinity;
    for (const p of placed) {
      if (!p.wrapper.visible && p.icon.style.display === 'none') continue;
      let screen: { x: number; y: number };
      try {
        screen = engine.mercatorToScreen(wrapToNearest(p.mx, centerMx), p.my);
      } catch {
        continue;
      }
      const dist = Math.hypot(screen.x - sx, screen.y - sy);
      if (dist <= p.screenSize / 2 + 8 && dist < bestDist) {
        bestDist = dist;
        best = p;
      }
    }
    return best;
  };

  const onPointerHover = (ev: PointerEvent) => {
    try {
      if (!visible || destroyed) return hideTooltip();
      const best = hitTestPlaced(ev);
      if (!best) {
        hoveredId = null;
        return hideTooltip();
      }
      // Repositionne au fil du survol, ne reconstruit que si la cible change.
      tooltip.style.left = `${ev.clientX + 14}px`;
      tooltip.style.top = `${ev.clientY - 8}px`;
      if (hoveredId === best.id) {
        tooltip.style.display = '';
        return;
      }
      hoveredId = best.id;
      const [emoji, typeLabel] = TYPE_LABEL[best.type] ?? ['🏢', best.type];
      const s = best.data;
      const title = s.source === 'mapChange' ? s.placeName : `${typeLabel} — ${s.placeName}`;
      const dateLine =
        s.state === 'destroyed'
          ? `détruit le ${s.destroyedDate ?? '?'}`
          : s.state === 'built'
            ? `en service depuis ${s.builtDate ?? s.startDate}`
            : `en chantier depuis ${s.startDate}`;
      tooltip.innerHTML = '';
      const strong = document.createElement('div');
      strong.style.fontWeight = '600';
      strong.textContent = `${emoji} ${title}`;
      const meta = document.createElement('div');
      meta.style.color = '#9aa2ab';
      meta.textContent = `${typeLabel} · ${STATE_LABEL[s.state]} · ${dateLine}`;
      const hint = document.createElement('div');
      hint.style.cssText = 'color:#6b7280;font-size:11px;margin-top:2px';
      hint.textContent =
        lastMetersPerPixel > CLICK_FLYTO_ABOVE_MPP
          ? 'clic : zoomer dessus'
          : s.source === 'mapChange'
            ? 'clic : fiche du jeu'
            : '';
      tooltip.append(strong, meta);
      if (hint.textContent) tooltip.append(hint);
      tooltip.style.display = '';
    } catch {
      hideTooltip();
    }
  };
  const onPointerLeave = () => {
    hoveredId = null;
    hideTooltip();
  };
  // En vue éloignée, le clic sur une pastille zoome sur l'élément (le jeu ne
  // gère plus ses features à ce niveau) ; en vue proche, le clic n'est pas
  // intercepté et ouvre la fiche native du jeu.
  const onClick = (ev: MouseEvent) => {
    try {
      if (!visible || destroyed || lastMetersPerPixel <= CLICK_FLYTO_ABOVE_MPP) return;
      const best = hitTestPlaced(ev);
      if (!best) return;
      const target = { center: [best.data.lng, best.data.lat] as [number, number], zoom: FLYTO_TARGET_ZOOM };
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const anyEngine = engine as any;
      if (typeof anyEngine.flyTo !== 'function') return;
      try {
        anyEngine.flyTo(target);
      } catch {
        // signature positionnelle en secours
        anyEngine.flyTo(best.data.lng, best.data.lat, FLYTO_TARGET_ZOOM);
      }
      /* eslint-enable @typescript-eslint/no-explicit-any */
      hideTooltip();
    } catch {
      // jamais casser le jeu
    }
  };
  gameCanvas.addEventListener('pointermove', onPointerHover, { passive: true });
  gameCanvas.addEventListener('pointerleave', onPointerLeave, { passive: true });
  gameCanvas.addEventListener('click', onClick, { passive: true });

  const clearPlaced = () => {
    for (const p of placed) {
      scene.remove(p.wrapper);
      scene.remove(p.shadow);
      disposeModel(p.wrapper);
      p.shadow.geometry.dispose();
      (p.shadow.material as THREE.Material).dispose();
      p.icon.remove();
    }
    placed = [];
  };

  const update = () => {
    rafPending = false;
    if (destroyed) return;
    if (!visible) {
      canvas.style.display = 'none';
      iconContainer.style.display = 'none';
      return;
    }

    const rect = gameCanvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    let view: ReturnType<typeof deriveAffineView> = null;
    try {
      const projection: string = engine.projection;
      if (projection === adapters.engine.projections.flat) view = deriveAffineView(engine);
    } catch {
      view = null;
    }
    // Mode globe ou projection illisible : on se cache plutôt que d'afficher faux.
    if (!view) {
      canvas.style.display = 'none';
      iconContainer.style.display = 'none';
      return;
    }
    canvas.style.display = '';
    iconContainer.style.display = '';

    canvas.style.left = `${rect.left}px`;
    canvas.style.top = `${rect.top}px`;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      renderer.setPixelRatio(dpr);
      renderer.setSize(w, h, true);
    }

    camera.left = view.toMercX(0);
    camera.right = view.toMercX(w);
    camera.top = view.toMercY(0);
    camera.bottom = view.toMercY(h);
    camera.updateProjectionMatrix();

    lastMetersPerPixel = view.metersPerPixel;
    const modelsHidden = view.metersPerPixel > HIDE_MODELS_ABOVE_METERS_PER_PX;
    // Pastilles : pleine taille en zoom proche, rétrécissement PROGRESSIF
    // jusqu'au plancher en vue monde (anti-entassement).
    const farT = Math.min(
      1,
      Math.max(
        0,
        (view.metersPerPixel - HIDE_MODELS_ABOVE_METERS_PER_PX) /
          (ICON_SHRINK_END_MPP - HIDE_MODELS_ABOVE_METERS_PER_PX),
      ),
    );
    const iconPx = Math.round(ICON_SIZE_PX - farT * (ICON_SIZE_PX - ICON_SIZE_MIN_PX));
    const centerMx = (camera.left + camera.right) / 2;
    const spanX = camera.right - camera.left;
    const spanY = camera.top - camera.bottom;

    for (const p of placed) {
      // Taille ancrée au monde ; en dessous du lisible → pastille-icône.
      const worldSize = WORLD_SIZE_METERS[p.type] * (p.isConstruction ? CONSTRUCTION_SCALE : 1);
      const worldPx = worldSize / view.metersPerPixel;
      const show3d = modelsEnabled && !modelsHidden && worldPx >= ICON_BELOW_WORLD_PX;
      const showIcon = !show3d;

      p.wrapper.visible = show3d;
      p.shadow.visible = show3d;
      const x = wrapToNearest(p.mx, centerMx);

      if (show3d) {
        // Bornes écran : jamais illisible (MIN), jamais envahissant (MAX).
        const sizeMeters = Math.min(
          Math.max(worldSize, MIN_MODEL_SCREEN_PX * view.metersPerPixel),
          MAX_SCREEN_PX * view.metersPerPixel,
        );
        p.screenSize = sizeMeters / view.metersPerPixel;
        p.wrapper.position.set(x, p.my, 0);
        p.wrapper.scale.setScalar(sizeMeters);
        p.shadow.position.set(x, p.my, 0);
        p.shadow.scale.setScalar(sizeMeters);
      }

      if (showIcon) {
        const sx = ((x - camera.left) / spanX) * w;
        const sy = ((camera.top - p.my) / spanY) * h;
        p.icon.style.left = `${rect.left + sx}px`;
        p.icon.style.top = `${rect.top + sy}px`;
        p.icon.style.width = `${iconPx}px`;
        p.icon.style.height = `${iconPx}px`;
        p.icon.style.fontSize = `${Math.max(8, Math.round(iconPx * 0.54))}px`;
        p.icon.style.display = 'flex';
        p.screenSize = iconPx;
      } else {
        p.icon.style.display = 'none';
      }
    }

    renderer.render(scene, camera);
  };

  const scheduleRender = () => {
    if (rafPending || destroyed) return;
    rafPending = true;
    requestAnimationFrame(update);
  };

  const onViewChange = () => {
    hideTooltip();
    scheduleRender();
  };
  engine.on(adapters.engine.events.viewChange, onViewChange);
  gameCanvas.addEventListener('pointermove', scheduleRender, { passive: true });
  gameCanvas.addEventListener('wheel', scheduleRender, { passive: true });
  window.addEventListener('resize', scheduleRender);
  scheduleRender();

  log('overlay three.js installé');

  return {
    setStructures(structures: PlacedStructure[]) {
      clearPlaced();
      placed = structures.map((s) => {
        const merc = lngLatToMercator(s.lng, s.lat);

        const wrapper = new THREE.Group();
        wrapper.rotation.x = MODEL_TILT_X;
        const model = makeModel(s.type, s.state, s.id);
        model.rotation.y = MODEL_YAW_Y;
        wrapper.add(model);
        scene.add(wrapper);

        // Ombre plate au sol : ancre visuellement le modèle sur la carte.
        const shadow = new THREE.Mesh(
          new THREE.CircleGeometry(0.55, 20),
          new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22, depthWrite: false }),
        );
        shadow.renderOrder = -1;
        scene.add(shadow);

        return {
          id: s.id,
          type: s.type,
          data: s,
          wrapper,
          shadow,
          icon: makeIcon(s),
          mx: merc.x,
          my: merc.y,
          isConstruction: s.state === 'under_construction',
          screenSize: 0,
        };
      });
      log(`overlay : ${placed.length} structure(s) affichée(s)`);
      scheduleRender();
    },

    setVisible(v: boolean) {
      visible = v;
      if (!v) hideTooltip();
      scheduleRender();
    },

    setModelsEnabled(enabled: boolean) {
      modelsEnabled = enabled;
      scheduleRender();
    },

    pulse(id: string) {
      const p = placed.find((x) => x.id === id);
      if (!p) return;
      try {
        p.icon.animate(
          [
            { boxShadow: '0 0 0 0 rgba(255,255,255,0.95)' },
            { boxShadow: '0 0 0 16px rgba(255,255,255,0)' },
          ],
          { duration: 700, iterations: 5 },
        );
      } catch {
        // Web Animations indisponible : sans importance
      }
    },

    scheduleRender,

    destroy() {
      destroyed = true;
      try {
        engine.off?.(adapters.engine.events.viewChange, onViewChange);
      } catch {
        // moteur déjà détruit
      }
      gameCanvas.removeEventListener('pointermove', scheduleRender);
      gameCanvas.removeEventListener('wheel', scheduleRender);
      gameCanvas.removeEventListener('pointermove', onPointerHover);
      gameCanvas.removeEventListener('pointerleave', onPointerLeave);
      gameCanvas.removeEventListener('click', onClick);
      window.removeEventListener('resize', scheduleRender);
      clearPlaced();
      renderer.dispose();
      canvas.remove();
      iconContainer.remove();
      tooltip.remove();
    },
  };
}
