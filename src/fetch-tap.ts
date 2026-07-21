/**
 * Observation diagnostique de /api/simple-chat (génération d'événements).
 * Lecture seule stricte : la requête et la réponse passent inchangées.
 * Doit tourner dans TOUS les frames : l'appel part de l'iframe same-origin
 * /simple-secure-iframe.html, jamais du top frame.
 */

import { adapters } from './config/adapters';
import { relayToTop, truncate } from './lib/messages';

export function installFetchTap(): void {
  const original = window.fetch;
  const frame: 'top' | 'iframe' = window === window.top ? 'top' : 'iframe';

  window.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const response = await original.call(window, input as RequestInfo, init);
    try {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url && url.includes(adapters.net.simpleChatPath)) {
        const reqBody = init && typeof init.body === 'string' ? init.body : null;
        response
          .clone()
          .text()
          .then((respBody) =>
            relayToTop({
              type: 'net:simple-chat',
              frame,
              reqBody: truncate(reqBody),
              respBody: truncate(respBody),
            }),
          )
          .catch(() => {
            // réponse illisible (stream aborté…) : l'observation s'arrête là
          });
      }
    } catch {
      // l'observation ne doit jamais impacter le jeu
    }
    return response;
  };
}
