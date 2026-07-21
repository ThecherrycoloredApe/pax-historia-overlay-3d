# Pax Historia — Overlay 3D

Extension Chrome (Manifest V3) qui superpose des modèles 3D low-poly (centrales, ports, bases…) sur la carte de [Pax Historia](https://www.paxhistoria.co), en détectant les constructions dans les événements générés par le jeu. **Purement visuelle et locale** : lecture seule, aucune donnée envoyée, aucune modification du jeu.

Documents de référence :
- `brief-projet-overlay-3d-pax-historia-v2.md` — brief et plan de travail courant
- `donnees-investigation-phase0.md` — toutes les données techniques (schémas, API du moteur de carte, pièges)

## À propos

J'ai fait ça avec [Claude Code](https://claude.com/claude-code) : c'est lui qui a écrit tout le code, et qui l'a publié sur cette page, moi j'ai surtout fait ce petit à propos, dit ce que je voulais, testé en jeu et signalé quand ça n'allait pas — genre quand les usines ressemblaient à des granges ou que les icônes ne marchaient pas sur les parties multijoueurs.

Je le partage parce que je trouve que ça rend vraiment bien. Et surtout parce que sur une partie un peu avancée, la carte devient vite illisible : les symboles et les noms des « éléments de carte » se superposent, j'en ai eu une vingtaine empilés dans une seule région. Avec les pastilles, on voit enfin ce qu'il y a et où. Si ça peut servir à d'autres, tant mieux et si des personnes l'utilisent, n'hésitez pas à faire des recommandations.

Projet non officiel, aucun lien avec Pax Historia.

## Installation (mode développeur)

```bash
npm install
npm run build        # ou : npm run watch
```

1. Ouvrir `chrome://extensions`
2. Activer « Mode développeur » (coin haut-droit)
3. « Charger l'extension non empaquetée » → sélectionner le dossier **`dist/`**
4. Ouvrir une partie sur paxhistoria.co, puis DevTools (F12) → Console, filtrer sur `[PaxOverlay]`

Logs attendus :
- `content script chargé…` dès le chargement de la page
- `✅ moteur de carte acquis {projection: "mercator", …}` une fois en jeu
- `🗺️ view:change …` à chaque pan/zoom de la carte
- `📡 /api/simple-chat capté depuis iframe …` pendant une génération (conseiller ou time-jump)

Validation visuelle (étape 3) : en jeu, deux placeholders 3D (cube vert = centrale à Lyon, cube bleu = port à Marseille) posés sur la carte, qui suivent le pan/zoom sans glisser et grossissent/rétrécissent avec la vue.

Diagnostic : les pastilles de l'étape 2 (Paris, Lyon…) restent disponibles — dans la console du jeu : `localStorage.paxOverlayDebug = '1'` puis F5 (et `localStorage.removeItem('paxOverlayDebug')` pour les retirer). Précision mesurée : 0,5–2,2 px vs les placements internes du jeu ; dérivation du frustum : 0,000 px d'erreur.

Après un `npm run build`, recharger l'extension (bouton ↻ dans `chrome://extensions`) puis recharger l'onglet du jeu.

## Structure

```
manifest.json          MV3 — all_frames + document_start, monde MAIN et ISOLATED
src/
  content.ts           monde isolé : logs, (bientôt) overlay + chrome.storage
  page-inject.ts       monde MAIN : engine bridge (top frame) + fetch tap (tous frames)
  engine-bridge.ts     acquisition du moteur de carte via fiber React, view:change
  fetch-tap.ts         observation diagnostique de /api/simple-chat (lecture seule)
  config/adapters.ts   ⚠️ TOUT ce qui dépend du site (fragile) vit ici
  lib/                 mercator (EPSG:3857), protocole postMessage, logs
  parser/              détection de structures dans le texte des événements (EN d'abord)
  geo/                 jointure tags d'événement ↔ mapFeatures (lat/lng)
  render3d/            (étape 3) canvas three.js transparent synchronisé
```

## Quand le site change (beta active) — checklist de re-vérification

Tout ce qui peut casser est centralisé dans `src/config/adapters.ts`. Pour re-vérifier après une mise à jour du site, dans la console DevTools d'une partie :

1. **Le moteur est-il toujours accessible ?** Coller le walk fiber de `donnees-investigation-phase0.md` §2. S'il ne trouve rien : inspecter `document.querySelector('canvas').parentElement`, chercher la clé `__reactFiber$…`, remonter les `memoizedState` et repérer l'objet ressemblant au moteur (fonctions `mercatorToScreen`, `flyTo`, propriétés `renderer`, `scene`, `worldGroup`). Ajuster `adapters.engine.looksLikeEngine` / `maxHopsUp`.
2. **`view:change` émet-il toujours `{center, zoom}` ?** `engine.on('view:change', console.log)` puis panner. Sinon, lister les noms d'événements : `engine.events.listeners` (Map) après interactions.
3. **Le schéma de l'état a-t-il bougé ?** Vérifier `game.rounds[n].eventsBetweenStartDateAndEndDate` et `.mapFeatures` (voir doc §3). Ajuster `adapters.state.*`.
4. **L'appel de génération part-il toujours de l'iframe ?** DevTools → Réseau, filtrer `simple-chat` pendant un time-jump ; vérifier l'initiateur. Ajuster `adapters.net.*`.
5. **Le tap multijoueur capture-t-il toujours ?** Sur une partie `/live/`, après un aller-retour Parties ↔ partie, la console doit montrer `🪝 tap setFeatures posé` puis `🪝 features live capturées : N`. Sinon : vérifier que le calque expose toujours `setFeatureLabelOpacity` (détection) et `setFeatures` sur son prototype (`Object.getOwnPropertyNames(Object.getPrototypeOf(layer))`), et que le format des features contient toujours `label` + `position:[lng,lat]` + `tags` (voir la ligne `🪝 setFeatures appelé — … 1er élément`).
6. **Le masquage agit-il vraiment ?** La ligne `🔇 … masqués : N/M feature(s) **sur la couche « feature »**` doit mentionner la COUCHE. Si elle dit `sur le moteur (façade)`, le masquage ne fait rien même en annonçant 100 % de succès (voir le piège ci-dessous). Diagnostic complet à la demande : `__paxOverlay.diag()` dans la console.

### ⚠️ Le piège du masquage : des succès sans effet

Symptôme : symboles et libellés du jeu réapparaissent, alors que la console annonce `94/94 feature(s) masquées` et que tout le reste (icônes, modèles 3D, panneau) fonctionne.

Cause, constatée le 2026-07-21 sur `beta.paxhistoria.co` après l'ajout de la rotation de caméra : le moteur expose des méthodes de **façade** (`engine.setFeatureLabelOpacity`…) qui délèguent à `engine._featureLayer`. Ce champ est passé à `null` — les appels **repartent sans rien faire et sans lever d'erreur**. Un compteur de succès ne prouve donc que l'absence d'exception, jamais l'effet visuel.

Correction : piloter la vraie couche, résolue par `adapters.engine.featureLayer.resolveLayer()` (registre → couche d'`id === 'feature'`). La façade porte exactement les mêmes noms de méthodes, d'où la confusion : une recherche par nom s'arrête sur le moteur et croit avoir trouvé.

Leçon générale : pour toute API interne du jeu, **vérifier l'effet, pas le retour**. Ici `_shapeMesh: null` et `_lastViewZoom: -1` distinguaient l'instance morte de la couche vivante.

## Étapes de développement

- [x] **Étape 1** — squelette MV3, injection MAIN/ISOLATED tous frames, adapters pré-remplis, logs de validation
- [x] **Étape 2** — engine bridge validé : marqueurs DOM posés à 0,5–2,2 px des villes du jeu (`src/debug-markers.ts`, désormais derrière `localStorage.paxOverlayDebug='1'`)
- [x] **Étape 3** — canvas three.js transparent (`src/render3d/overlay.ts`) : scène en mètres mercator, caméra ortho dérivée de `mercatorToScreen` (3 sondes affines, 0 px d'erreur mesurée), rendu on-demand rAF-coalescé, 2 placeholders de démo (Lyon/Marseille)
  - **Projection non affine** (caméra inclinée/tournée — le jeu a une caméra libre depuis juillet 2026 — ou mode globe) : la dérivation affine échoue, donc les **modèles 3D sont masqués** (notre caméra est orthographique et ne saurait pas reproduire une perspective). Les **pastilles restent affichées** : elles sont placées par `engine.mercatorToScreen`, qui projette correctement dans tous les modes, et sont écartées si elles tombent hors cadre (derrière la caméra, sous l'horizon). Ce n'est **pas un bug** — avant, tout l'overlay disparaissait au moindre mouvement de caméra, alors que le désencombrement est justement ce qui sert le plus. Pour que les modèles survivent à l'inclinaison il faudrait reproduire la caméra du jeu (`engine.camera` expose `pitch`/`bearing`) : non fait
- [x] **Étape 4** — lecture des événements (`src/game-state.ts`) : QueryClient trouvé via fiber (~46 nœuds), abonnement au cache React Query (détection sans polling, fallback poll 5 s + walk fiber), diff des événements par (tour, date, titre), extraction des mapFeatures (objet indexé par id → 792 features validées en live)
- [x] **Étape 5** — parser EN + géocodage (`src/structures.ts`) : mots-clés → tag résolu le plus proche du mot-clé dans le texte → lat/lng des mapFeatures ; `mapChanges` non vides loggés intégralement (capture de schéma — types connus : transferRegionOwnership, create/dissolve/updatePolity, create/update/removeMapFeature) ; validé sur partie réelle (nuclear_plant@Lyon + port@Marseille, 0 faux positif sur 6 événements)
- [x] **Étape 6** — cycle de vie + modèles + persistance :
  - états 🏗️ « en construction » (annonce texte) → ✅ « construit », promotion par `createMapFeature` compatible (famille de tags + ≤200 km, hors `battalion`), mots-clés d'achèvement au même endroit, ou délai in-game (18 mois) — filet anti-oubli de l'IA
  - modèles low-poly procéduraux (`src/render3d/models.ts`) : chantier grue+échafaudage (fanion coloré = type futur), centrale (tours de refroidissement + dôme), port (portiques + conteneurs), base militaire, aéroport, barrage-voûte, usine
  - anti-encombrement : placement en anneau des structures partageant un ancrage, aucun label ; les modèles 3D sont masqués au-delà de 3 km/px, mais les ICÔNES restent visibles à tous les niveaux de dézoom (taille réduite 26→20 px en vue lointaine)
  - persistance `chrome.storage.local` clé `structures:{gameId}` (pont content script), fusion au chargement (l'état le plus avancé gagne) — protège aussi contre la consolidation d'événements anciens
  - pièges regex corrigés sur données réelles : « barrage » nu (tir de barrage EN) et « port of » hors groupe \b (« support of »)
- [x] **Étape 7** — bâtiments génériques, destruction, popup :
  - 6 types génériques alimentés par les `createMapFeature` du jeu (hq, infrastructure, research, hospital, depot, monument) — classés par famille de tags, unités mobiles exclues (`UNIT_PATTERN`), posés à la position exacte de la feature, retirés à sa suppression
  - placement « posé sur la carte » : décalage géographique déterministe 8-18 km autour de la ville (stable entre sessions, anti-chevauchement 4 km, migration auto des sauvegardes v1)
  - tailles ancrées au monde (`WORLD_SIZE_METERS`, bornées 12-150 px) — les modèles grossissent avec le zoom comme le terrain
  - destruction → **ruines** (sol calciné, murs brisés, fumée) : par `removeMapFeature`, par mots-clés (« destroyed », « bombed », « détruite »… — « destroyer » le navire exclu), états persistés (under_construction < built < destroyed)
  - **popup** (icône extension) : trois réglages — overlay on/off, masquage des symboles du jeu, « Bâtiments 3D en zoom rapproché » (décoché = icônes à tous les zooms)
  - **panneau intégré à la carte** (`src/structure-panel.ts`, bouton 🏗️ ancré sous le menu ⋮ de la partie, `adapters.ui.gameMenuIcon`) : liste EN DIRECT des structures, recherche par nom/type, **clic sur une ligne = localisation** (`engine.flyTo` + pulsation de la pastille) — comble la recherche du jeu qui ignore les éléments de carte. **Filtres par catégorie** : pastilles d'états (chantier/construit/détruit) + section « Types » dépliable, cliquables pour masquer/afficher des catégories sur la carte ET dans la liste ; une catégorie masquée récupère le symbole d'origine du jeu (masquage recalculé). Filtre **mémorisé par partie** (`filter:{gameId}` dans `chrome.storage`). La suppression manuelle a été retirée de l'UI (mécanisme tombstones dormant dans le code)
- [x] **Étape 9** — icônes + assets 3D :
  - **mode icône** au zoom intermédiaire : pastille colorée (couleur + emoji du type, 🚧 chantier, 💥 ruines), cliquable, qui cède la place au modèle 3D quand il devient lisible (≥ 30 px)
  - **modèles GLB embarqués** (`src/render3d/assets/`), tous **CC0**, deux origines déclarées dans `asset-models.ts`, réparties par NATURE et non par préférence :
    - **Quaternius** ([quaternius.com](https://quaternius.com)) — *Ultimate Buildings Pack*, tous les bâtiments **urbains** : génériques, QG, recherche, finance, administratif. Couleurs portées par les matériaux donc **aucune texture externe** (loader nu)
    - **Kenney** ([kenney.nl](https://kenney.nl)) — tout ce qui est **industriel, portuaire ou commémoratif** : usines à cheminées, cuves, hangars, tours de refroidissement, porte-conteneurs, obélisque. Ces kits partagent une texture `colormap` par kit, servie en URL blob (`setURLModifier`) → **un loader par kit**
  - ⚠️ Le *Farm Pack* de Quaternius a été essayé pour les usines (grande halle + silos) puis **abandonné** : à l'écran ça donnait une ferme, pas une usine. Les silhouettes industrielles de Kenney (cheminées, cuves) sont bien plus lisibles à petite taille. Ne pas refaire l'essai
  - **variantes par type** (`VARIANTS`) réparties par hash du seed, pour que deux structures du même type ne soient pas identiques : 6 génériques, 3 usines, 2 infrastructures / entrepôts / QG / recherche / finance / administratifs
  - **mise en peinture** (`TYPE_PAINT`, `GENERIC_PAINT`, `repaint()`) : les bâtiments Quaternius sortent tous du même vert-gris, qui jurait avec les modèles Kenney. On les ramène sur la **palette Kenney** — blanc cassé, gris clair, gris moyen, anthracite, plus un jaune d'accent. Chaque bâtiment porte 5 à 9 matériaux : ils sont classés par luminosité d'origine puis étalés le long d'une RAMPE, ce qui préserve les contrastes internes (toit sombre, murs clairs, corniches) au lieu d'aplatir le bâtiment en une couleur unie. Avec `accent`, le matériau le plus saturé du modèle — donc un détail, porte ou encadrement — passe au jaune. La rampe varie par type (`RAMP_LIGHT` recherche, `RAMP_DARK` QG, `RAMP_FULL` finance/administratif) pour garder un minimum de lisibilité sans casser l'harmonie. Les modèles Kenney ne sont pas repeints, ils sont déjà à la bonne palette
  - corollaire utile : deux types peuvent PARTAGER une forme sans se ressembler — `research-1` et `finance-1` sont le même maillage avec des rampes différentes, ce qui évite d'embarquer 111 Ko en double
  - 4 types **composites** assemblés via `compose()` : centrale nucléaire (complexe + tours de refroidissement), port (porte-conteneurs + conteneurs empilés), monument (obélisque + colonnes + sapins), **base militaire** (enceinte + deux hangars — c'est le PÉRIMÈTRE qui fait lire « base », sans lui on ne voit que des entrepôts ; les hangars réutilisent les templates de `depot`, donc rien de plus à embarquer). Si une pièce manque, le composite n'est pas créé → le type retombe sur son procédural plutôt que d'afficher un assemblage tronqué
  - `solidColor()` — repeint un modèle en **aplat**, texture retirée. Utilisé pour l'enceinte, tirée du kit pavillonnaire : une palissade en bois orange au milieu d'une carte grise. Teinter par multiplication (`repaint`) ne suffisait pas — la couleur du matériau MULTIPLIE la texture, donc l'orange virait au brun et jamais au vert-de-gris. À réserver aux géométries simples : sur un bâtiment, retirer la texture supprime le détail
  - ⚠️ Un modèle Sketchfab de base militaire (CC BY) a été essayé puis **abandonné** : 1 Mo de bundle à lui seul, et la simplification bloquait à 17 400 triangles. Le composite ci-dessus obtient le même effet pour 47 Ko, sans obligation d'attribution
  - chargement en **`Promise.allSettled`** : un modèle illisible ne fait retomber QUE son type sur le procédural (un `Promise.all` les faisait tous tomber)
  - hauteur plafonnée, clones à ressources partagées (pas de dispose des géométries/matériaux communs — flag `paxSharedAsset`)
  - procéduraux conservés : aéroport, barrage, base militaire, hôpital, unité, chantier, ruines
  - sources d'assets : `assets-source/` (zips, hors bundle). **Seuls les kits Kenney sont livrés en `.glb`** ; Quaternius & co. ne fournissent que `.obj/.fbx/.blend` → conversion obligatoire (préférer les exports « with Materials », sans texture externe) :
    ```
    node tools/obj-to-glb.mjs <entree.obj> <sortie.glb>
    node tools/check-glb.mjs                 # valide tous les .glb embarqués
    node tools/glb-stats.mjs <fichier.glb>   # fiche d'identité AVANT intégration
    node tools/preview-server.mjs            # planches visuelles, voir ci-dessous
    ```
    `glb-stats` affiche poids / triangles / textures / `generator`. **Un `generator: Sketchfab-*` impose de vérifier la licence à la source** : le projet n'embarque que du CC0, or Sketchfab est majoritairement CC-BY ou non redistribuable et le fichier ne porte pas sa licence
    Pipeline `obj2gltf → prune → quantize` (~45 % de gain ; `prune` supprime les UV inutiles, `quantize` utilise `KHR_mesh_quantization`, géré nativement par three.js). ⚠️ Ne PAS ajouter Draco/meshopt sans câbler le décodeur, sinon le chargement échoue. `check-glb` rejoue le parsing avec le GLTFLoader réel — indispensable après toute conversion ; il marque `SKIP` les modèles Kenney, dont la texture externe n'est pas résolvable hors navigateur
  - **vérification visuelle obligatoire** — `node tools/preview-server.mjs` puis :
    - `http://localhost:5599` → planche de TOUS les types tels que rendus par l'overlay, **une case par variante** (`src/dev/model-preview.ts`, seeds calculés pour couvrir chaque variante) → `preview/models.png`
    - `http://localhost:5599/sheet?dir=<kit>` → planche de contact d'un kit BRUT posé dans `preview/kit/<kit>/`, **chaque modèle légendé par son nom de fichier** (`src/dev/asset-sheet.ts`) → `preview/kit-<kit>.png`. Les kits nomment leurs modèles `building-a` … `building-t` : impossible de savoir lequel est une halle d'usine sans regarder. `preview/kit/` contient les kits déjà extraits (regénérables depuis les zips)
    - Ces deux planches existent parce que **choisir ou composer sans regarder produit des absurdités** — usine-grange, « port » fait de tas de gravats (`cargo-pile-*` n'est PAS une pile de conteneurs), infrastructure réduite à un château d'eau. Toujours les relire avant de livrer
  - **poids** : les modèles s'affichent entre 24 et 150 px, donc le détail géométrique ne se voit pas mais pèse. Deux bâtiments Quaternius à eux seuls faisaient 814 Ko (bundle à 5,9 Mo) ; les remplacer par des formes légères l'a ramené à 4,8 Mo. Vérifier `dist/page-inject.js` après ajout — il est injecté à `document_start` sur chaque page du jeu
  - ajouter un modèle = poser le `.glb` (+ la colormap si kit Kenney) dans `src/render3d/assets/`, déclarer le kit dans `asset-models.ts`, mapper le type dans `templateKey()` / `VARIANTS`, **puis regarder la planche**
  - types 💰 `finance` (fonds souverains, banques, trésor…) et 📄 `policy` (réformes, chartes, traités, recensement…) — modèles dédiés
  - **fallback centroïde de région** : une feature créée introuvable par son nom dans mapFeatures est placée au centroïde de sa région (géométrie lue dans le cache `["mapGeometry", …]`) — couvre les features sans tags des parties multi ; les rares échecs restants loggent `⚠️ feature du jeu SANS bâtiment` avec l'objet complet (diagnostic)
  - **support multijoueur** : les parties live sont sur `/live/{uuid}` avec un modèle dédié — cache `["liveGame","events",{roundNumber:N}]` par round + `["liveGameRoster",uuid]` (découvert via le diagnostic 🔍) ; l'extension reconstruit un pseudo-état depuis ces requêtes et logge un échantillon `🔬` des données live pour affiner ; scan « par la forme » + diagnostic `🔍 clés du cache` conservés en filets
  - **couverture élargie** : « feature couvrable » = toute feature non-ville (tags sans `city`/`capital`), quelle que soit sa forme de position (`oLng/oLat`, `longitude/latitude`, OU `regionID` seul → centroïde) — couvre les features custom/joueur ; **balayage direct de `round.mapFeatures`** (indépendant des événements, qui peuvent être consolidés) ; type ⚔️ `unit` pour les unités mobiles (icône + campement, suivi de position, retrait à la dissolution) ; anti-doublon resserré de 200 km → 12 km ; tooltip au survol, clic transmis au jeu (fiche native)
  - **résurrection** : une feature détruite (ruines) qui réapparaît dans `round.mapFeatures` repasse en « construit » — `round.mapFeatures` est la source de vérité de l'existence (corrige les Secretariat détruits-recréés qui restaient en ruines)
  - **masquage des labels robuste** : try/catch PAR feature (un id inconnu du layer — feature recréée/non synchronisée — ne bloque plus le masquage des suivantes ; auparavant un seul échec laissait tous les labels suivants visibles)
- [x] **Étape 10** — multijoueur (`/live/{uuid}`) fonctionnel :
  - le pont moteur s'accroche aussi sur `/live/` (il était verrouillé sur `/game/` — même moteur de carte pour les deux modes)
  - **en live, AUCUN état de partie ne transite par le cache React Query** (les requêtes `["liveGame","events",…]` restent vides ; les données arrivent en temps réel via Ably directement dans le calque de carte)
  - la source de features est un **tap passif sur `featureLayer.setFeatures(features)`** (posé sur le prototype du calque, trouvé par la présence de `setFeatureLabelOpacity`) : capture de l'argument puis exécution identique — `injectLiveFeatures()` normalise le format live `{id, label, position:[lng,lat], tags, regionID, shape…}` vers le format solo (tag `city` → forme preset `longitude/latitude` = exclue ; sinon forme IA `oLng/oLat` = couverte)
  - pseudo-état synthétisé même sans événements : balayage, masquage, tooltips et persistance (clé = uuid) fonctionnent comme en solo ; un F5 restaure immédiatement les structures sauvegardées
  - limite connue : le remplissage INITIAL du calque ne passe pas par `setFeatures` (constructeur) — sur une partie jamais capturée, la première capture demande un rafraîchissement des données (aller-retour Parties ↔ partie, ou tour qui avance)
- [x] **Étape 8** — couverture totale des mapChanges + désencombrement :
  - type `generic` (petit complexe neutre) en repli : TOUTE feature non-unité reçoit un bâtiment ; vocabulaire d'unités bilingue EN/FR (bataillon, escadron, milice, convoi, task force, team, guard…) validé sur les noms réels d'une partie de 72 tours
  - **labels du jeu masqués** pour les features IA (`src/label-hider.ts`, `setFeatureLabelOpacity` via l'API interne, ré-appliqué toutes les 3 s, best-effort silencieux ; les villes du preset gardent leurs noms) — toggle dans le popup
  - **fiche au clic** sur un bâtiment 3D (nom, type, état, date in-game) — remplace le label masqué
