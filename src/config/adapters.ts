/**
 * Tout ce qui dépend du site Pax Historia vit ici — et UNIQUEMENT ici.
 * Le site est une beta active : quand quelque chose casse, mettre à jour ce
 * fichier sans toucher au reste. Chaque valeur provient de l'investigation
 * Phase 0 du 2026-07-14 (voir donnees-investigation-phase0.md, §références).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export const adapters = {
  /** www et beta sont la même app (mêmes chunks, même backend Firebase). */
  hosts: ['www.paxhistoria.co', 'paxhistoria.co', 'beta.paxhistoria.co'],

  /** /game/{uuid}?round=N — l'uuid sert de clé de persistance des structures. */
  gameUrl: /\/game\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
  /**
   * Parties MULTIJOUEUR (beta) : /live/{uuid}. Modèle de données distinct :
   * cache ["liveGame","events",{roundNumber:N}] par round + ["liveGameRoster",uuid].
   */
  liveUrl: /\/live\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,

  engine: {
    /**
     * L'instance du moteur de carte (three.js custom) est dans un useRef d'un
     * composant React au-dessus du canvas de jeu. Le canvas lui-même n'a PAS
     * de fiber ; son parentElement si.
     */
    fiberKeyPrefix: '__reactFiber$',
    maxHopsUp: 8,
    maxHooksPerFiber: 40,

    /**
     * Signature structurelle du moteur. Les noms de constructeurs minifiés
     * (C_, bE…) changent à chaque build : ne JAMAIS s'y fier.
     */
    looksLikeEngine(o: any): boolean {
      return (
        !!o &&
        typeof o === 'object' &&
        typeof o.mercatorToScreen === 'function' &&
        typeof o.on === 'function' &&
        !!o.renderer &&
        !!o.scene &&
        !!o.worldGroup
      );
    },

    /** Noms d'événements de l'émetteur interne du moteur (engine.on/off). */
    events: {
      /** payload: { center: [lng, lat], zoom } — émis à chaque fin de pan/zoom. */
      viewChange: 'view:change',
      clickMap: 'click:map',
      hoverMap: 'hover:map',
      contextLost: 'context:lost',
    },

    /** engine.projection : "mercator" (défaut) ou "globe" (option expérimentale). */
    projections: { flat: 'mercator', globe: 'globe' },

    /**
     * Couche des features de carte : porte les symboles ET les libellés des
     * éléments créés par l'IA. On la trouve STRUCTURELLEMENT, en cherchant
     * parmi les propriétés du moteur un objet exposant l'une de ces méthodes.
     *
     * ⚠️ PREMIER ENDROIT À REGARDER si les symboles et libellés du jeu
     * réapparaissent après une mise à jour du site : c'est le seul savoir
     * nommé (donc fragile) de tout le masquage. Les `*Pattern` servent de
     * filet — ils rattrapent un simple renommage (…Opacity → …Alpha) sans
     * qu'on ait à toucher au code.
     */
    featureLayer: {
      /**
       * Résout la VRAIE couche des features.
       *
       * ⚠️ Ne PAS piloter le moteur directement : il expose des méthodes de
       * façade (`engine.setFeatureLabelOpacity`…) qui délèguent à
       * `engine._featureLayer`. Or ce champ vaut `null` sur la beta — les
       * appels repartent alors sans rien faire ET SANS LEVER D'ERREUR. Le
       * masquage rapportait ainsi « 94/94 features masquées » sans le moindre
       * effet à l'écran (constaté le 2026-07-21, après l'ajout de la rotation
       * de caméra sur beta.paxhistoria.co).
       *
       * Le moteur résout sa couche ainsi :
       *   _externalFeatureLayer() {
       *     if (this._featureLayer) return this._featureLayer;
       *     for (const l of this._registry.layers) if (l.id === 'feature') return l;
       *   }
       *
       * On interroge le REGISTRE EN PREMIER, contrairement au jeu : à
       * l'observation `_featureLayer` pointait sur une instance morte
       * (`_shapeMesh: null`, `_lastViewZoom: -1`) tandis que celle du registre
       * rendait réellement (maillage présent, zoom courant).
       */
      resolveLayer(engine: any): any {
        const registry = engine?._registry;
        const layers = registry?.layers ?? registry?._layers ?? [];
        for (const layer of layers) if (layer?.id === 'feature') return layer;
        return engine?._featureLayer ?? null;
      },

      /** Masque le LIBELLÉ d'une feature : (id, opacity 0..1). */
      labelOpacityMethods: ['setFeatureLabelOpacity'],
      labelOpacityPattern: /^set\w*label\w*(opacity|alpha)$/i,
      /** Masque le SYMBOLE d'une feature : (id, opacity 0..1). Optionnel. */
      symbolOpacityMethods: ['setFeatureOpacity', 'setFeatureSymbolOpacity'],
      symbolOpacityPattern: /^setfeature\w*(opacity|alpha)$/i,
      /** Exploration en largeur des propriétés du moteur. */
      maxDepth: 3,
      maxNodes: 400,
      /**
       * Branches à ne pas parcourir : ce sont les graphes three.js (des
       * milliers de nœuds), la couche n'y est jamais et on y perdrait le
       * budget d'exploration.
       */
      skipKeys: ['scene', 'worldGroup', 'renderer', 'camera', 'controls'],
    },
  },

  state: {
    /**
     * L'état de partie ne transite PAS par Firestore : il vit dans le cache
     * React Query, mis à jour après chaque événement généré.
     */
    reactQueryKey: (gameId: string) => `simpleGames/${gameId}`,

    /** Reconnaître l'objet game lors d'un walk du fiber React. */
    gameSignatureKeys: ['rounds', 'playerCountry', 'presetUID'] as const,

    /** ⚠️ game.rounds est un OBJET indexé par n° de tour ("1", "2"…), pas un array. */
    roundEventsKey: 'eventsBetweenStartDateAndEndDate',
    roundMapFeaturesKey: 'mapFeatures',
    /** event.tags = [{text, color?}] — lieux déjà extraits par le jeu. */
    eventTagsKey: 'tags',
  },

  net: {
    /**
     * Génération IA (événements + chat conseiller). Appelé DANS l'iframe
     * same-origin /simple-secure-iframe.html — d'où all_frames:true dans le
     * manifest ; un hook fetch limité au top frame ne voit jamais cet appel.
     * Corps de requête : { prompt, promptStage, jsonSchema? }.
     */
    simpleChatPath: '/api/simple-chat',
    sandboxIframePath: '/simple-secure-iframe.html',
    /** promptStage du chat conseiller ; absent + jsonSchema présent = génération d'événement. */
    chatStage: 'chatWithUser',
  },

  mercator: {
    /** Monde interne du moteur = Web Mercator en MÈTRES (EPSG:3857). */
    earthRadiusM: 6378137,
    /** Largeur du monde ; la carte wrappe avec des copies fantômes à ±1·largeur. */
    worldWidthM: 2 * Math.PI * 6378137,
  },

  ui: {
    /** Sélecteurs de secours (diagnostic / futur badge) — jamais critiques. */
    headerLogoLink: 'header a[href^="/games"]',
    jumpForwardIcon: 'svg.feather-jump-forward',
    actionsButtonAria: 'Actions',
    /**
     * Menu ⋮ de la partie (coin haut-gauche de la carte, sous la barre de nav).
     * Sert d'ancre pour coller notre bouton panneau à sa droite, quelle que soit
     * la résolution. Icône Feather (comme jumpForwardIcon). Non critique : si
     * absent, le bouton retombe sur une position fixe de secours.
     */
    gameMenuIcon: 'svg.feather-more-vertical',
  },
} as const;

export type Adapters = typeof adapters;
