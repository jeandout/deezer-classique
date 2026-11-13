# Deezer – Catalogues de labels (extension Chrome)

Ajoute à deezer.com une recherche par label : on retrouve le catalogue complet
d'un label dans **MusicBrainz**, puis chaque album est recherché sur **Deezer**
pour être écouté directement dans le lecteur web.

## Installation

1. Décompressez le dossier `deezer-label-browser` quelque part où il restera (ne le supprimez pas ensuite).
2. Dans Chrome, ouvrez `chrome://extensions`.
3. Activez le **Mode développeur** (en haut à droite).
4. Cliquez sur **Charger l'extension non empaquetée** et choisissez le dossier `deezer-label-browser`.
5. Ouvrez ou rechargez https://www.deezer.com.

Pour une mise à jour : remplacez les fichiers, puis cliquez sur ⟳ dans `chrome://extensions` et rechargez Deezer.

## Utilisation

- **Mention légale cliquable** : en bas de chaque page d'album, les lignes « © 2004 Chandos Records »
  et « ℗ 2004 Chandos Records » sont cliquables et ouvrent directement le catalogue du label.
- Un onglet violet **🏷** apparaît aussi à droite de la page. Sur une page d'album, il affiche le label de l'album.
- Le label est identifié dans MusicBrainz grâce au code-barres de l'album (identification exacte).
  Si l'extension ne peut pas trancher, elle propose une liste de labels.
- **Recherche libre** : tapez un nom de label (Harmonia Mundi, BIS, Alpha, Chandos…). Tous les labels dont le nom
  ou la description contient ce mot sont **cochés d'office** (ex. pour « chandos » : Chandos, Chaconne, Chandos Classics,
  Chandos Historical…), sauf les éditeurs (Publisher) et les entrées « not for release label use ».
  Ajustez les cases puis « Parcourir les N labels cochés » : ils forment un seul catalogue, sans doublons.
- **Sous-labels inclus automatiquement** : en ouvrant un label (Chandos), ses sous-labels et marques connus de
  MusicBrainz (Chaconne…) sont ajoutés et cochés. En haut du catalogue, chaque label se coche ou se décoche d'un clic ;
  un label décoché reste affiché pour pouvoir le recocher. Les autres labels liés (label parent, distributeur…)
  s'ajoutent avec « + ».
- Le catalogue n'affiche que les albums **disponibles sur Deezer**. Ils apparaissent au fur et à mesure des vérifications.
  - filtre par titre, compositeur, interprète ou **numéro de catalogue** ;
  - tri par date, numéro de catalogue, titre ou artiste ;
  - les labels liés (label parent, sous-labels, anciens noms) sont cliquables.
- Clic sur un album → il s'ouvre dans Deezer sans couper la lecture. Ctrl+clic → nouvel onglet.
- Le panneau reprend la police et les couleurs de Deezer (thème clair ou sombre).

## Cache

Tout est gardé dans le stockage local de Chrome, une recherche déjà faite est donc quasi instantanée :

| Donnée | Durée |
|---|---|
| Catalogue MusicBrainz d'un label | 7 jours (lien « actualiser » pour forcer) |
| Album trouvé sur Deezer | 90 jours |
| Album absent de Deezer | 14 jours (on réessaie plus souvent) |
| Recherche de label par nom | 7 jours |
| Fiche d'un label, code-barres → label | 30 jours |

Le filtre (titre, compositeur, n° de catalogue) et le tri se font localement, sans aucune requête.

## Bon à savoir

- **Si MusicBrainz est surchargé** (message « refuse les requêtes pour le moment »), l'extension a déjà
  réessayé plusieurs fois en ralentissant. Les pages chargées sont conservées : le bouton
  « Reprendre le chargement » repart de là où le chargement s'était arrêté.
- **Lenteur au premier chargement** : MusicBrainz limite à 1 requête par seconde et renvoie
  100 éditions par requête. Ensuite chaque album est cherché sur Deezer (environ 10 requêtes par seconde).
  Pour un gros label (plusieurs milliers d'éditions), la première exploration complète peut prendre
  de l'ordre d'une dizaine de minutes ; les albums s'affichent dès qu'ils sont trouvés, en commençant
  par ceux qui correspondent au tri et au filtre choisis. Les fois suivantes, tout vient du cache.
- **Si un clic sur un album ne fait rien** : décochez « Ouvrir les albums sans recharger la page »
  dans l'écran d'accueil du panneau (les albums s'ouvriront alors avec un rechargement).
- La couverture de MusicBrainz est inégale pour les petits labels classiques.

## Fichiers

- `manifest.json` – déclaration de l'extension (Manifest V3).
- `background.js` – appels aux API, files d'attente, cache, rapprochement des albums.
- `content.js` – bouton et panneau injectés dans deezer.com.
