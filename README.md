# Deezer Classique (extension Chrome)

Un moteur de recherche pour la musique classique, intégré au lecteur web de Deezer :
compositeur → œuvre → tous ses enregistrements écoutables sur Deezer, filtrables par
soliste, orchestre, chef, label, époque, live / studio, lieu et ingénieur du son.
Un second mode parcourt le catalogue complet d'un label et de ses sous-labels.

## Installation

1. Téléchargez le zip (ou le dépôt) et décompressez le dossier quelque part où il restera.
2. Dans Chrome, ouvrez `chrome://extensions`.
3. Activez le **Mode développeur** (en haut à droite).
4. Cliquez sur **Charger l'extension non empaquetée** et choisissez le dossier.
5. Ouvrez ou rechargez https://www.deezer.com.

Pour une mise à jour : remplacez les fichiers, cliquez sur ⟳ dans `chrome://extensions`, puis rechargez Deezer.

## Mode Œuvres (bouton 🎼 Classique)

1. **Compositeur** : tapez un nom, ou choisissez parmi les compositeurs populaires.
2. **Œuvres** : la liste se filtre par genre (orchestre, musique de chambre, clavier,
   vocal, scène), par forme (concerto, symphonie, sonate, quatuor…), par instrument,
   ou par texte (« op. 18 », « concerto »…). ★ = œuvre populaire.
3. **Enregistrements** : tous les albums Deezer qui contiennent l'œuvre. Filtres à gauche,
   avec le nombre de résultats pour chaque valeur :
   soliste / interprète, orchestre / ensemble, chef, label, décennie, live / studio,
   type de lieu (studio, salle de concert, église…), lieu, ingénieur du son, directeur
   artistique, version (complète, extrait, arrangement).
   Par défaut, seules les versions complètes sont affichées.

Un clic sur un album l'ouvre dans Deezer sans couper la lecture (Ctrl+clic : nouvel onglet).
Échap ferme le panneau.

### D'où viennent les informations

| Information | Source |
|---|---|
| Compositeurs, œuvres, genres | [Open Opus](https://openopus.org) |
| Albums, pistes, interprètes, label, pochettes | API publique Deezer |
| Rôles exacts (soliste et instrument, chef, orchestre), lieu, date, live, ingénieurs, directeur artistique | [MusicBrainz](https://musicbrainz.org), via le code ISRC de chaque piste |

Les détails MusicBrainz arrivent progressivement (MusicBrainz n'accepte qu'une requête
par seconde) : environ 5 secondes par album la première fois, puis tout est en cache.
Ils existent surtout pour les enregistrements des grands labels ; pour les autres, les
interprètes viennent de Deezer et le chef est deviné (affiché avec « ? »).
Aucune base ne décrit le placement des micros : le type de lieu et l'ingénieur du son
sont les meilleurs indices.

## Mode Labels (bouton 🏷 ou onglet Labels)

- **Mention légale cliquable** : en bas de chaque page d'album, « © 2004 Chandos Records »
  ouvre le catalogue du label.
- **Recherche par nom** : tous les labels dont le nom ou la description contient le mot sont
  cochés d'office (sauf éditeurs et « not for release »).
- **Sous-labels inclus automatiquement** (ex. Chandos → Chaconne, Chandos Classics…) ;
  chaque label se coche / décoche d'un clic en haut du catalogue.
- Seuls les albums disponibles sur Deezer sont affichés ; filtre par titre, compositeur,
  interprète, n° de catalogue ; tri par date ou n° de catalogue.

## Cache

| Donnée | Durée |
|---|---|
| Liste des œuvres d'un compositeur | 30 jours |
| Enregistrements d'une œuvre sur Deezer | 7 jours |
| Détails MusicBrainz d'un enregistrement | 90 jours (30 jours si introuvable) |
| Catalogue d'un label | 7 jours (lien « actualiser ») |
| Albums Deezer trouvés | 90 jours |

## Bon à savoir

- **Si MusicBrainz est surchargé**, l'extension réessaie plusieurs fois en ralentissant ;
  un chargement de label interrompu peut être repris là où il s'est arrêté.
- **Si un clic sur un album ne fait rien** : onglet Labels → décochez « Ouvrir les albums
  sans recharger la page ».

## Fichiers

- `manifest.json` – déclaration de l'extension (Manifest V3).
- `background.js` – appels aux API, files d'attente, cache ; mode Labels.
- `bg-works.js` – mode Œuvres : Open Opus, recherche Deezer, enrichissement MusicBrainz.
- `works.js` – interface du mode Œuvres.
- `content.js` – panneau injecté dans deezer.com, mode Labels.
