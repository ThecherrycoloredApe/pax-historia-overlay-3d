# Projet : Overlay 3D pour Pax Historia (extension navigateur)

## Contexte

Pax Historia (https://www.paxhistoria.co) est un jeu de grande stratégie par navigateur, piloté par IA. Le joueur contrôle un pays sur une carte 2D du monde, écrit ses actions en texte libre (ex : « construire une centrale nucléaire près de Lyon »), puis fait un « time-jump » : l'IA simule le monde et renvoie des événements sous forme de texte. La carte 2D affiche seulement les frontières, des carrés (villes), des étoiles (capitales) et des unités militaires. Rien d'autre n'apparaît visuellement, même quand une action crée une infrastructure.

Le jeu n'a **pas d'API publique ni de système de mods**. Tout devra donc se faire côté client, par-dessus la page.

## Objectif

Créer une **extension de navigateur (Chrome, Manifest V3)** qui :

1. Intercepte les événements générés par le jeu (réponses réseau JSON).
2. Détecte dans le texte des événements les constructions/infrastructures notables (centrale nucléaire, port, base militaire, barrage, aéroport, usine...) ainsi que leur localisation.
3. Affiche à l'endroit correspondant sur la carte un **petit modèle 3D low-poly** (three.js) sur un canvas transparent superposé à la carte du jeu.
4. Garde ces modèles **parfaitement synchronisés** avec le pan/zoom de la carte du jeu.
5. Persiste les structures détectées (par partie) dans le storage de l'extension pour les réafficher au rechargement.

C'est un overlay **purement visuel et local** : il ne modifie pas le jeu, n'envoie rien au serveur du jeu, ne triche pas. Lecture seule.

## Architecture cible

```
[Page Pax Historia]
   │
   ├── content script (isolated world)
   │      └── injecte le "page script" + crée le canvas overlay
   │
   ├── page script (main world)
   │      ├── monkey-patch de window.fetch / XMLHttpRequest
   │      │     → capture les réponses JSON du jeu (événements, état de la carte)
   │      │     → relaie au content script via window.postMessage
   │      └── hooks sur le moteur de carte (transformation caméra)
   │
   ├── module "parser"
   │      └── texte d'événement → { type: "nuclear_plant", location: "Lyon", date }
   │            - v1 : regex/mots-clés multilingues (centrale, nuclear plant, port, harbor...)
   │            - v2 (option) : appel LLM avec clé API fournie par l'utilisateur
   │
   ├── module "geo"
   │      └── nom de lieu → coordonnées carte
   │            - d'abord : matcher avec les "map features" du jeu (villes déjà
   │              présentes dans les données interceptées : noms + coordonnées)
   │            - fallback : petit dictionnaire local de villes (lat/lng)
   │
   └── module "render3d" (three.js)
          └── canvas WebGL transparent en position:absolute au-dessus de la carte,
              pointer-events:none, caméra orthographique recalée à chaque frame
              sur la transformation (pan/zoom) de la carte du jeu
```

## Phase 0 — Investigation (à faire en premier, c'est la clé du projet)

Avant de coder le rendu, il faut comprendre comment le jeu fonctionne. Me guider pour :

1. Ouvrir les DevTools sur une partie Pax Historia et **capturer les requêtes réseau** pendant un time-jump : identifier les endpoints et le schéma JSON des événements et de l'état de carte.
2. Identifier **la bibliothèque de rendu de la carte** (canvas 2D custom ? MapLibre/Leaflet ? PixiJS ? SVG ?) en inspectant le DOM et les sources. C'est ce qui détermine comment lire la transformation caméra (pan/zoom) :
   - si c'est une lib connue → utiliser son API d'événements (move/zoom) ;
   - si c'est custom → lire la matrice de transformation du canvas/conteneur, ou re-dériver pan/zoom en observant les positions d'éléments connus (villes).
3. Vérifier si les données interceptées contiennent les **coordonnées des map features** (villes/capitales avec noms) — si oui, ça résout le géocodage presque gratuitement.

Le projet doit être structuré pour que les découvertes de cette phase (noms d'endpoints, schémas JSON, sélecteurs DOM) soient isolées dans un fichier de config/adapters facile à mettre à jour, car **le site change souvent** (c'est une beta active).

## MVP (v0.1)

- Extension Chrome MV3 chargée en mode développeur.
- Interception fetch/XHR fonctionnelle + log lisible des événements du jeu.
- Parser regex : détecte au moins « centrale nucléaire / nuclear (power) plant » + un nom de ville.
- Un seul modèle 3D : cube ou cylindre placeholder posé au bon endroit sur la carte.
- Synchro pan/zoom correcte (le placeholder ne « glisse » pas quand on bouge la carte).
- Persistance en chrome.storage.local, par identifiant de partie.

## v0.2 et au-delà

- 4-5 modèles low-poly distincts (centrale = 2 tours de refroidissement + dôme, port = grues, base militaire, aéroport, barrage), construits en géométries three.js procédurales (pas d'assets externes lourds).
- Petit panneau UI (popup de l'extension) : liste des structures détectées, toggle on/off de l'overlay, bouton « supprimer/ajouter manuellement une structure ».
- Détection de la destruction (« la centrale a été détruite/bombardée ») → retirer ou remplacer le modèle par des ruines.
- Option : parsing par LLM (l'utilisateur colle sa propre clé API) pour extraire {type, lieu, action} de façon robuste.

## Contraintes techniques

- **Manifest V3**, content script + script injecté en main world (nécessaire pour patcher fetch avant le code du jeu si possible ; sinon patcher au plus tôt).
- three.js en local dans l'extension (pas de CDN, à cause de la CSP des extensions MV3).
- Canvas overlay : `position:absolute`, `pointer-events:none`, z-index au-dessus de la carte mais sous l'UI du jeu si possible.
- Performance : peu d'objets, géométries simples, rendu on-demand (re-render seulement quand la caméra bouge ou qu'une structure change), pas de boucle 60fps permanente si rien ne bouge.
- Le code doit tolérer les échecs silencieusement : si le site a changé et que les hooks cassent, l'extension ne doit jamais casser le jeu lui-même.
- Respecter le jeu : aucune requête vers les serveurs de Pax Historia autre que celles du jeu lui-même, aucune modification des données envoyées.

## Livrables attendus

1. Repo structuré : `manifest.json`, `src/content.ts`, `src/page-inject.ts`, `src/parser/`, `src/geo/`, `src/render3d/`, `src/config/adapters.ts`, build simple (Vite ou esbuild).
2. README avec : installation en mode dev, comment lancer la phase d'investigation DevTools, comment mettre à jour les adapters quand le site change.
3. TypeScript de préférence.

## Ordre de travail suggéré

1. Squelette d'extension MV3 + injection + interception fetch avec logs.
2. Session d'investigation guidée (je te colle les payloads JSON capturés, tu en déduis les schémas et on remplit `adapters.ts`).
3. Overlay canvas + synchro caméra avec un simple carré 2D de test.
4. Passage à three.js + placeholder 3D.
5. Parser + géocodage via les map features.
6. Persistance, puis modèles low-poly par type.
