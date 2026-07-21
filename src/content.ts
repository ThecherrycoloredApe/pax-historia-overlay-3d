/**
 * Content script (monde isolé, tous frames).
 * Rôles : logs de diagnostic + pont chrome.storage.local (persistance des
 * structures, suppressions manuelles et réglages venant du popup — le main
 * world n'a pas accès à chrome.*).
 */

import { adapters } from './config/adapters';
import { onBridgeMessage, relayToTop } from './lib/messages';
import { log } from './lib/log';

const structuresKey = (gameId: string) => `structures:${gameId}`;
const tombstonesKey = (gameId: string) => `tombstones:${gameId}`;
const filterKey = (gameId: string) => `filter:${gameId}`;

function currentGameId(): string | null {
  const m = location.pathname.match(adapters.gameUrl);
  return m ? (m[1] ?? null) : null;
}

if (window === window.top) {
  log('content script chargé');

  onBridgeMessage((msg) => {
    switch (msg.type) {
      case 'engine:acquired':
        log('✅ moteur de carte acquis', {
          projection: msg.projection,
          visualZoom: msg.visualZoom,
        });
        break;
      case 'engine:lost':
        log('⚠️ moteur perdu (navigation SPA ?) — ré-acquisition automatique en cours');
        break;
      case 'net:simple-chat':
        log('📡 /api/simple-chat capté depuis', msg.frame, {
          request: msg.reqBody?.slice(0, 300),
          response: msg.respBody?.slice(0, 300),
        });
        break;
      case 'events:new':
        log(
          msg.initial ? '📜 événements historiques lus' : '🆕 nouveaux événements',
          `(${msg.count})`,
          msg.titles,
        );
        break;
      case 'structures:save':
        try {
          chrome.storage.local.set({ [structuresKey(msg.gameId)]: msg.structures }).catch(() => {});
        } catch {
          // contexte d'extension invalidé (rechargement de l'extension) : tant pis
        }
        break;
      case 'structures:request':
        try {
          chrome.storage.local
            .get([
              structuresKey(msg.gameId),
              tombstonesKey(msg.gameId),
              filterKey(msg.gameId),
              'overlayEnabled',
              'hideGameLabels',
              'models3d',
            ])
            .then((data) => {
              const structures = data?.[structuresKey(msg.gameId)];
              const tombstones = data?.[tombstonesKey(msg.gameId)];
              const flt = data?.[filterKey(msg.gameId)];
              relayToTop({
                type: 'structures:restore',
                gameId: msg.gameId,
                structures: Array.isArray(structures) ? structures : [],
                tombstones: Array.isArray(tombstones) ? tombstones : [],
                enabled: data?.overlayEnabled !== false,
                hideLabels: data?.hideGameLabels !== false,
                models3d: data?.models3d !== false,
                hiddenStates: Array.isArray(flt?.states) ? flt.states : [],
                hiddenTypes: Array.isArray(flt?.types) ? flt.types : [],
              });
            })
            .catch(() => {});
        } catch {
          // idem : jamais bloquer la page
        }
        break;
      case 'filter:save':
        try {
          chrome.storage.local
            .set({ [filterKey(msg.gameId)]: { states: msg.states, types: msg.types } })
            .catch(() => {});
        } catch {
          // contexte d'extension invalidé : tant pis
        }
        break;
    }
  });

  // Changements faits depuis le popup → relais vers le main world.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if ('overlayEnabled' in changes) {
        relayToTop({ type: 'overlay:enabled', enabled: changes['overlayEnabled']?.newValue !== false });
      }
      if ('hideGameLabels' in changes) {
        relayToTop({ type: 'labels:hide', hide: changes['hideGameLabels']?.newValue !== false });
      }
      if ('models3d' in changes) {
        relayToTop({ type: 'models:enabled', enabled: changes['models3d']?.newValue !== false });
      }
      const gameId = currentGameId();
      if (gameId && tombstonesKey(gameId) in changes) {
        const ids = changes[tombstonesKey(gameId)]?.newValue;
        relayToTop({ type: 'structures:tombstones', gameId, ids: Array.isArray(ids) ? ids : [] });
      }
    });
  } catch {
    // API storage indisponible : le popup ne pilotera pas cette page, sans plus
  }
}
