/**
 * Protocole postMessage entre le main world (page-inject, tous frames) et le
 * content script isolé du top frame. Même origine partout : l'iframe
 * simple-secure-iframe.html est same-origin, donc window.top est accessible.
 */

export const CHANNEL = 'pax-overlay-3d' as const;

export type BridgeMessage =
  | { type: 'engine:acquired'; projection: string; visualZoom: number | null }
  | { type: 'engine:lost' }
  | { type: 'view:change'; center: [number, number]; zoom: number }
  | { type: 'net:simple-chat'; frame: 'top' | 'iframe'; reqBody: string | null; respBody: string | null }
  | { type: 'events:new'; gameId: string; initial: boolean; count: number; titles: string[] }
  // persistance : MAIN → content (save/request), content → MAIN (restore)
  | { type: 'structures:save'; gameId: string; structures: unknown[] }
  | { type: 'structures:request'; gameId: string }
  | { type: 'structures:restore'; gameId: string; structures: unknown[]; tombstones: string[]; enabled: boolean; hideLabels: boolean; models3d: boolean; hiddenStates: string[]; hiddenTypes: string[] }
  // popup → content (chrome.storage.onChanged) → MAIN
  | { type: 'structures:tombstones'; gameId: string; ids: string[] }
  | { type: 'overlay:enabled'; enabled: boolean }
  | { type: 'labels:hide'; hide: boolean }
  | { type: 'models:enabled'; enabled: boolean }
  // panneau (main) → content : sauvegarde du filtre par catégorie, par partie
  | { type: 'filter:save'; gameId: string; states: string[]; types: string[] };

interface Envelope {
  channel: typeof CHANNEL;
  msg: BridgeMessage;
}

const MAX_RELAY_LEN = 20_000;

export function truncate(text: string | null | undefined): string | null {
  if (text == null) return null;
  return text.length > MAX_RELAY_LEN ? text.slice(0, MAX_RELAY_LEN) + '…[tronqué]' : text;
}

export function relayToTop(msg: BridgeMessage): void {
  try {
    window.top?.postMessage({ channel: CHANNEL, msg } satisfies Envelope, location.origin);
  } catch {
    // frame détaché ou origine inattendue : on abandonne sans bruit
  }
}

export function onBridgeMessage(handler: (msg: BridgeMessage) => void): void {
  window.addEventListener('message', (ev: MessageEvent) => {
    if (ev.origin !== location.origin) return;
    const data = ev.data as Partial<Envelope> | undefined;
    if (!data || data.channel !== CHANNEL || !data.msg) return;
    try {
      handler(data.msg);
    } catch {
      // un bug de l'overlay ne doit jamais remonter dans la page
    }
  });
}
