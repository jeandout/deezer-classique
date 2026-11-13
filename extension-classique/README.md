# Deezer Classique (extension Chrome)

Un moteur de recherche pour la musique classique, intégré au lecteur web de Deezer.
Le bouton **🎼 Classique**, à droite de la page, ouvre un grand panneau (Échap pour le fermer).

## Utilisation

1. **Compositeur** : tapez un nom, ou choisissez parmi les compositeurs populaires.
2. **Œuvres** : filtrez par genre (orchestre, musique de chambre, clavier, vocal, scène),
   par forme (concerto, symphonie, sonate, quatuor…), par instrument, ou par texte
   (« op. 18 »…). ★ = œuvre populaire.
3. **Enregistrements** : tous les albums Deezer qui contiennent l'œuvre, avec des filtres
   à gauche (nombre de résultats pour chaque valeur) :
   tempo, soliste / interprète, orchestre / ensemble, chef, label, décennie, live / studio,
   type de lieu (studio, salle de concert, église…), lieu, ingénieur du son, directeur
   artistique, version (complète, extrait, arrangement). Par défaut, seules les versions
   complètes sont affichées.

Un clic sur un album l'ouvre dans Deezer sans couper la lecture (Ctrl+clic : nouvel onglet).

## Tempo

« **Durée de** » (à côté du tri) choisit ce qui est comparé : l'œuvre entière ou un
mouvement (« I. Allegro ma non tanto »…). Chaque version est classée d'après l'écart de
sa durée à la **médiane** des versions trouvées :

| Tranche | Écart à la médiane |
|---|---|
| Très rapide | plus de 10 % plus court |
| Rapide | 4 à 10 % plus court |
| Médian | ± 4 % |
| Lent | 4 à 10 % plus long |
| Très lent | plus de 10 % plus long |

Les bornes s'affichent en minutes dans le filtre, et chaque carte indique sa durée et son
écart (« ⏱ 17:25 · +3 % »). Les tris **Plus rapide** / **Plus lent** classent par durée.

La durée reflète surtout le tempo, mais aussi : les coupures (fréquentes dans les
enregistrements anciens), les variantes de la partition (ex. la cadence « ossia » du
3ᵉ concerto de Rachmaninov), les applaudissements en concert, et parfois un découpage
des pistes différent (mouvements enchaînés).

## D'où viennent les informations

| Information | Source |
|---|---|
| Compositeurs, œuvres, genres | Open Opus |
| Albums, pistes, durées, interprètes, label, pochettes | API publique Deezer |
| Rôles exacts (soliste et instrument, chef, orchestre), lieu, date, live, ingénieurs, directeur artistique | MusicBrainz, via le code ISRC de chaque piste |

Les détails MusicBrainz arrivent progressivement (une requête par seconde) : environ
5 secondes par album la première fois, puis tout est en cache. Ils existent surtout pour
les grands labels ; sinon les interprètes viennent de Deezer et le chef est deviné
(affiché avec « ? »).

## Cache

| Donnée | Durée |
|---|---|
| Œuvres d'un compositeur | 30 jours |
| Enregistrements d'une œuvre sur Deezer | 7 jours |
| Détails MusicBrainz d'un enregistrement | 90 jours (30 si introuvable) |

## Fichiers

- `manifest.json` – déclaration de l'extension (Manifest V3).
- `background.js` – files d'attente, requêtes, cache.
- `bg-works.js` – Open Opus, recherche Deezer, reconnaissance des œuvres, enrichissement MusicBrainz.
- `content.js` – bouton et panneau injectés dans deezer.com.
- `works.js` – interface : compositeurs, œuvres, enregistrements, filtres, tempo.
