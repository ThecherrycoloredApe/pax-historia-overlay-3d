# Projet : Overlay 3D pour Pax Historia (extension navigateur) — Brief v2

> **v2 du 2026-07-14**, révisé après la Phase 0 (investigation terminée — voir `donnees-investigation-phase0.md` pour toutes les données techniques). L'original est conservé dans `brief-projet-overlay-3d-pax-historia.md`.
> Changements majeurs vs v1 : la Phase 0 est **faite** ; la synchro caméra et le géocodage sont **résolus et validés en live** ; l'architecture d'interception est **corrigée** (l'essentiel ne passe pas par du JSON fetch classique) ; les étapes sont re-séquencées en conséquence.

## Contexte

Pax Historia (https://www.paxhistoria.co — `beta.paxhistoria.co` est la même app) est un jeu de grande stratégie par navigateur piloté par IA. Le joueur écrit ses actions en texte libre, fait un « time-jump », l'IA génère des événements texte. La carte (moteur **three.js custom** en WebGL2, projection Web Mercator) n'affiche que frontières, villes (carrés), capitales (étoiles) et unités. **Confirmé en live** : une action « construire une centrale nucléaire près de Lyon » produit un événement riche en texte (`mapChanges: []`) mais **aucun visuel sur la carte**. C'est ce vide que l'overlay comble.

Pas d'API publique ni de mods → tout se fait côté client, par-dessus la page. **Lecture seule** : l'extension ne modifie pas le jeu, n'envoie rien, ne remplace rien (contrairement au seul prior art existant, le userscript ApikeyHook, qui lui remplace le backend IA — on ne réutilise que ses techniques d'injection).

## Objectif (inchangé sur le fond)

Extension Chrome (Manifest V3) qui :
1. Détecte les nouveaux événements générés par le jeu.
2. En extrait les constructions/infrastructures notables + leur localisation.
3. Affiche un petit modèle 3D low-poly (three.js) sur un canvas transparent superposé à la carte.
4. Reste parfaitement synchronisée avec le pan/zoom.
5. Persiste les structures par partie (`chrome.storage.local`, clé = gameId UUID de l'URL `/game/{uuid}`).

## Architecture cible — RÉVISÉE

```
[Page Pax Historia]
   │
   ├── content script (isolated world, all_frames: true, document_start)
   │      └── injecte le page script dans CHAQUE frame + crée le canvas overlay (top frame)
   │
   ├── page script top frame (main world)
   │      ├── ENGINE BRIDGE (la grande nouveauté v2) :
   │      │     • acquisition de l'instance moteur via fiber React du canvas
   │      │       (signature structurelle : {renderer, scene, orthoCamera, mercatorToScreen…})
   │      │     • engine.on('view:change', cb({center:[lng,lat], zoom})) → synchro
   │      │     • engine.mercatorToScreen(mx, my) → {x, y} pixels canvas (validé pixel-perfect)
   │      │     • détection engine.projection === "globe" → masquer l'overlay (v1)
   │      │     • ré-acquisition après navigation SPA (MutationObserver, pattern du userscript)
   │      ├── SOURCE D'ÉVÉNEMENTS (primaire) : état applicatif, PAS le réseau
   │      │     • cache React Query `simpleGames/{gameId}` (ou walk fiber → game.rounds)
   │      │     • round.eventsBetweenStartDateAndEndDate = [{date, title, description(markdown EN),
   │      │       mapChanges, tags:[{text, color}]}]
   │      └── monkey-patch fetch/XHR = COMPLÉMENT diagnostic seulement (logs)
   │
   ├── page script iframe /simple-secure-iframe.html (main world, via all_frames)
   │      └── (optionnel, source secondaire) hook fetch de POST /api/simple-chat
   │            {prompt, promptStage, jsonSchema} → capte les événements à la génération
   │            + permet de logger le jsonSchema complet des événements
   │
   ├── module "parser"
   │      └── description/title (ANGLAIS, markdown — le gras marque les éléments notables)
   │            → {type: "nuclear_plant" | "port" | "military_base" | "dam" | "airport" | "factory", …}
   │            v1 : mots-clés EN d'abord (FR bonus) ; v2 : LLM opt-in avec clé utilisateur
   │
   ├── module "geo" — RÉSOLU
   │      └── event.tags[].text  →  match  round.mapFeatures[].name
   │            (~792 villes : {name, location:{longitude, latitude, regionID}, tags, displaySymbol})
   │            fallback : mini-dictionnaire local UNIQUEMENT pour lieux hors mapFeatures
   │            lat/lng → mercator mètres (EPSG:3857) → mercatorToScreen
   │
   └── module "render3d" (three.js local, CSP MV3)
          └── canvas WebGL transparent position:absolute, pointer-events:none,
              au-dessus du canvas du jeu ; re-render UNIQUEMENT sur view:change /
              changement de structures (rendu on-demand, comme le jeu lui-même) ;
              gérer le wrap horizontal (monde répété à ±40 075 016,686 m)
```

### Ce qui a changé et pourquoi
| Brief v1 supposait | Réalité (Phase 0) | Conséquence |
|---|---|---|
| « Intercepter les réponses réseau JSON » comme source des événements | La génération passe par `POST /api/simple-chat` **dans un iframe sandboxé** ; l'état de partie vit dans le cache React Query, pas dans des fetch JSON top-frame ; Firestore ne porte que les profils | Source primaire = état applicatif ; hook fetch relégué en diagnostic ; si hook réseau → `all_frames` obligatoire |
| Lib de carte inconnue (Leaflet ? Pixi ? custom ?) → « lire la matrice de transformation ou re-dériver pan/zoom » | Moteur three.js custom **avec API interne propre** : `mercatorToScreen`, `view:change`, `flyTo`… accessible via fiber React | Plus besoin de re-dériver quoi que ce soit : on consomme l'API du moteur. Le plan B (observer les positions de villes) reste documenté mais ne sera codé que si l'accès fiber casse |
| Géocodage : « matcher les map features si elles existent, sinon dictionnaire local » | `round.mapFeatures` = 792 villes nommées avec lat/lng exactes, et les événements portent déjà des `tags` de lieux | Géocodage = simple jointure tags ↔ mapFeatures. Le dictionnaire local devient un petit fallback, pas un module central |
| Parser regex « multilingue (centrale, nuclear plant…) » | Les événements sont générés **en anglais** même avec l'UI française, en markdown avec gras sur les éléments notables | Parser v1 : anglais d'abord, exploiter le gras ; FR en bonus |
| Phase 0 à faire (« c'est la clé du projet ») | **Faite et validée en live** (marqueurs DOM alignés pixel-perfect avant/après pan sur une vraie partie) | L'étape « session d'investigation guidée » disparaît de l'ordre de travail |

## MVP (v0.1) — révisé

- Extension Chrome MV3 en mode dev, `all_frames: true`, injection main world au `document_start`.
- **Engine bridge fonctionnel** : acquisition du moteur, log de `view:change`, `mercatorToScreen` exposé. (Remplace « interception fetch + logs » comme première brique — c'est elle la fondation.)
- Overlay : un modèle placeholder (cube/cylindre) posé à un lieu donné, **sans glissement** au pan/zoom (critère : superposé au symbole de ville du jeu comme nos marqueurs de test).
- Lecture des événements du round courant + parser EN minimal : « nuclear (power) plant / reactor » + port → geo via tags↔mapFeatures.
- Persistance `chrome.storage.local` par gameId ; ré-affichage au rechargement.
- Tolérance aux pannes : si l'acquisition moteur ou le schéma échoue → l'extension se désactive silencieusement, le jeu ne casse jamais.

## v0.2 et au-delà (inchangé + précisions)

- 4-5 modèles low-poly procéduraux (centrale = tours de refroidissement + dôme, port = grues, base, aéroport, barrage).
- Panneau UI (popup) : liste des structures, toggle overlay, suppression/ajout manuel. Badge in-page optionnel (pattern header du userscript, avec MutationObserver anti-re-render).
- Détection destruction (« destroyed/bombed ») → ruines.
- Parsing LLM opt-in (clé API utilisateur) — le `jsonSchema` du jeu (capturable via le hook iframe) documente tous les champs d'événements possibles.
- Support du mode « Globe 3D Expérimental » (projection perspective) — v1 : overlay masqué proprement.
- À capturer plus tard : un événement de conquête pour voir `mapChanges` rempli (changements de frontières).

## Contraintes techniques — révisées

- MV3 ; content script `all_frames: true` + `"world": "MAIN"` (ou injection <script>) au `document_start`.
- three.js embarqué en local (CSP) — noter que le jeu bundle SA propre copie de three ; la nôtre reste indépendante dans notre canvas.
- Canvas overlay : `position:absolute`, `pointer-events:none`, z-index entre le canvas du jeu et l'UI.
- **Rendu on-demand** : re-render seulement sur `view:change` ou changement de structures (le moteur du jeu fait pareil — `markDirty`).
- Résilience : les noms minifiés (`C_`, `bE`…) changent à chaque build → n'utiliser QUE des signatures structurelles (présence de `mercatorToScreen` + `renderer` + `scene`). Tout ce qui est fragile vit dans `src/config/adapters.ts` : heuristique fiber, noms d'événements (`view:change`), clé React Query (`simpleGames/{gameId}`), chemins de schéma (`rounds`, `mapFeatures`, `eventsBetweenStartDateAndEndDate`, `tags`), sélecteurs UI de secours.
- Respect du jeu : aucune requête vers leurs serveurs autre que celles du jeu, aucune modification des données, pas d'automatisation d'auth (reCAPTCHA Enterprise présent).
- Budget test : IA « Léger », time-jumps d'1 semaine (~$0.003/tour observé).

## Livrables attendus (inchangés)

1. Repo : `manifest.json`, `src/content.ts`, `src/page-inject.ts`, `src/engine-bridge.ts`, `src/parser/`, `src/geo/`, `src/render3d/`, `src/config/adapters.ts`, build Vite ou esbuild, TypeScript.
2. README : installation dev, comment re-vérifier les adapters quand le site change (checklist Phase 0 condensée), données de référence dans `donnees-investigation-phase0.md`.

## Ordre de travail — RÉVISÉ

1. **Squelette MV3** : manifest (`all_frames`, `document_start`), content script, page-inject, `adapters.ts` pré-rempli avec les découvertes Phase 0, build Vite/esbuild.
2. **Engine bridge** : acquisition moteur via fiber + `view:change` + `mercatorToScreen` ; validation avec des marqueurs DOM (reproduction du test déjà réussi en live).
3. **Overlay three.js** : canvas transparent + placeholder 3D synchronisé (critère MVP de non-glissement).
4. **Source d'événements** : lecture du cache React Query / fiber (`eventsBetweenStartDateAndEndDate`) + détection de nouveaux événements ; hook iframe `simple-chat` en option diagnostic.
5. **Parser + geo** : mots-clés EN + jointure tags↔mapFeatures ; pose automatique du bon placeholder au bon endroit après un time-jump réel.
6. **Persistance + modèles low-poly** par type de structure ; panneau popup.

~~Session d'investigation guidée (ex-étape 2)~~ → faite, remplacée par `donnees-investigation-phase0.md`.
