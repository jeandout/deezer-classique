# Deezer Classique

Deux extensions Chrome indépendantes pour mieux explorer la musique classique sur Deezer.

| Dossier | Extension | Ce qu'elle fait |
|---|---|---|
| [`extension-classique/`](extension-classique/) | **Deezer Classique** (🎼) | Moteur de recherche : compositeur → œuvre → tous les enregistrements disponibles, filtrables par interprète, orchestre, chef, label, tempo, live / studio, lieu, ingénieur du son |
| [`extension-labels/`](extension-labels/) | **Catalogues de labels** (🏷) | Catalogue complet d'un label et de ses sous-labels (MusicBrainz), mention légale cliquable sur les pages d'album |

Elles fonctionnent ensemble ou séparément.

## Installation (pour chacune)

1. Téléchargez le dépôt (bouton **Code → Download ZIP**) et décompressez-le quelque part où il restera.
2. Dans Chrome, ouvrez `chrome://extensions` et activez le **Mode développeur**.
3. **Charger l'extension non empaquetée** → choisissez le dossier `extension-classique` (et/ou `extension-labels`).
4. Rechargez https://www.deezer.com.

Pour une mise à jour : remplacez les fichiers, cliquez sur ⟳ dans `chrome://extensions`, puis rechargez Deezer.

## Sources de données

- [Open Opus](https://openopus.org) — compositeurs et œuvres
- [API Deezer](https://developers.deezer.com/api) — albums, pistes, durées, labels
- [MusicBrainz](https://musicbrainz.org) — labels et sous-labels, rôles des interprètes, lieux, dates et équipes d'enregistrement
