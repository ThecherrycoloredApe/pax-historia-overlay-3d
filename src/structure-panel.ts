/**
 * Panneau « structures » intégré à la carte : bouton flottant (sous le menu ⋮)
 * qui ouvre la liste EN DIRECT des bâtiments/unités suivis. Pastilles d'états et
 * de types cliquables pour masquer/afficher des catégories sur la carte,
 * recherche, clic sur une ligne = localisation (flyTo + pulsation de la pastille).
 * DOM en surcouche uniquement : jamais le jeu.
 */

import type { PlacedStructure } from './structures';
import type { StructureType } from './parser';
import { TYPE_LABEL, STATE_LABEL } from './lib/labels';
import { adapters } from './config/adapters';

export interface StructurePanel {
  /** Moteur acquis : le bouton devient visible. */
  attach(): void;
  /** Moteur perdu (navigation SPA) : tout cacher. */
  detach(): void;
  /** À appeler quand les structures changent (re-render si ouvert). */
  refresh(): void;
  /** Suit le toggle overlay global du popup. */
  setVisible(visible: boolean): void;
  /** Charge le filtre (états/types masqués) persisté pour la partie courante. */
  setFilter(hiddenStates: string[], hiddenTypes: string[]): void;
  destroy(): void;
}

const STATE_RANK: Record<string, number> = { under_construction: 0, built: 1, destroyed: 2 };
const MAX_ROWS = 400;
const REFRESH_MS = 3_000;

/** États affichés en pastilles cliquables (ordre + emoji + libellé court). */
const STATE_CHIPS: { key: string; emoji: string; label: string }[] = [
  { key: 'under_construction', emoji: '🏗️', label: 'chantier' },
  { key: 'built', emoji: '✅', label: 'construits' },
  { key: 'destroyed', emoji: '💥', label: 'détruits' },
];

export function createStructurePanel(opts: {
  getStructures: () => PlacedStructure[];
  locate: (s: PlacedStructure) => void;
  /** L'utilisateur a masqué/affiché un état ou un type (à persister + appliquer). */
  onFilterChange?: (hiddenStates: string[], hiddenTypes: string[]) => void;
}): StructurePanel {
  let attached = false;
  let enabled = true;
  let open = false;
  let filter = '';
  let refreshTimer: number | null = null;
  let anchorRetries: number[] = [];
  // Filtre par catégorie : ce qui est masqué de la CARTE (et de la liste).
  const hiddenStates = new Set<string>();
  const hiddenTypes = new Set<string>();
  let typesOpen = false;

  const button = document.createElement('button');
  button.dataset.paxOverlay = 'panel-button';
  button.textContent = '🏗️';
  button.title = 'Structures de l’overlay — liste, recherche et localisation';
  Object.assign(button.style, {
    position: 'fixed',
    top: '10px',
    left: '56px',
    zIndex: '39',
    width: '38px',
    height: '38px',
    borderRadius: '10px',
    border: '1px solid rgba(255,255,255,0.14)',
    background: 'rgba(22,24,29,0.93)',
    color: '#e8eaee',
    fontSize: '17px',
    lineHeight: '1',
    cursor: 'pointer',
    display: 'none',
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
  });

  const panel = document.createElement('div');
  panel.dataset.paxOverlay = 'panel';
  Object.assign(panel.style, {
    position: 'fixed',
    top: '56px',
    left: '12px',
    zIndex: '39',
    width: '304px',
    maxHeight: '62vh',
    display: 'none',
    flexDirection: 'column',
    background: 'rgba(22,24,29,0.96)',
    color: '#e8eaee',
    font: '12px/1.45 system-ui, sans-serif',
    borderRadius: '12px',
    border: '1px solid rgba(255,255,255,0.14)',
    boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
    overflow: 'hidden',
  });

  // Barre de filtres : pastilles d'états, bouton « Types » dépliable, indice.
  const filterBar = document.createElement('div');
  Object.assign(filterBar.style, {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    padding: '10px 12px 6px',
  });
  const typesBar = document.createElement('div');
  Object.assign(typesBar.style, {
    display: 'none',
    flexWrap: 'wrap',
    gap: '6px',
    padding: '0 12px 8px',
  });
  const hint = document.createElement('div');
  hint.textContent = 'clic : masquer / afficher sur la carte';
  Object.assign(hint.style, { padding: '0 12px 6px', color: '#6b7280', fontSize: '10px' });

  const isVisible = (s: PlacedStructure) => !hiddenStates.has(s.state) && !hiddenTypes.has(s.type);
  const emitFilter = () => opts.onFilterChange?.([...hiddenStates], [...hiddenTypes]);

  /** Style commun des pastilles cliquables ; l'état masqué est barré + estompé. */
  const styleChip = (el: HTMLElement, hidden: boolean) => {
    Object.assign(el.style, {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '4px',
      padding: '3px 8px',
      borderRadius: '999px',
      fontSize: '11px',
      cursor: 'pointer',
      userSelect: 'none',
      border: '1px solid rgba(255,255,255,0.12)',
      background: hidden ? 'transparent' : '#242833',
      color: hidden ? '#6b7280' : '#e8eaee',
      textDecoration: hidden ? 'line-through' : 'none',
    });
  };

  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = 'Rechercher un élément…';
  Object.assign(search.style, {
    margin: '0 10px 8px',
    padding: '6px 9px',
    background: '#1f2229',
    color: '#e8eaee',
    border: '1px solid rgba(255,255,255,0.10)',
    borderRadius: '8px',
    outline: 'none',
    font: 'inherit',
  });
  search.addEventListener('input', () => {
    filter = search.value.trim().toLowerCase();
    render();
  });
  // Le jeu écoute le clavier globalement : nos frappes ne doivent pas lui parvenir.
  for (const evName of ['keydown', 'keyup', 'keypress'] as const) {
    search.addEventListener(evName, (ev) => ev.stopPropagation());
  }

  const list = document.createElement('div');
  Object.assign(list.style, { overflowY: 'auto', padding: '0 8px 8px', flex: '1' });

  panel.append(filterBar, typesBar, hint, search, list);

  // Ancre le bouton juste SOUS le menu ⋮ de la partie (alignement exact quelle que
  // soit la résolution ; en multi, les joueurs occupent la droite du ⋮). Retombe sur
  // une position fixe si le menu est introuvable.
  const anchor = () => {
    try {
      const icon = document.querySelector(adapters.ui.gameMenuIcon);
      const menu = (icon?.closest('button, a, [role="button"]') ??
        icon?.parentElement) as HTMLElement | null;
      const r = menu?.getBoundingClientRect();
      if (r && r.width && r.height) {
        const top = Math.round(r.bottom + 8); // juste sous le ⋮
        const left = Math.round(r.left + r.width / 2 - 19); // centré sous le ⋮ (19 = demi-largeur bouton)
        button.style.top = `${top}px`;
        button.style.left = `${left}px`;
        panel.style.top = `${top + 46}px`; // 38 (bouton) + 8 (marge)
        panel.style.left = `${left}px`;
        return;
      }
    } catch {
      // jamais casser le jeu
    }
    // Secours : coin haut-gauche, sous l'emplacement présumé du ⋮.
    button.style.top = '118px';
    button.style.left = '16px';
    panel.style.top = '164px';
    panel.style.left = '16px';
  };

  /** Reconstruit les pastilles d'états + la barre de types (dépliable). */
  const renderFilters = (all: PlacedStructure[]) => {
    const stateCount: Record<string, number> = {};
    const typeCount: Record<string, number> = {};
    for (const s of all) {
      stateCount[s.state] = (stateCount[s.state] ?? 0) + 1;
      typeCount[s.type] = (typeCount[s.type] ?? 0) + 1;
    }

    filterBar.innerHTML = '';
    // Agencement fixe : 2 pastilles d'états en haut, la 3ᵉ en bas (+ bouton Types
    // poussé à droite de cette 2ᵉ rangée). Indépendant de la largeur des compteurs.
    const rowTop = document.createElement('div');
    const rowBottom = document.createElement('div');
    for (const row of [rowTop, rowBottom]) {
      Object.assign(row.style, { display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' });
    }
    STATE_CHIPS.forEach((st, i) => {
      const hidden = hiddenStates.has(st.key);
      const chip = document.createElement('span');
      chip.textContent = `${st.emoji} ${stateCount[st.key] ?? 0} ${st.label}`;
      chip.title = hidden ? `Afficher les ${st.label}` : `Masquer les ${st.label}`;
      styleChip(chip, hidden);
      chip.addEventListener('click', () => {
        if (hidden) hiddenStates.delete(st.key);
        else hiddenStates.add(st.key);
        emitFilter();
        render();
      });
      (i < 2 ? rowTop : rowBottom).appendChild(chip);
    });

    const presentTypes = Object.keys(typeCount) as StructureType[];
    if (presentTypes.length) {
      const nHidden = presentTypes.filter((t) => hiddenTypes.has(t)).length;
      const toggle = document.createElement('button');
      toggle.textContent = `${typesOpen ? '▾' : '▸'} Types${nHidden ? ` (${nHidden} masqué${nHidden > 1 ? 's' : ''})` : ''}`;
      Object.assign(toggle.style, {
        marginLeft: 'auto',
        background: 'none',
        border: 'none',
        color: '#9aa2ab',
        cursor: 'pointer',
        fontSize: '11px',
        padding: '2px 4px',
      });
      toggle.addEventListener('click', () => {
        typesOpen = !typesOpen;
        render();
      });
      rowBottom.appendChild(toggle);
    }

    filterBar.append(rowTop, rowBottom);

    typesBar.style.display = typesOpen && presentTypes.length ? 'flex' : 'none';
    typesBar.innerHTML = '';
    if (typesOpen) {
      const sorted = presentTypes.sort((a, b) =>
        (TYPE_LABEL[a]?.[1] ?? a).localeCompare(TYPE_LABEL[b]?.[1] ?? b),
      );
      for (const t of sorted) {
        const [emoji, label] = TYPE_LABEL[t] ?? ['❓', t];
        const hidden = hiddenTypes.has(t);
        const chip = document.createElement('span');
        chip.textContent = `${emoji} ${label} (${typeCount[t]})`;
        chip.title = hidden ? `Afficher : ${label}` : `Masquer : ${label}`;
        styleChip(chip, hidden);
        chip.addEventListener('click', () => {
          if (hidden) hiddenTypes.delete(t);
          else hiddenTypes.add(t);
          emitFilter();
          render();
        });
        typesBar.appendChild(chip);
      }
    }
  };

  const render = () => {
    if (!open) return;
    const all = opts.getStructures();
    renderFilters(all);

    const rows = all
      .filter(isVisible)
      .filter((s) => {
        if (!filter) return true;
        const [, typeLabel] = TYPE_LABEL[s.type] ?? ['', s.type];
        return `${s.placeName} ${typeLabel}`.toLowerCase().includes(filter);
      })
      .sort(
        (a, b) => (STATE_RANK[a.state] ?? 3) - (STATE_RANK[b.state] ?? 3) || a.placeName.localeCompare(b.placeName),
      )
      .slice(0, MAX_ROWS);

    list.innerHTML = '';
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.textContent = filter
        ? 'Aucun élément ne correspond.'
        : all.length
          ? 'Tout est masqué par les filtres.'
          : 'Aucune structure pour l’instant.';
      Object.assign(empty.style, { color: '#9aa2ab', padding: '6px 4px 10px' });
      list.appendChild(empty);
      return;
    }
    for (const s of rows) {
      const [emoji, typeLabel] = TYPE_LABEL[s.type] ?? ['❓', s.type];
      const row = document.createElement('div');
      Object.assign(row.style, {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '6px 6px',
        borderRadius: '8px',
        cursor: 'pointer',
      });
      row.addEventListener('mouseenter', () => (row.style.background = '#242833'));
      row.addEventListener('mouseleave', () => (row.style.background = ''));
      row.addEventListener('click', () => opts.locate(s));

      const icon = document.createElement('span');
      icon.textContent = s.state === 'destroyed' ? '💥' : s.state === 'under_construction' ? '🚧' : emoji;
      Object.assign(icon.style, { fontSize: '15px', width: '20px', textAlign: 'center', flex: 'none' });

      const info = document.createElement('div');
      Object.assign(info.style, { flex: '1', minWidth: '0' });
      const name = document.createElement('div');
      name.textContent = s.source === 'mapChange' ? s.placeName : `${typeLabel} — ${s.placeName}`;
      Object.assign(name.style, {
        fontWeight: '600',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      });
      const meta = document.createElement('div');
      meta.textContent = typeLabel;
      Object.assign(meta.style, { color: '#9aa2ab', fontSize: '11px' });
      info.append(name, meta);

      const state = document.createElement('span');
      state.textContent = STATE_LABEL[s.state] ?? s.state;
      const stateColors: Record<string, [string, string]> = {
        under_construction: ['#4a3d12', '#f5c443'],
        built: ['#143d22', '#4cd964'],
        destroyed: ['#46201d', '#ff6b5e'],
      };
      const [bg, fg] = stateColors[s.state] ?? ['#2a2d34', '#9aa2ab'];
      Object.assign(state.style, {
        flex: 'none',
        fontSize: '10px',
        padding: '2px 7px',
        borderRadius: '10px',
        background: bg,
        color: fg,
      });

      row.append(icon, info, state);
      list.appendChild(row);
    }
  };

  const stopTimer = () => {
    if (refreshTimer !== null) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  };

  const setOpen = (v: boolean) => {
    open = v;
    if (v) anchor();
    panel.style.display = v ? 'flex' : 'none';
    button.style.background = v ? 'rgba(52,58,72,0.95)' : 'rgba(22,24,29,0.93)';
    stopTimer();
    if (v) {
      render();
      // La liste vit : re-render périodique tant que le panneau est ouvert.
      refreshTimer = window.setInterval(render, REFRESH_MS);
    }
  };
  button.addEventListener('click', () => setOpen(!open));

  const sync = () => {
    const show = attached && enabled;
    button.style.display = show ? 'flex' : 'none';
    if (!show && open) setOpen(false);
  };

  // page-inject démarre à document_start : <body> n'existe pas encore ici.
  // On monte dès que possible, au plus tard à attach() (moteur acquis ⇒ DOM prêt).
  let mounted = false;
  const mount = () => {
    if (mounted || !document.body) return;
    document.body.append(button, panel);
    window.addEventListener('resize', anchor, { passive: true });
    mounted = true;
    anchor();
  };
  mount();

  return {
    attach() {
      attached = true;
      mount();
      // Le menu ⋮ peut se rendre après l'acquisition du moteur : on re-ancre.
      anchor();
      anchorRetries.forEach((t) => clearTimeout(t));
      anchorRetries = [300, 1200].map((d) => window.setTimeout(anchor, d));
      sync();
    },
    detach() {
      attached = false;
      sync();
    },
    refresh() {
      if (open) render();
    },
    setVisible(v: boolean) {
      enabled = v;
      sync();
    },
    setFilter(states, types) {
      hiddenStates.clear();
      for (const s of states) hiddenStates.add(s);
      hiddenTypes.clear();
      for (const t of types) hiddenTypes.add(t);
      if (open) render();
    },
    destroy() {
      stopTimer();
      anchorRetries.forEach((t) => clearTimeout(t));
      window.removeEventListener('resize', anchor);
      button.remove();
      panel.remove();
    },
  };
}
