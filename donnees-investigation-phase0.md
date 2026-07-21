# Données d'investigation Phase 0 — Overlay 3D Pax Historia

> Compilé le 2026-07-14 à partir de deux sessions d'investigation live : une session **invité** (analyse statique des bundles + moteur de carte) et une session **compte complet** (partie réelle « Test Overlay 3D », scénario Modern Day, France, IA « Léger », 1 action + 1 time-jump d'une semaine, coût ~$0.004).
> Ce document est la source de vérité pour remplir `src/config/adapters.ts`. Le site est en beta active : **tout ce qui est marqué 🔧 est susceptible de casser** et doit vivre dans les adapters.

---

## 1. Stack technique du jeu

| Composant | Détail |
|---|---|
| Framework | Next.js App Router + Turbopack, hébergé sur Vercel (`?dpl=dpl_...` sur tous les assets) |
| Rendu carte | **Moteur three.js custom** (WebGL2) — PAS MapLibre/Leaflet/Pixi/OpenLayers |
| Backend données | Firebase — projet `pax-historia-dev` (Firestore + Auth + IndexedDB auth uniquement, pas de persistance Firestore locale) |
| Temps réel | Ably (websockets) présent dans les bundles ; en pratique non observé pendant nos tests solo |
| Mutations | Next.js Server Actions (`$ACTION_ID`, réponses au format RSC flight) + endpoints REST `/api/*` |
| Génération IA | `POST /api/simple-chat` appelé **depuis un Web Worker dans un iframe sandboxé** (voir §5) |
| Analytics | Statsig (`prodregistryv2.org`, `featureassets.org`), Vercel Speed Insights, BetterStack |
| Anti-bot | reCAPTCHA Enterprise (clé `6LdaJvIpAAAAABCZh6QmSrKrO3E7azvpzeBOg14U`) |
| Données carto | © OpenStreetMap contributors (ODbL) — coordonnées réelles lng/lat |

**www.paxhistoria.co et beta.paxhistoria.co = la même app**, seuls les déploiements Vercel diffèrent (`dpl_7za5zsR2...` vs `dpl_JB23W79...`). Même projet Firebase, mêmes chunks, mêmes endpoints. Un seul jeu d'adapters suffit, l'hostname est le seul paramètre.

### Endpoints REST observés 🔧
- `/api/auth/sign-in`, `/api/auth/sign-out`, `/api/auth/refresh-session`, `/api/auth/set-private-fields`, `/api/auth/clear-session-and-redirect` (GET, déconnecte et redirige)
- `/api/playlists?sort=likes|newest&limit=N` (JSON simple)
- `/api/live-games-db/migrate-user-games`, `/api/live-games-db/backfill-legacy` (la « simple games DB »)
- `/api/simple-chat` (génération IA — depuis le worker sandboxé)
- `/api/games/screenshot` (500 pendant nos tests), `/api/update-simple-preset-stats`
- `/api/notifications/push/subscribe|unsubscribe`, `/api/subscription/create-checkout-session`, `/api/tokens/create-checkout-session` (Stripe)
- Firestore WebChannel : `firestore.googleapis.com/google.firestore.v1.Firestore/Listen/channel` et `Write/channel` (VER=8, long-polling fetch ~45 s) — ne porte que `userPrivateFields` / `userPublicProfiles`, **pas l'état de partie**
- Géométrie carte : `https://map-geometry.paxhistoria.co/map-geometry/{authorUID}/{preset}_{hash}_{timestamp}.json`
- Drapeaux : `https://flags.paxhistoria.co/*.avif|png` ; assets presets : `https://preset-assets.paxhistoria.co/`

---

## 2. Le moteur de carte (three.js custom)

### Accès à l'instance 🔧
Le canvas de jeu (plein écran, WebGL2) n'a **pas** de fiber React ; son `parentElement` si. L'instance moteur vit dans un `useRef` d'un hook de ce sous-arbre :

```js
// depuis le main world
const canvas = document.querySelector('canvas');
let f = canvas.parentElement[Object.keys(canvas.parentElement).find(k => k.startsWith('__reactFiber$'))];
let engine = null, hops = 0;
while (f && hops < 8 && !engine) {
  let s = f.memoizedState, si = 0;
  while (s && si < 40) {
    const v = s.memoizedState;
    if (v?.current?.renderer && v.current.scene && typeof v.current.mercatorToScreen === 'function') { engine = v.current; break; }
    s = s.next; si++;
  }
  f = f.return; hops++;
}
```
Signature de reconnaissance : objet avec clés `renderer, scene, orthoCamera, perspectiveCamera, camera, events, worldGroup, _projection, _panZoomHandler, _regionLayer, _borderLayer, _featureLayer, _basemapManager, _globeSphere, _conquestFillLayer, _selectionLayer, _labelLineLayer...` (constructeur minifié `C_` — le nom minifié change à chaque build, **ne pas s'y fier**).

### Projection — validée pixel-perfect ✅
- Monde interne = **Web Mercator en mètres** (EPSG:3857). Conversion standard :
  `mx = R·lng·π/180`, `my = R·ln(tan(π/4 + lat·π/360))`, R = 6378137.
- **`engine.mercatorToScreen(mercX, mercY)` → `{x, y, visible}` en pixels CSS relatifs au canvas.** Ajouter `canvas.getBoundingClientRect().left/top` pour positionner en `position:fixed`.
- Implémentation interne : `"globe"===this._projection ? this._globeCameraController.mercatorToScreen(e,t,r) : {...this.camera.mercatorToScreen(e,t), visible:!0}` — gère donc les deux modes.
- `engine.projection` → `"mercator"` (défaut) ou `"globe"` (option « Globe 3D Expérimental » du menu). `setProjection` pour changer.
- **Test réalisé** : 15 villes projetées + marqueurs DOM → alignement exact sur les symboles de villes du jeu (Marseille, Nice, Monaco, Montpellier), avant ET après pan.

### Synchro caméra ✅
- **`engine.on('view:change', cb)`** — `cb({center: [lng, lat], zoom})`, émis à chaque fin de pan/zoom. C'est LE hook de synchro. Autres événements du même émetteur : `click:map`, `hover:map`, `context:lost`. API : `on/off`, émetteur custom avec `listeners` (Map).
- `engine.orthoCamera` (three.OrthographicCamera) : la vue est encodée dans le **frustum** (`left/right/top/bottom` en mètres mercator), `position` reste à (0,0,100) et `zoom` à 1. Formule alternative : `screenX = (mercX - left)/(right - left) · canvasW`.
- `engine.visualZoom` (~5–8.4 pendant nos tests) = niveau de zoom « carte ».
- Le monde wrappe horizontalement : « ghosts » des meshes décalés de ±40 075 016,686 m (circonférence). L'overlay devra gérer le wrap (prendre le ghost le plus proche du centre de vue).

### API publique utile du moteur
`flyTo({center:[lng,lat], zoom, durationMs})`, `zoomForExtent`, `animate`, `cancelAnimation`, `markDirty` (invalide le rendu — le moteur fait du **rendu on-demand**, pas de boucle 60 fps), `setInteractionEnabled`, `loadRegions`, `setOwnership`, `updateOwnership`, `setRegionAlphas`, `beginRegionCrossfade`, `getRendererInfo`, `isContextLost`, `backendType`.

⚠️ Nuance (2026-07-15, étape 2) : sur un build plus récent du site, `isAnimating` n'existait plus sur l'instance et `flyTo` n'a pas eu d'effet observable — l'API « commande » du moteur bouge d'un build à l'autre. **Aucun impact overlay** : le pipeline de lecture (`mercatorToScreen`, `on('view:change')`, `renderer.domElement`, `projection`) est resté stable et la signature structurelle des adapters a re-matché sans modification. Ne jamais dépendre des méthodes de commande.

⚠️ Environnement de test : dans un navigateur non rendu (pane cachée, rAF gelé), les animations du jeu et tout code basé sur `requestAnimationFrame` ne s'exécutent pas — valider le suivi dynamique dans un vrai Chrome visible.

### Couches three.js (`engine.worldGroup.children`)
`basemap`, `regions`, `borders`, `mapFeatures` (sous-groupes `flags`, `shapes`, `labels` + ghosts), `labelLines`. Les villes sont **instanciées dans un seul Mesh** (atlas de formes + atlas de glyphes pour les labels) — les noms ne sont pas lisibles depuis le moteur, mais `_featureLayer._featureMeta` (Array 792) donne `{id, mercX, mercY, appearZoom, fullZoom, disappearZoom, baseSizeMeters, scaleMode, isFlag, ...}` (zoom d'apparition utile si on veut imiter le comportement d'apparition des modèles).

---

## 3. État de partie & schémas de données

### Où lire l'état 🔧
- **Cache React Query, clé `simpleGames/{gameId}`** — mis à jour après chaque événement par `handleSimpleEventAnimation` (chunk lazy 121586) : `N.setQueryData([`simpleGames/${gameId}`], newGame)`. Source la plus propre.
- **Trouver le QueryClient** (validé 2026-07-15, étape 4) : walk du fiber depuis les racines React (header / enfants de body), chercher `fiber.memoizedProps.client` avec `{getQueryData, getQueryCache, setQueryData}` — trouvé en ~46 fibers. `client.getQueryCache().subscribe(cb)` notifie chaque mise à jour → détection des nouveaux événements sans polling. Autres clés utiles du cache : `["mapGeometry", "r2:map-geometry/…"]` (géométrie des régions), `["privateProfile", uid]`, `["publicProfile", uid]`.
- Ou : walk du fiber React depuis `canvas.parentElement` → objet avec `{rounds, playerCountry, presetUID}`.
- `gameId` = UUID de l'URL `/game/{uuid}?round=N`.
- L'état de partie ne transite PAS par Firestore ; il vient du serveur en RSC/server actions + est modifié localement par le worker de génération.

### Schéma `game`
```
{ title, UID, baseMap, playerCountry: "France", lastRoundCompleted, lastPlayed,
  presetUID, versionID, authorUID, dataVersion,
  mapGeometryDocumentID: "r2:map-geometry/{authorUID}/{preset}_{hash}_{ts}",
  startingTimelineText, regionData, difficulty, prompts, modelPackKey, advisor,
  rulesText, eventConsolidations, consolidationSettings, mapRenderingOptions,
  gameImage, rounds: { "1": Round, ... }, _timestamp }
```
⚠️ `rounds` est un **objet** indexé par numéro de tour, pas un array.

### Schéma `Round`
```
{ completed, authorUID, countryDescriptions, chats, mapFeatures,
  isPublished, actionsByPlayer, startDate, eventsBetweenStartDateAndEndDate, catalysts }
```
- `countryDescriptions[pays]` = `{flag:{imageURL, iconImageURL, compressedImageURL, width, height, icon:{cx,cy,zoom}}, color:"#194D33", regionsOwned:["68","152"], tags, additionalNames}`
- `actionsByPlayer`, `chats`, `catalysts` : les 3 types d'entrées du « Gestionnaire d'événements » (+ consolidations au niveau game).

### Schéma **Événement** (cible du parser)
```json
{
  "date": "2016-01-02",
  "title": "French Government Announces Energy and Naval Expansion",
  "description": "President François Hollande's administration unveils an ambitious dual-project plan. The first initiative involves the construction of a **next-generation EPR nuclear reactor** near Lyon to bolster energy independence in the Auvergne-Rhône-Alpes region. Simultaneously, the Ministry of Defense authorizes the **expansion of the Port of Marseille** into a strategic naval hub...",
  "mapChanges": [],
  "tags": [
    {"text": "Marseille", "color": "rgba(0, 98, 177, 1)"},
    {"text": "Lyon", "color": "rgba(0, 98, 177, 1)"},
    {"text": "Auvergne-Rhône-Alpes"}
  ]
}
```
Observations clés :
- `description` en **anglais** (même avec l'UI en français) et en **markdown** — le gras `**...**` marque souvent les éléments notables (le réacteur, le port). Le parser doit cibler l'anglais d'abord.
- **`tags`** : lieux déjà extraits par le jeu, avec la couleur du pays concerné. Matcher `tags[].text` contre `mapFeatures[].name` = géolocalisation quasi gratuite.
- **`mapChanges: []`** pour une construction d'infrastructure → le jeu n'affiche RIEN sur la carte pour nos structures. C'est le vide que l'overlay comble.
- **Types possibles de `mapChanges`** : `transferRegionOwnership` (avec `transfers[].regionIDs`), `createPolity`, `dissolvePolity`, `updatePolity`, `createMapFeature`, `updateMapFeature`, `removeMapFeature`.

### Schéma RÉEL de mapChanges (miné le 2026-07-15 sur « 2030, The World After Hell », 72 tours, 531 événements dont **385 avec mapChanges**)
Répartition : createMapFeature 232, updateMapFeature 174, transferRegionOwnership 134, updatePolity 30, removeMapFeature 19, dissolvePolity 17, createPolity 4.

```jsonc
// createMapFeature — TOUJOURS placé par région (232/232), jamais par lat/lng :
{ "type": "createMapFeature", "id": "ii3cetwm3o", "col": "rgba(116,2,2,1)", // col = couleur du pays
  "feature": { "name": "Commandement Central Provisoire",
    "location": { "regionID": "1449" },        // ← regionID seul !
    "type": "centroid",                          // placé au centroïde/dans la région
    "tags": ["headquarters"], "displaySymbol": "star", "scale": 1.1,
    "ownerName": "French Socialist Republic", "description": "…",
    "labelPlacement": "above" } }

// removeMapFeature — référence la feature par sa CLÉ dans round.mapFeatures (champ "name") :
{ "type": "removeMapFeature", "name": "ua3tgpc9j5g", "removedFeature": { /* copie complète */ } }

// updateMapFeature — même référence par clé + delta :
{ "type": "updateMapFeature", "name": "lsxcurinxki", "properties": { "tags": [...] },
  "previousFeature": { /* état avant */ } }
```

**Forme stockée** dans `round.mapFeatures` après application : le jeu résout la position en `location.{oLng, oLat, regionID, oPlacement:"random"}` — les features IA ont `oLng/oLat` (position aléatoire DANS la région), les features du preset ont `longitude/latitude`. **Le module geo doit accepter les deux formes.**

**Vocabulaire des tags** (libre, 150+ valeurs observées) : dominé par `battalion` (114) et le militaire (infantry, garrison, raiders…) ; côté infrastructures : `infrastructure` (14), `city` (16), `construction` (7), `industry`, `factory`, `nuclear`, `port`, `energy`, `university`, `hospital`, `power-grid`, `mine`… + tags fantaisistes propres au scénario. Symboles : circle (79), square (32), star (30), rectangle (21), diamond (15), flag, cross, triangle, x…

**Encombrement mesuré** : 1040 features au tour 72 (vs 792 au départ) ; jusqu'à **19 features dans une seule région** (labels qui se chevauchent — vu aussi sur screenshot utilisateur autour de Paris). L'overlay doit gérer : gating par zoom + placement en anneau + pas de labels.

**Cycle de vie construction (confirmé par l'utilisateur, gros joueur)** : l'événement d'annonce n'a PAS de mapChange ; le `createMapFeature` n'arrive qu'à l'ACHÈVEMENT, des mois/années in-game plus tard — et parfois jamais (incompréhensions IA/bugs). → États « en construction » (déclenché par le texte) puis « terminé » (déclenché par createMapFeature correspondant, mots-clés d'achèvement, ou délai in-game écoulé).
- L'UI affiche l'événement dans le panneau « Chronologie » avec ses tags cliquables (fly-to via `onTagFlyTo`).

### Schéma `mapFeature` (géocodage, ~792 entrées par round)
⚠️ Vérifié en live (2026-07-15) : `round.mapFeatures` est un **objet indexé par id de feature** (ex. `"4kpe55ze"`), PAS un array — utiliser `Object.values()`. Chaque valeur :
```json
{
  "name": "Lyon",
  "location": { "longitude": 4.8356, "latitude": 45.7640, "regionID": "211" },
  "type": "coordinate",
  "tags": ["city", "small_city"],
  "displaySymbol": "square",
  "scale": 0.8,
  "labelPlacement": "above",
  "description": "Located in Auvergne-Rhône-Alpes"
}
```
- `tags` : `city` + taille (`small_city`, `medium_city`, ...) ; capitales = symbole étoile.
- C'est LA table de géocodage : nom lisible + lat/lng + regionID. Fallback : petit dictionnaire local uniquement pour les lieux hors liste.

### Géométrie des régions (JSON public)
`https://map-geometry.paxhistoria.co/map-geometry/{authorUID}/{preset}_{hash}_{ts}.json` (URL exacte dans `game.mapGeometryDocumentID`, préfixée `r2:`) :
```
{ name: "2025 World v7.2",
  geometry: { "0": { geometry: "GeoJSON Polygon (string)", centroid: "GeoJSON Point (string)",
                     adjacencies: {...}, type: "Land|Coastal|Ocean|Strait" }, ... 781 régions },
  community: true, tags: [...] }
```
Coordonnées réelles lng/lat (ex. région 0 = Alaska). `engine._regionLayer._regions` (Map, 781) donne en plus `ownerId` (= nom du pays, ex "France") par région → utile pour teinter/filtrer par propriétaire.

---

## 4. Flux d'une partie (UI + données)

1. **Création** : `/presets/modern_day` → « Jouer maintenant » → dialog sélection pays → « Jouer en tant que {pays} » → dialog config : nom, difficulté (Très Facile→Impossible), **qualité IA : Léger $ / Pro $$$ / Max $$$$$ + « Autres modèles (28) »** (tous à fenêtre de contexte 1M) → « Commencer la partie » → redirection `/game/{uuid}?round=1`.
2. **Actions** : bouton ⚡ (aria-label `Actions`, coin bas-gauche) → textarea « Entrez votre action... » → l'envoi déclenche d'abord le **conseiller** (IA, ~$0.001) qui reformule → « Accepter / Refuser / peaufiner » → l'action rejoint « Vos actions soumises ».
3. **Time-jump** : bouton `svg.feather-jump-forward` (haut, à droite de la date) → panneau « Saut temporel » : « Événement majeur suivant » OU durées fixes (1 sem / 1 mois / 3 mois / 6 mois / 1 an / Perso) → « Simulation des événements... » (~15 s en Léger) → nouvel événement dans la Chronologie + date avancée. Coût observé : **~$0.003** (Léger, 1 semaine).
4. **Menu** (☰ haut-gauche) : Paramètres, Tutoriel, **Événements (Ctrl E)** = Gestionnaire d'événements (édition des actions/discussions/catalyseurs par tour), **Triches (Ctrl H)**, **Prompts (Ctrl P)**, **Globe 3D Expérimental** (toggle), Signaler un bug (Ctrl B), Dupliquer la partie.
5. Balance de tokens affichée en haut : `$8.749` etc. Compte invité : peut créer une partie mais **le time-jump exige un vrai compte** (« Full Account Required »).

---

## 5. ⚠️ Interception réseau — ce qui marche et ce qui ne marche pas

Découverte critique pour l'architecture de l'extension :

| Canal | Contenu | Interceptable par patch `fetch`/XHR de la page ? |
|---|---|---|
| Firestore Listen/Write (WebChannel fetch streaming) | profils utilisateur uniquement | ✅ oui, si patch posé **avant** le bootstrap de l'app (le SDK capture sa référence `fetch` au chargement du module). Réponses en flux : lire via `getReader()` incrémental (le canal est *aborté* par le SDK toutes les ~45 s → `clone().text()` échoue) |
| `POST /api/simple-chat` (génération d'événements) | actions envoyées + événements générés | ⚠️ **Oui MAIS pas depuis le top frame** : appelé depuis l'**iframe same-origin `/simple-secure-iframe.html`** (+ `/simple-worker-script.js`). Un hook `window.fetch` du top frame ne le voit pas ; un hook injecté **dans l'iframe** le capture (prouvé par le userscript, voir §9). → injecter en `all_frames`. |
| Server actions Next.js | mutations diverses | ✅ oui (fetch de la page), réponses au format RSC flight (parsing pénible) |
| `/api/live-games-db/*`, `/api/playlists`, etc. | méta | ✅ oui |

**Conclusion architecture** (mise à jour après analyse du prior art §9) — deux voies valables pour détecter les nouveaux événements :
- **Voie 1 — interception fetch de `/api/simple-chat` en `all_frames`** (comme le userscript ArMerMergas) : capte l'événement au moment de sa génération, au format brut. Nécessite d'injecter le hook dans l'iframe `/simple-secure-iframe.html` (content script `all_frames: true` + page-inject). Plus « temps réel ».
- **Voie 2 — lire l'état applicatif** (plus robuste aux changements d'API) :
  - option A (recommandée) : **cache React Query `simpleGames/{gameId}`** (poll léger ou subscribe au QueryClient via fiber),
  - option B : re-walk du fiber → `game.rounds[n].eventsBetweenStartDateAndEndDate`,
  - option C (secours ultime) : MutationObserver sur le panneau Chronologie (DOM).

Recommandation : **Voie 2A comme source principale** (découplée du transport, survit si le worker/iframe change), **Voie 1 en complément/diagnostic**. Dans les deux cas, poser les hooks au `document_start` en main world, et gérer l'iframe si Voie 1.

## 6. Approche overlay validée ✅ (pipeline de bout en bout)

Testé en live sur la partie réelle :
1. Événement généré → lu dans l'état React (`eventsBetweenStartDateAndEndDate`).
2. Lieux extraits : `event.tags[].text` → match sur `round.mapFeatures[].name` → `{longitude, latitude}`.
3. lat/lng → mercator mètres (formule EPSG:3857) → `engine.mercatorToScreen(mx, my)` → pixels canvas.
4. Marqueurs DOM posés à ces pixels : **alignement exact** avec les villes du jeu.
5. Pan/zoom → `engine.on('view:change', reproject)` → **recalage parfait**.

Pour la v1 three.js : canvas WebGL transparent (`position:absolute; pointer-events:none`) au-dessus du canvas du jeu, caméra orthographique recopiant le frustum de `engine.orthoCamera` (ou plus simple : `OrthographicCamera` en espace pixels + positions via `mercatorToScreen`), re-render seulement sur `view:change` / ajout de structure (rendu on-demand comme le jeu). Mode « Globe 3D » : hors scope v1 (détecter `engine.projection === "globe"` et masquer l'overlay proprement).

### Ce qui doit vivre dans `adapters.ts` 🔧
- Heuristique de découverte de l'instance moteur (walk fiber + signature `mercatorToScreen`/`renderer`/`scene`).
- Noms d'événements du moteur (`view:change`, `click:map`, `context:lost`).
- Clé React Query (`simpleGames/{gameId}`) + regex d'extraction du gameId depuis l'URL.
- Chemins dans l'objet game (`rounds`, `mapFeatures`, `eventsBetweenStartDateAndEndDate`, `tags`).
- Sélecteurs UI de secours (panneau Chronologie, bouton `feather-jump-forward`).

## 7. Divers / pièges notés
- reCAPTCHA Enterprise présent : l'extension ne doit rien automatiser côté auth.
- Le layout UI dépend de la taille de fenêtre (positions de boutons non fiables ; utiliser aria-labels/classes SVG : ⚡=`Actions`, 💬=`Discussions`, saut=`svg.feather-jump-forward`).
- `document.title` : « Games - », « Scénarios - », « Modern Day - » selon la page ; en jeu : « Pax Historia ».
- Landing page : globe décoratif = lib **cobe** (uniform `phi`) — ne pas le confondre avec le moteur de jeu ; 2 canvas WebGL2 1280×720 additionnels sur la landing (effets).
- Le jeu tolère mal certains environnements headless pour la *preview map* de sélection de pays (restée « Chargement de la carte... » chez nous) — la carte en jeu, elle, fonctionnait.
- Événements en anglais ; UI localisée FR. Le parser v1 doit être **EN d'abord**, FR en bonus.
- `beta.paxhistoria.co` : sessions distinctes (origine différente) mais même backend/compte Firebase.

## 8. Coûts observés (compte réel)
- Conseiller (reformulation d'action) : ~$0.001
- Time-jump 1 semaine, IA « Léger », 1 action : ~$0.003
- Création de partie, navigation, sélection pays : gratuit

---

## 9. Prior art GitHub (recherche du 2026-07-14)

45 dépôts mentionnent Pax Historia. **Catégorisation** :
- **~40 sont des CLONES / alternatives open-source** (Open-Historia ★39, Phos ★23, Arkniem ★13, OpenHistoria ★6, Local-Pax-Historia, Open-Pax, TerminalEarth, etc.) : ils **reconstruisent** le jeu avec leurs propres cartes (MapLibre+PMTiles, SVG, canvas maison). **Aucune valeur pour notre overlay** du vrai jeu — ils ne touchent pas au moteur three.js de paxhistoria.co. Éventuel intérêt marginal : source de données villes/frontières pour un dictionnaire de secours, mais on a déjà `round.mapFeatures` (792 villes+coords) donc inutile.
- **1 seul dépôt hooke le VRAI jeu = territoire connu réutilisable** ⭐ :

### ⭐ ArMerMergas/PaxHistoriaApikeyHook (★15, JS, actif — v15.1 le 2026-07-11)
Userscript Tampermonkey qui **remplace le backend IA** du jeu par un provider au choix (OpenRouter, OpenAI, Google, Ollama local, Anthropic, etc.). `@run-at document-start`, `@match https://(www.)paxhistoria.co/*`, `@grant GM_*`.

**Ce qu'il nous apprend / confirme (crucial) :**

1. **Réconcilie notre §5.** Le script intercepte `/api/simple-chat` en patchant `unsafeWindow.fetch` — et **ça marche**. Explication : son `@match ...paxhistoria.co/*` (sans `@noframes`) fait que Tampermonkey **injecte aussi dans l'iframe same-origin `/simple-secure-iframe.html`**, là où le fetch a réellement lieu. Notre test à nous avait échoué car on ne hookait QUE le top frame. → **Correction §5 : le hook fetch FONCTIONNE, à condition d'injecter dans TOUS les frames** (`all_frames: true` + `match_about_blank`/frames same-origin). C'est un point d'interception valable et même plus « temps réel » que l'état React.

2. **Protocole exact de `POST /api/simple-chat`** (corps de requête JSON) :
   - `{ prompt, promptStage, jsonSchema }`
   - `promptStage === "chatWithUser"` → **CHAT** (conseiller). Réponse attendue par le jeu : `{ "message": "..." }`.
   - présence de `jsonSchema` (format OpenAI `{name, strict, schema}`) → **ACTION / génération d'événement structuré**. Réponse attendue : le JSON brut conforme au schéma (le jeu déballe un éventuel wrapper à clé unique).
   - Donc le schéma des événements (title/description/mapChanges/tags) est littéralement fourni par le jeu dans `payload.jsonSchema` de la requête — on peut le logger pour connaître TOUS les champs possibles d'un événement, pas seulement ceux vus.

3. **Patterns UI directement réutilisables** pour notre panneau/toggle overlay :
   - Badge dans le header : `document.querySelector('header')` puis insérer après `header a[href^="/games"]` (le logo). Fallback `nav`, puis `document.body`.
   - **Survie aux re-renders React** : `MutationObserver` sur `document.body {childList, subtree}` qui ré-injecte le badge s'il disparaît (+ retries `setTimeout` à 1s/2.5s/5s, `setInterval` 250 ms plafonné). À reprendre tel quel pour maintenir notre canvas/UI accroché malgré les navigations SPA.
   - Persistance réglages : `GM_setValue/GM_getValue` → chez nous `chrome.storage.local`.
   - Dédup des requêtes in-flight par hash du body (utile si on relaie/observe).

**Limite** : ce script *remplace* le backend (read-write, intrusif). Notre overlay reste **read-only** — on n'utilise QUE la technique d'injection/observation, pas le remplacement de réponse. On peut s'en inspirer pour l'architecture (document-start, all_frames, observer anti-rerender) sans copier la logique de proxy IA.

### Décision
On **n'attend rien des clones**. On s'appuie sur les découvertes maison (moteur three.js, `mercatorToScreen`, `view:change`, `mapFeatures`) + les 3 patterns du userscript ci-dessus. Territoire suffisamment connu pour attaquer le build.

## §8 — Multijoueur `/live/{uuid}` (découvert le 18/07/2026, validé en jeu)

**Architecture radicalement différente du solo** — rien à lire dans le cache React Query :

- Les requêtes `["liveGame","events",{roundNumber:N}]` existent mais restent **vides** (`[]`), même à un tour avancé. `["liveGameRoster",uuid]` donne les joueurs (`userId`, `participantId`, `participantLabel`, couleur, drapeau). Aucun objet portant `rounds`/`mapFeatures` nulle part dans le cache ni dans le fiber React.
- Les données de carte arrivent en temps réel (Ably) et vont **directement dans le calque de features du moteur**, sans étape d'état React observable.

**Le calque de features (`featureLayer`)** — trouvé parmi les valeurs du moteur par la présence de `setFeatureLabelOpacity` :
- Méthodes utiles du prototype : `setFeatures`, `setFeatureColor/Position/Scale/Visible/Opacity`, `setFeatureLabelOpacity/Offset`, `hitTestCPU`, `updateForZoom`, `beginBatch/endBatch`, `destroy`.
- Stockage interne PUREMENT géométrique : `_featureMeta`/`_metaById`/`_sortedMeta` = `{id, mercX, mercY, appearZoom, fullZoom, disappearZoom, scaleMode, baseSizeMeters, shapeIndex, labelCharStart/Count, scale, sizeValue, isFlag}` — **ni nom ni tags** (les labels sont cuits en géométrie de glyphes par `_buildLabelChars`). Les drapeaux (`shape:"flag"`) vivent à part : `_flagData`/`_flagById`/`_flagSprites`.

**La solution retenue : tap passif sur `setFeatures`** (`src/page-inject.ts` → `installSetFeaturesTap`) :
- Enveloppe posée sur le **prototype** (survit aux recréations du calque en navigation SPA) ; capture de l'argument puis `original.apply(this, args)` — comportement du jeu inchangé, échec silencieux.
- Format des features passées à `setFeatures` (801 pour le monde entier) : `{id, position:[lng,lat], shape:"square|star|circle|flag|…", color:number, scale, label:"NOM", labelPlacement, scaleMode:"relative|absolute", tags:[…], regionID:"218", offsetToDeclutter}` — le **nom est dans `label`**, les **tags sont présents** (villes = `["city", …]`).
- Normalisation (`injectLiveFeatures` dans `src/game-state.ts`) vers le format solo : tag `city` → `location:{longitude,latitude}` (forme preset = exclue de la couverture, garde le rendu du jeu) ; sinon `location:{oLng,oLat,regionID}` (forme IA = couverte). Un pseudo-état `{rounds:{1:{events:[], mapFeatures}}}` est synthétisé, le reste du pipeline (balayage, masquage, persistance par uuid) est identique au solo.

**Pièges** :
- Le remplissage **initial** du calque ne passe PAS par `setFeatures` (constructeur) → sur une partie jamais capturée, la 1re capture exige un rafraîchissement des données : aller-retour Parties ↔ partie (recrée le calque → son remplissage passe alors par le prototype patché), ou avancement de tour. Les actions mises en file d'attente ne changent PAS la carte tant que le temps n'avance pas.
- Le pont moteur était historiquement verrouillé sur `/game/` (`adapters.gameUrl`) — c'est `gameUrl OU liveUrl` désormais (`src/engine-bridge.ts`).
- Les parties live ont un timer par tour et une pause (`Paused by <pays>`) ; la carte reste rendue pendant la pause.
