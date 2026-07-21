# Crédits

Le code de cette extension est sous licence MIT (voir `LICENSE`). Les modèles 3D
embarqués dans `src/render3d/assets/` proviennent de tiers et gardent leur
licence d'origine — toutes en **CC0 1.0 (domaine public)**, donc redistribuables
sans condition. Ces crédits sont volontaires : ils ne sont pas exigés par le CC0.

Aucun modèle sous **CC BY** n'est embarqué à ce jour. Si l'un venait à l'être,
il faudrait créditer ici son auteur, lier la licence et signaler les
modifications — l'attribution est alors une obligation, pas une politesse.

## Modèles 3D

| Source | Kits utilisés | Licence |
|---|---|---|
| [Kenney](https://kenney.nl) | City Kit (Industrial), City Kit (Suburban), Watercraft Pack, Graveyard Kit | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| [Quaternius](https://quaternius.com) | Ultimate Buildings Pack | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |

Ces modèles ont été **modifiés** : conversion en `.glb`, optimisation
(suppression des UV inutiles, quantification `KHR_mesh_quantization`),
normalisation d'échelle, assemblage en modèles composites, recoloration des
bâtiments Quaternius sur la palette Kenney, et mise à plat de la palissade
pavillonnaire en vert-de-gris pour la base militaire (voir
`src/render3d/asset-models.ts`).

## Bibliothèques

| Projet | Usage | Licence |
|---|---|---|
| [three.js](https://threejs.org) | rendu de l'overlay | MIT |
| [esbuild](https://esbuild.github.io) | build | MIT |
| [obj2gltf](https://github.com/CesiumGS/obj2gltf), [glTF-Transform](https://gltf-transform.dev) | conversion et optimisation des assets (dev uniquement) | Apache-2.0 / MIT |

## Non inclus dans ce dépôt

Le dossier `assets-source/` (exclu par `.gitignore`) contient des archives de
travail, dont **quatre modèles Sketchfab sous CC BY 4.0** (base militaire,
hôpital, aéroport, barrage). Ils ne sont **pas** embarqués dans l'extension et ne
sont **pas** redistribués ici. La base militaire a été essayée puis retirée : à
elle seule elle ajoutait 1 Mo au bundle, sans que la simplification puisse
descendre sous 17 400 triangles. Si l'un d'eux est intégré un jour, son auteur,
un lien vers l'œuvre originale et la mention des modifications devront figurer
plus haut.

## Données cartographiques

Les coordonnées manipulées par l'extension proviennent du jeu Pax Historia, qui
s'appuie sur des données © [OpenStreetMap](https://www.openstreetmap.org/copyright)
(ODbL). L'extension ne redistribue aucune donnée cartographique.

## Pax Historia

Ce projet est **non officiel** et sans affiliation avec Pax Historia. Il ne
modifie pas le jeu, n'envoie aucune donnée à ses serveurs et se contente
d'afficher une surcouche visuelle locale, en lecture seule.
