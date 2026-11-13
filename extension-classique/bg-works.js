// Mode « Œuvres » (service worker) : compositeurs et œuvres (Open Opus),
// enregistrements disponibles (recherche de pistes Deezer) et enrichissement
// par MusicBrainz via l'ISRC (rôles, lieu, date, live, ingénieurs).
// Chargé par background.js (importScripts) : utilise mb(), dz(), cached(),
// cacheGet(), cacheSet(), norm(), similarity(), sleep, DAY.

const OO = "https://api.openopus.org";
const ooQueue = makeQueue(150);
const oo = (path) => getJson(ooQueue, `${OO}${path}`, true);

TTL.ooComposers = 30 * DAY;
TTL.ooWorks = 30 * DAY;
TTL.workSearch = 7 * DAY;
TTL.dzAlbumFull = 30 * DAY;
TTL.isrcFound = 90 * DAY;
TTL.isrcNone = 30 * DAY;

// --- Open Opus --------------------------------------------------------------
const compactComposer = (c) => ({
  id: c.id, name: c.name, complete_name: c.complete_name, epoch: c.epoch || "",
  birth: (c.birth || "").slice(0, 4), death: (c.death || "").slice(0, 4), portrait: c.portrait || "",
});

async function ooComposerSearch(q) {
  const t = q.trim();
  if (t.length < 3) return [];
  return cached(`oos2:${norm(t)}`, TTL.ooComposers, async () => {
    const d = await oo(`/composer/list/search/${encodeURIComponent(t)}.json`);
    const found = (d.composers || []).map(compactComposer);
    if (found.length) return found;
    // Faute de frappe (« Rachmaninof », « Shostakovitch ») : recherche approchée
    // sur la liste complète d'Open Opus (220 compositeurs).
    const all = await cached("ooall", TTL.ooComposers, async () =>
      ((await oo("/composer/list/name/all.json")).composers || []).map(compactComposer));
    const qn = norm(t);
    const tol = qn.length >= 8 ? 2 : 1;
    return all.filter((c) => norm(c.complete_name).split(" ").some((w) => w.length > 3 && levenshtein(w, qn) <= tol));
  });
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

// --- Compositeurs absents d'Open Opus : MusicBrainz ------------------------------
// Recherche approchée (« Reinberger » trouve Rheinberger), limitée aux personnes
// présentées comme compositeurs.
async function mbComposerSearch(q) {
  const t = q.trim().replace(/[()":~^\\/!+-]/g, " ").trim();
  if (t.length < 3) return [];
  return cached(`mbcs:${norm(t)}`, TTL.ooComposers, async () => {
    const terms = norm(t).split(" ").filter(Boolean).map((w) => `${w}~`).join(" AND ");
    const d = await mb(`/artist?query=${encodeURIComponent(`artist:(${terms}) AND type:person`)}&limit=15`, true);
    return (d.artists || [])
      .filter((a) => /compos/i.test(`${a.disambiguation || ""} ${(a.tags || []).map((x) => x.name).join(" ")}`))
      .slice(0, 8)
      .map((a) => {
        const sort = a["sort-name"] || a.name;
        const last = sort.includes(",") ? sort.split(",")[0].trim() : a.name.split(" ").pop();
        const full = /[A-Za-z]/.test(a.name) ? a.name : (sort.includes(",") ? sort.split(",").reverse().map((x) => x.trim()).join(" ") : a.name);
        return {
          id: `mb:${a.id}`, mbid: a.id, source: "mb", name: last, complete_name: full,
          epoch: a.disambiguation || "", birth: (a["life-span"]?.begin || "").slice(0, 4),
          death: (a["life-span"]?.end || "").slice(0, 4), portrait: "",
        };
      });
  });
}

// Genre déduit du type MusicBrainz ou du titre (MusicBrainz le renseigne rarement).
function guessGenre(type, title) {
  const t = ` ${normTitle(title)} `;
  if (/\b(opera|singspiel|operetta|ballet|incidental)\b/.test(`${(type || "").toLowerCase()} ${t}`)) return "Stage";
  if (/\b(mass|missa|messe|requiem|stabat|motet|hymn|hymne|cantata|kantate|oratorio|magnificat|psalm|lied|lieder|song|songs|gesang|gesange|chor|chorus|choir|vespers|te deum|ave maria|salve regina|litan)/.test(t)) return "Vocal";
  if (/\b(concerto|symphony|overture|ouverture|serenade for orchestra|symphonic|sinfonisch\w*|orchestra|orchester)\b/.test(t)) return "Orchestral";
  if (/\b(organ|orgel|orgelsonate|piano|klavier|harpsichord|toccata|toccatina|fugue|fuge|prelude|praludium|praludien|etude|studie|vortragsstudien|fantasie|fantasia|tonstuck|charakterstuck|monolog|trio sonata)/.test(t)
    && !/\b(violin|violine|cello|viola|horn|flute|oboe|clarinet|trio|quartet|quintet|sextet)\b/.test(t)) return "Keyboard";
  if (/\b(quartet|quartett|quintet|quintett|trio|sextet|nonet|octet|sonata|sonate|suite|duo|violin|violine|cello|horn)\b/.test(t)) return "Chamber";
  return "";
}

// Œuvres d'un compositeur MusicBrainz : toutes les pages, sans les parties
// d'œuvres (« op. 180: No. 8. Ländlich »), triées par numéro d'opus.
async function mbWorks(mbid) {
  return cached(`mbw:${mbid}`, TTL.ooWorks, async () => {
    const works = [];
    let offset = 0, total = Infinity;
    while (offset < total && offset < 3000) {
      const d = await mb(`/work?artist=${mbid}&limit=100&offset=${offset}`, true);
      total = d["work-count"] ?? 0;
      const page = d.works || [];
      works.push(...page);
      offset += page.length;
      if (!page.length) break;
    }
    const seen = new Set();
    const top = works.filter((w) => !w.title.includes(":") && !seen.has(norm(w.title)) && seen.add(norm(w.title)));
    const opus = (title) => {
      const m = normTitle(title).match(/\bop (\d+)/);
      return m ? +m[1] : 100000;
    };
    return {
      composer: null,
      works: top
        .map((w) => ({ id: `mb:${w.id}`, title: w.title, subtitle: w.disambiguation || "", genre: guessGenre(w.type, w.title), popular: false, recommended: false }))
        .sort((a, b) => opus(a.title) - opus(b.title) || a.title.localeCompare(b.title, undefined, { numeric: true })),
    };
  });
}

async function ooPopularComposers() {
  return cached("oopop", TTL.ooComposers, async () => {
    const d = await oo("/composer/list/pop.json");
    return (d.composers || []).map(compactComposer);
  });
}

async function ooWorks(composerId) {
  return cached(`oow:${composerId}`, TTL.ooWorks, async () => {
    const d = await oo(`/work/list/composer/${composerId}/genre/all.json`);
    return {
      composer: d.composer ? compactComposer(d.composer) : null,
      works: (d.works || []).map((w) => ({
        id: w.id, title: w.title, subtitle: w.subtitle || "", genre: w.genre || "",
        popular: w.popular === "1", recommended: w.recommended === "1",
      })),
    };
  });
}

// --- Identification d'une œuvre dans un titre de piste -----------------------
// Normalisation des titres multilingues (« Klavierkonzert Nr. 2 », « Concerto
// pour piano n° 2 », « Piano Concerto No.2 ») vers une forme commune.
const TITLE_SYNONYMS = [
  [/\bklavierkonzert\b/g, "piano concerto"], [/\bviolinkonzert\b/g, "violin concerto"],
  [/\bcellokonzert\b/g, "cello concerto"], [/\bkonzert\b/g, "concerto"],
  [/\bconcerto pour (piano|violon|violoncelle|clarinette|flute|cor|hautbois|basson|trompette)\b/g, (m, i) => `${FR_INSTR[i]} concerto`],
  [/\bconcerto per (pianoforte|violino|violoncello)\b/g, (m, i) => `${IT_INSTR[i]} concerto`],
  [/\b(sinfonie|symphonie|sinfonia)\b/g, "symphony"], [/\borgelsonate\b/g, "organ sonata"], [/\borgel\b/g, "organ"],
  [/\bsonate\b/g, "sonata"], [/\bmesse\b/g, "mass"],
  [/\b(streichquartett|quatuor a cordes|quartetto)\b/g, "string quartet"], [/\bquatuor\b/g, "quartet"],
  [/\b(klaviertrio|trio avec piano)\b/g, "piano trio"],
  [/\bkv\b/g, "k"], [/\bopus\b/g, "op"], [/\b(nr|n|num|nos)\b(?= ?\d)/g, "no"],
  [/\b(moll|mineur|minore)\b/g, "minor"], [/\b(dur|majeur|maggiore)\b/g, "major"],
];
const FR_INSTR = { piano: "piano", violon: "violin", violoncelle: "cello", clarinette: "clarinet", flute: "flute", cor: "horn", hautbois: "oboe", basson: "bassoon", trompette: "trumpet" };
const IT_INSTR = { pianoforte: "piano", violino: "violin", violoncello: "cello" };

function normTitle(s) {
  let t = norm(s);
  for (const [re, rep] of TITLE_SYNONYMS) t = t.replace(re, rep);
  return t.replace(/\s+/g, " ").trim();
}

// Catalogues : opus, Köchel, BWV (Bach), WWV (Wagner), TWV (Telemann), SWV (Schütz),
// BuxWV, WAB (Bruckner), HWV (Haendel), RV (Vivaldi), D (Schubert), Hob (Haydn),
// FP (Poulenc), S (Liszt), Sz/BB (Bartók), L (Debussy), M (Ravel)…
const CATALOG_RE = /\b(op|k|bwv|wwv|twv|swv|buxwv|wab|mwv|zwv|d|hob|rv|hwv|s|wq|l|sz|bb|woo|trv|jw|fs|fp|m|h|b|z|g)\s?([ivx]+\s)?(\d+[a-z]?)(?:\s(?:no)\s?(\d+))?/;

// Signature d'une œuvre Open Opus : catalogue, numéro, mots du genre.
function workSignature(title) {
  const base = normTitle(title.replace(/["“”].*?["“”]/g, " "));
  const m = base.match(CATALOG_RE);
  const catalog = m ? `${m[1]} ${m[3]}${m[4] ? ` no ${m[4]}` : ""}` : "";
  const head = base.split(/\b(?:in [a-g](?: flat| sharp)? (?:major|minor)|(?:op|k|bwv|wwv|twv|swv|buxwv|wab|d|hob|rv|hwv|s|woo|fp) ?\d+)\b/)[0];
  const num = (head.match(/\bno (\d+)\b/) || [])[1] || "";
  const words = head.replace(/\bno \d+\b/g, " ").split(" ")
    .filter((w) => w.length > 2 && !["for", "and", "the", "with"].includes(w)).slice(0, 4);
  return { catalog, num, words, key: keyOf(base) };
}

// Tonalité « in c minor », « in f sharp major »… (sinon "").
const KEY_RE = /\bin ([a-g])(?: (flat|sharp))? (major|minor)\b/;
function keyOf(t) {
  const m = t.match(KEY_RE);
  return m ? `${m[1]}${m[2] ? ` ${m[2]}` : ""} ${m[3]}` : "";
}

function matchesWork(sig, trackTitle) {
  const t = ` ${normTitle(trackTitle)} `;
  // Tonalité différente (la majeur ≠ ut mineur) : autre œuvre.
  const k = keyOf(t);
  if (sig.key && k && k !== sig.key) return false;
  if (sig.catalog) {
    const [prefix, n, , sub] = sig.catalog.split(" ");
    const re = new RegExp(`\\b${prefix} ?${n}\\b${sub ? `(?: ?,)? no ?${sub}\\b` : ""}`);
    if (re.test(t)) return true;
    // Un autre numéro de catalogue (op. 30, S. 125…) : c'est une autre œuvre.
    // Sans aucun catalogue dans le titre : accepté si genre + numéro concordent.
    if (CATALOG_RE.test(t.trim())) return false;
  }
  if (!sig.words.length) return false;
  if (!sig.words.every((w) => t.includes(` ${w} `) || t.includes(` ${w}s `))) return false;
  if (sig.num && !new RegExp(`\\bno ?${sig.num}\\b`).test(t)) return false;
  // Œuvre sans numéro (« Symphony in C major ») : la tonalité doit figurer dans le titre,
  // sinon n'importe quelle « Symphony » correspondrait.
  if (!sig.num && sig.key && !k) return false;
  return true;
}

function composerKey(c) {
  // 5 premières lettres du nom : Rachmaninoff / Rachmaninov / Rakhmaninov…
  return norm(c.name).replace(/\s/g, "").slice(0, 5);
}

// Le compositeur est-il nommé dans ce texte ? Mot entier, avec une petite tolérance
// d'orthographe (Rachmaninov ≈ Rachmaninoff) mais sans confondre deux noms voisins
// (« Berliner Philharmoniker » n'est pas Berlioz).
function mentionsComposer(text, c) {
  const last = norm(c.name).split(" ").pop() || "";
  if (last.length < 3) return false;
  const key = last.slice(0, Math.min(5, last.length));
  return norm(text).split(" ").some((w) => w === last || (w.startsWith(key) && levenshtein(w, last) <= 2));
}

// --- Recherche des enregistrements d'une œuvre sur Deezer --------------------
function compactAlbumFull(a) {
  return {
    id: a.id, title: a.title, cover: a.cover_medium || "", label: a.label || "", upc: a.upc || "",
    date: a.release_date || "", fans: a.fans || 0, nbTracks: a.nb_tracks || 0, recordType: a.record_type || "",
    contributors: (a.contributors || []).map((c) => c.name),
    contribs: (a.contributors || []).map((c) => ({ id: c.id, name: c.name })),
    genres: (a.genres?.data || []).map((g) => ({ id: g.id, name: g.name })),
    artistId: a.artist?.id || 0, artistName: a.artist?.name || "",
    tracks: (a.tracks?.data || []).map((t) => ({ id: t.id, title: t.title, duration: t.duration || 0, rank: t.rank || 0 })),
  };
}

async function dzAlbumFull(id) {
  return cached(`dzA4:${id}`, TTL.dzAlbumFull, async () => {
    const a = await dz(`/album/${id}`);
    if (!a || !a.id) return null;
    const out = compactAlbumFull(a);
    // La fiche ne liste que 25 pistes : pour un coffret, on lit la liste complète.
    if (out.nbTracks > out.tracks.length) {
      const all = await dz(`/album/${id}/tracks?limit=500`);
      if (all?.data?.length) out.tracks = all.data.map((t) => ({ id: t.id, title: t.title, duration: t.duration || 0, rank: t.rank || 0 }));
    }
    return out;
  });
}

// Une piste appartient à l'œuvre si son titre le dit. Le titre de l'album ne sert
// que pour les pistes qui ne nomment aucune œuvre (« I. Moderato »).
// Piste préfixée par un autre compositeur (« Verdi: Requiem: I. Introit »).
function namesOtherComposer(title, composer) {
  const { composer: named } = splitTrackTitle(title);
  return !!named && !mentionsComposer(named, composer);
}

// Noms d'orchestres et de salles à ignorer dans un titre d'album
// (« Chicago Symphony Orchestra plays Wagner » ne parle pas d'une symphonie).
const ENSEMBLE_WORDS_RE = /\b(symphony|symphonic|philharmonic|chamber|radio|festival|youth)\s+(orchestra|orchestre|band|hall|choir|chorus)\b|\b(sinfonieorchester|symphonieorchester|orchestre symphonique|orchestre philharmonique|orchestra sinfonica)\b/g;
// Titre d'une piste qui ne nomme qu'un mouvement : « I. Allegro », « 2. Adagio », « Finale »…
const MOVEMENT_ONLY_RE = /^\s*(?:[ivx]{1,4}|\d{1,2})[.)]\s|^\s*(allegro|andante|adagio|presto|largo|lento|moderato|vivace|scherzo|finale|menuet|minuet|rondo|intermezzo|larghetto|grave|maestoso|allegretto|andantino|aria|variatio\w*|var|gigue|sarabande|courante|allemande|bourree|bourrée|gavotte|chaconne|ciaccona|passacaglia|toccata|prelude|praeludium|fuga|fugue|kyrie|gloria|credo|sanctus|benedictus|agnus|introitus|offertorium|recitativo|recitative|coro|chorus|chorale|choral|sinfonia|ouverture|overture)\b/i;

function trackMatches(sig, title, albumTitle) {
  if (matchesWork(sig, title)) return true;
  const t = ` ${normTitle(title)} `;
  if (CATALOG_RE.test(t.trim()) || sig.words.some((w) => t.includes(` ${w}`))) return false;
  // Piste sans nom d'œuvre : on s'appuie sur le titre de l'album, seulement si
  // la piste ressemble à un mouvement.
  const tail = title.split(/\s[:\-–]\s|:\s/).pop();
  if (!MOVEMENT_ONLY_RE.test(tail)) return false;
  const album = normTitle(albumTitle).replace(ENSEMBLE_WORDS_RE, " ");
  return matchesWork(sig, `${title} ${album}`);
}

// --- Albums douteux (générés par IA, hors classique…) ------------------------------
// Trois signaux prudents, testés pour ne pas écarter de vrais enregistrements :
// 1) genre Deezer renseigné mais non classique (un album sans genre, une bande
//    originale ou un opéra ne comptent pas) ;
// 2) mots de style dans les titres (synthwave, lo-fi, sleep…) ;
// 3) artiste « usine à albums » : au moins 20 albums, tous parus en moins de deux
//    ans (un vrai interprète a un fonds ancien ; les labels qui numérisent leur
//    catalogue publient beaucoup d'un coup, mais avec des parutions anciennes).
//    Jamais appliqué à un compositeur (page Deezer de Bach) ni à « Various Artists ».
const CLASSICAL_GENRE_RE = /classi|film|movie|soundtrack|game|opera|opéra|vocal|choral|baroque|christ|chrét|gospel|relig|sacr/i;
const STYLE_RE = /\b(synthwave|synth wave|lofi|lo fi|lo-fi|chill|chillout|relax|relaxing|sleep|sleeping|study|studying|meditation|ambient|spa|yoga|focus|lullaby|lullabies|babies|baby|8 bit|8-bit|trap|phonk|edm|techno|remix|epic|cinematic|beats|vibes|slowed|reverb|nightcore|aesthetic)\b/i;
TTL.burst = 30 * DAY;

// Taille du catalogue d'un artiste et date de sa plus ancienne parution.
async function artistCatalogue(artistId) {
  if (!artistId) return null;
  return cached(`artcat:${artistId}`, TTL.burst, async () => {
    const first = await dz(`/artist/${artistId}/albums?limit=100`);
    let items = first.data || [];
    const total = first.total || items.length;
    if (total > items.length) {
      const last = await dz(`/artist/${artistId}/albums?limit=100&index=${Math.max(0, total - 100)}`);
      items = items.concat(last.data || []);
    }
    const dates = items.map((x) => Date.parse(x.release_date)).filter(Boolean);
    return { total, oldest: dates.length ? Math.min(...dates) : 0 };
  });
}

async function suspectFlags(album, tracks) {
  const flags = [];
  const g = album.genres || [];
  if (g.length && !g.some((x) => x.id === 98 || x.id === 173 || CLASSICAL_GENRE_RE.test(x.name))) flags.push(`genre ${g.map((x) => x.name).join(", ")}`);
  const style = `${album.title} ${tracks.map((t) => t.title).join(" ")}`.match(STYLE_RE);
  if (style) flags.push(`style « ${style[1].toLowerCase()} »`);
  const idx = await getComposerIndex();
  if (album.artistId && !idx.find(album.artistName) && !/^various|^divers|^verschiedene/i.test(album.artistName)) {
    const cat = await artistCatalogue(album.artistId).catch(() => null);
    if (cat && cat.total >= 20 && cat.oldest && Date.now() - cat.oldest < 730 * DAY) {
      flags.push(`${album.artistName} : ${cat.total} albums, tous parus depuis ${new Date(cat.oldest).toLocaleDateString("fr-FR", { month: "long", year: "numeric" })}`);
    }
  }
  return flags;
}

const ARRANGEMENT_RE = /\b(arr|arranged|arrangement|transcr|transcription|lofi|lo fi|excerpt|extrait|auszug|version for|remix|chill)\b/i;

function queriesFor(composer, work, sig) {
  const title = work.title.replace(/["“”].*?["“”]/g, " ").replace(/\s+/g, " ").trim();
  const q = [`${composer.name} ${title}`];
  const short = `${composer.name} ${sig.words.join(" ")}${sig.num ? ` ${sig.num}` : ""}`;
  if (sig.words.length) q.push(short);
  if (sig.catalog) q.push(`${composer.name} ${sig.catalog.replace(/^(\w+) /, "$1. ")}`);
  return [...new Set(q)];
}

async function searchWork(composer, work, send, isCancelled) {
  const key = `ws8:${work.id}`;
  const hit = await cacheGet(key, TTL.workSearch);
  if (hit) {
    send({ kind: "entries", entries: hit.entries });
    send({ kind: "done", cached: true, t: hit.t });
    return hit.entries;
  }
  const sig = workSignature(work.title);
  const ck = composerKey(composer);

  // 1) Pistes correspondant à l'œuvre, plusieurs formulations, 3 pages max chacune.
  const tracks = new Map();
  const queries = queriesFor(composer, work, sig);
  let step = 0;
  for (const q of queries) {
    for (let index = 0; index < 300; index += 100) {
      if (isCancelled()) return [];
      const d = await dz(`/search/track?q=${encodeURIComponent(q)}&limit=100&index=${index}`);
      for (const t of d.data || []) {
        if (!trackMatches(sig, t.title, t.album?.title || "")) continue;
        if (namesOtherComposer(t.title, composer)) continue; // « Verdi: Requiem » pour le Requiem de Berlioz
        tracks.set(t.id, t);
      }
      send({ kind: "progress", phase: "deezer", done: ++step, total: queries.length * 3 });
      if (!d.next || (d.data || []).length < 100) break;
    }
  }

  // 2) Regroupement par album, puis fiche complète de chaque album.
  const byAlbum = new Map();
  for (const t of tracks.values()) {
    const id = t.album?.id;
    if (!id) continue;
    if (!byAlbum.has(id)) byAlbum.set(id, []);
    byAlbum.get(id).push({ id: t.id, title: t.title, isrc: t.isrc || "", duration: t.duration || 0, rank: t.rank || 0, artist: t.artist?.name || "" });
  }
  const entries = [];
  let n = 0;
  for (const [albumId, trs] of byAlbum) {
    if (isCancelled()) return [];
    const album = await dzAlbumFull(albumId);
    send({ kind: "progress", phase: "albums", done: ++n, total: byAlbum.size });
    if (!album) continue;
    if (!mentionsComposer(`${album.contributors.join(" ")} ${album.title} ${trs.map((t) => t.title).join(" ")}`, composer)) continue; // autre compositeur
    // Toutes les pistes de l'album qui appartiennent à l'œuvre (tous les mouvements),
    // en gardant l'ISRC connu par la recherche.
    const isrcs = new Map(trs.map((t) => [t.id, t.isrc]));
    const fromAlbum = album.tracks.filter((t) => trackMatches(sig, t.title, album.title) && !namesOtherComposer(t.title, composer))
      .map((t) => ({ ...t, isrc: isrcs.get(t.id) || "" }));
    const known = new Set(fromAlbum.map((t) => t.id));
    const all = [...fromAlbum, ...trs.filter((t) => !known.has(t.id))];
    const arrangement = all.some((t) => ARRANGEMENT_RE.test(t.title)) || ARRANGEMENT_RE.test(album.title);
    const { tracks: _drop, ...albumInfo } = album;
    const suspect = await suspectFlags(album, all);
    const entry = { id: String(albumId), album: albumInfo, tracks: all, arrangement, suspect, rank: Math.max(...all.map((t) => t.rank || 0)) };
    entries.push(entry);
    send({ kind: "entries", entries: [entry] });
  }
  await cacheSet(key, { entries, t: Date.now() });
  send({ kind: "done", cached: false, t: Date.now() });
  return entries;
}

// --- Enrichissement MusicBrainz par ISRC ---------------------------------------
function latinName(a) {
  if (!a) return "";
  if (/[A-Za-z]/.test(a.name)) return a.name;
  const s = a["sort-name"] || a.name;
  const m = s.match(/^([^,]+),\s*(.+)$/);
  return m ? `${m[2]} ${m[1]}` : s;
}

function compactRecording(r) {
  const out = { mbid: r.id, soloists: [], conductors: [], ensembles: [], engineers: [], producers: [], place: null, date: "", live: false };
  const add = (list, v) => { if (v && !list.some((x) => (x.name || x) === (v.name || v))) list.push(v); };
  for (const x of r.relations || []) {
    const attrs = x.attributes || [];
    const name = latinName(x.artist);
    switch (x.type) {
      case "instrument":
      case "vocal":
        add(out.soloists, { name, instrument: attrs.filter((a) => a !== "solo").join(", ") || (x.type === "vocal" ? "voix" : "") });
        break;
      case "conductor": add(out.conductors, name); break;
      case "performing orchestra": add(out.ensembles, name); break;
      case "performer":
        if (x.artist?.type === "Person") add(out.soloists, { name, instrument: "" });
        else add(out.ensembles, name);
        break;
      case "engineer": case "balance": case "recording": case "mix": case "sound":
        if (!attrs.includes("assistant")) add(out.engineers, name);
        break;
      case "producer":
        if (!attrs.includes("executive") && !attrs.includes("assistant")) add(out.producers, name);
        break;
      case "recorded at":
        if (x.place) out.place = { name: x.place.name, type: x.place.type || "", area: x.place.area?.name || "" };
        break;
      case "performance":
        if (attrs.includes("live")) out.live = true;
        break;
    }
    if (!out.date && x.begin && ["performance", "recorded at", "instrument", "conductor", "performing orchestra"].includes(x.type)) out.date = x.begin;
  }
  out.hasData = !!(out.soloists.length || out.conductors.length || out.ensembles.length || out.place || out.engineers.length);
  return out;
}

async function mbByIsrc(isrc, urgent = false) {
  const key = `isrc:${isrc}`;
  const o = (await chrome.storage.local.get(key))[key];
  if (o && Date.now() - o.t < (o.v ? TTL.isrcFound : TTL.isrcNone)) return o.v;
  const d = await mb(`/isrc/${isrc}?inc=artist-rels+place-rels+work-rels`, urgent);
  const recs = (d.recordings || []).map(compactRecording).filter((r) => r.hasData);
  const v = recs[0] || null;
  await cacheSet(key, v);
  return v;
}

// Enrichit un enregistrement : premier ISRC qui donne des données.
async function enrichEntry(entry) {
  for (const t of entry.tracks.filter((x) => x.isrc).slice(0, 3)) {
    if (!t.isrc) continue;
    const r = await mbByIsrc(t.isrc);
    if (r) return r;
  }
  return null;
}

// --- Recherche d'œuvres tous compositeurs, époques (Open Opus) ------------------
const compactWork = (w) => ({
  id: w.id, title: w.title, subtitle: w.subtitle || "", genre: w.genre || "",
  popular: w.popular === "1" || w.popular === true, recommended: w.recommended === "1" || w.recommended === true,
});

// « violin concerto », « requiem »… : œuvres de tous les compositeurs d'Open Opus,
// par pages de 20.
// Termes musicaux français -> anglais (les titres d'Open Opus sont en anglais).
const FR_EN = {
  violon: "violin", violons: "violins", violoncelle: "cello", alto: "viola", flute: "flute", hautbois: "oboe",
  clarinette: "clarinet", basson: "bassoon", cor: "horn", trompette: "trumpet", orgue: "organ", clavecin: "harpsichord",
  guitare: "guitar", harpe: "harp", symphonie: "symphony", symphonies: "symphony", sonate: "sonata", sonates: "sonata",
  quatuor: "quartet", quatuors: "quartet", quintette: "quintet", sextuor: "sextet", octuor: "octet", cordes: "string",
  messe: "mass", messes: "mass", cantate: "cantata", cantates: "cantata", opera: "opera", prelude: "prelude", preludes: "prelude",
  etude: "etude", etudes: "etude", valse: "waltz", valses: "waltz", concertos: "concerto", ouverture: "overture",
  mineur: "minor", majeur: "major", ut: "c", re: "d", mi: "e", fa: "f", sol: "g", si: "b", bemol: "flat", diese: "sharp",
  chœur: "choir", choeur: "choir", poeme: "poem", danse: "dance", danses: "dances", marche: "march",
};
const FR_STOP = new Set(["pour", "de", "des", "du", "en", "a", "avec", "et", "le", "la", "les", "un", "une"]);
function translateQuery(q) {
  return norm(q).split(" ").filter((w) => w && !FR_STOP.has(w)).map((w) => FR_EN[w] || w).join(" ");
}

async function ooOmniRaw(t, offset) {
  const d = await oo(`/omnisearch/${encodeURIComponent(t)}/${offset}.json`);
  return {
    results: (d.results || []).filter((x) => x.work && x.composer)
      .map((x) => ({ composer: compactComposer(x.composer), work: compactWork(x.work) })),
    next: d.next ?? null,
  };
}

async function ooOmni(q, offset = 0) {
  const t = q.trim();
  if (t.length < 3) return { results: [], next: null };
  return cached(`ooomni2:${norm(t)}:${offset}`, TTL.ooWorks, async () => {
    // Requête traduite en anglais (pages suivantes), complétée par la requête
    // d'origine sur la première page (titres en français : « Symphonie fantastique »).
    const en = translateQuery(t);
    const main = await ooOmniRaw(en || t, offset);
    if (offset || !en || en === norm(t)) return main;
    const extra = await ooOmniRaw(t, 0).catch(() => ({ results: [] }));
    const seen = new Set(main.results.map((x) => x.work.id));
    return { results: [...main.results, ...extra.results.filter((x) => !seen.has(x.work.id))], next: main.next };
  });
}

async function ooEpoch(epoch) {
  return cached(`ooepoch:${epoch}`, TTL.ooComposers, async () =>
    ((await oo(`/composer/list/epoch/${encodeURIComponent(epoch)}.json`)).composers || []).map(compactComposer));
}

// --- Interprètes (Deezer) ---------------------------------------------------------
async function dzArtistSearch(q) {
  const t = q.trim();
  if (t.length < 3) return [];
  return cached(`dzas:${norm(t)}`, TTL.ooComposers, async () => {
    const d = await dz(`/search/artist?q=${encodeURIComponent(t)}&limit=8`, true);
    return (d.data || []).map((a) => ({ id: a.id, name: a.name, picture: a.picture_medium || "", nbAlbums: a.nb_album || 0, fans: a.nb_fan || 0 }));
  });
}

// Compositeurs connus d'Open Opus, retrouvés par leur nom de famille
// (5 premières lettres : Rachmaninoff / Rachmaninov / Rakhmaninov).
let composerIndex = null;
async function getComposerIndex() {
  if (composerIndex) return composerIndex;
  const all = await cached("ooall", TTL.ooComposers, async () =>
    ((await oo("/composer/list/name/all.json")).composers || []).map(compactComposer));
  // Nom exact d'abord (Schumann ≠ Schuman), puis préfixe s'il est sans ambiguïté.
  const byLast = new Map(), byPrefix = new Map();
  for (const c of all) {
    const last = norm(c.name).replace(/\s/g, "");
    byLast.set(last, c);
    const k = last.slice(0, 5);
    if (k.length >= 4) byPrefix.set(k, byPrefix.has(k) ? null : c);
  }
  const find = (name) => {
    const words = norm(name).split(" ").filter(Boolean);
    if (!words.length) return null;
    const last = words[words.length - 1], joined = words.join("");
    return byLast.get(last) || byLast.get(joined) || byPrefix.get(last.slice(0, 5)) || byPrefix.get(joined.slice(0, 5)) || null;
  };
  composerIndex = { find };
  return composerIndex;
}

// « Piano Concerto No. 2 in C Minor, Op. 18 : Rachmaninoff: Piano Concerto…: I. Moderato »
// -> { work: "Piano Concerto No. 2 in C Minor, Op. 18", composer: "Rachmaninoff" }
function splitTrackTitle(title) {
  const clean = (x) => x.replace(/\s*[([][^)\]]*[)\]]\s*/g, " ").replace(/\s+/g, " ").trim();
  let work = title, composer = "";
  const dg = title.indexOf(" : ");
  if (dg > 0) {
    work = title.slice(0, dg);
    const rest = title.slice(dg + 3).split(/:\s+/);
    if (rest.length > 1) composer = rest[0];
  } else {
    const segs = title.split(/:\s+/);
    if (segs.length > 1 && segs[0].length < 40 && !/\d/.test(segs[0]) && segs[0].split(" ").length <= 4) composer = segs.shift();
    if (segs.length > 1 && (MOVEMENT_ONLY_RE.test(segs[segs.length - 1]) || /^[ivx]{1,4}\.?\s/i.test(segs[segs.length - 1]))) segs.pop();
    work = segs.join(": ");
  }
  work = work.replace(/\s*[-–]\s*(?:[ivx]{1,4}|\d{1,2})\.\s.*$/i, "");
  return { work: clean(work), composer: clean(composer) };
}

// Œuvres d'un compositeur avec leur signature, pour retrouver une œuvre d'après un titre.
const sigCache = new Map();
async function worksWithSig(composerId) {
  if (sigCache.has(composerId)) return sigCache.get(composerId);
  const { works } = await ooWorks(composerId);
  const list = works.map((w) => ({ w, sig: workSignature(w.title) }));
  sigCache.set(composerId, list);
  return list;
}

// Analyse d'un album d'un interprète : œuvres contenues, compositeur et œuvre
// Open Opus correspondante quand on la reconnaît.
async function analyseAlbum(album, withTracks = false) {
  const idx = await getComposerIndex();
  const albumComposers = album.contributors.map((n) => idx.find(n)).filter(Boolean);
  const single = albumComposers.length === 1 ? albumComposers[0] : null;
  const groups = new Map();
  for (const t of album.tracks) {
    const { work, composer } = splitTrackTitle(t.title);
    if (!work || !/[A-Za-zÀ-ÿ]/.test(work)) continue; // titres sans alphabet latin (rééditions asiatiques)
    const c = (composer && idx.find(composer)) || single || null;
    const key = `${c?.id || composer || "?"}|${normTitle(work)}`;
    if (!groups.has(key)) groups.set(key, { title: work, composer: c, composerName: c?.complete_name || composer || "", tracks: [] });
    groups.get(key).tracks.push({ id: t.id, title: t.title, duration: t.duration });
  }
  const works = [];
  for (const g of groups.values()) {
    let oow = null;
    if (g.composer) {
      try {
        const hit = (await worksWithSig(g.composer.id)).find(({ sig }) => matchesWork(sig, g.title));
        if (hit) oow = hit.w;
      } catch { /* liste d'œuvres indisponible */ }
    }
    works.push({ title: oow?.title || g.title, composer: g.composer, composerName: g.composerName, work: oow, nbTracks: g.tracks.length,
      ...(withTracks ? { tracks: g.tracks } : {}),
      duration: g.tracks.reduce((a, t) => a + (t.duration || 0), 0) });
  }
  return works;
}

// Discographie d'un interprète : tous ses albums, analysés au fur et à mesure.
async function loadArtist(artistId, send, isCancelled) {
  const key = `art:${artistId}`;
  const hit = await cacheGet(key, TTL.workSearch);
  if (hit) {
    send({ kind: "artist", artist: hit.artist });
    send({ kind: "albums", albums: hit.albums });
    send({ kind: "done", cached: true, t: hit.t });
    return;
  }
  const a = await dz(`/artist/${artistId}`, true);
  const artist = { id: a.id, name: a.name, picture: a.picture_medium || "", nbAlbums: a.nb_album || 0, fans: a.nb_fan || 0 };
  send({ kind: "artist", artist });
  const list = [];
  for (let index = 0; index < 2000; index += 100) {
    if (isCancelled()) return;
    const d = await dz(`/artist/${artistId}/albums?limit=100&index=${index}`);
    list.push(...(d.data || []));
    send({ kind: "progress", phase: "list", done: list.length, total: d.total || list.length });
    if (!d.next || !(d.data || []).length) break;
  }
  const albums = [];
  let n = 0;
  for (const it of list) {
    if (isCancelled()) return;
    const full = await dzAlbumFull(it.id);
    send({ kind: "progress", phase: "albums", done: ++n, total: list.length });
    if (!full) continue;
    const { tracks, ...info } = full;
    const entry = { id: String(it.id), album: { ...info, recordType: it.record_type || info.recordType }, works: await analyseAlbum(full) };
    albums.push(entry);
    send({ kind: "albums", albums: [entry] });
  }
  await cacheSet(key, { artist, albums, t: Date.now() });
  send({ kind: "done", cached: false, t: Date.now() });
}

// --- Fiche d'un album ------------------------------------------------------------
// Contenu (œuvres et pistes), interprètes avec leur identifiant Deezer, puis, œuvre
// par œuvre, les détails d'enregistrement MusicBrainz (via l'ISRC d'une piste).
async function trackIsrc(trackId) {
  return cached(`isrcOf:${trackId}`, TTL.dzAlbumFull, async () => (await dz(`/track/${trackId}`, true))?.isrc || "");
}

async function loadAlbumDetail(albumId, send, isCancelled) {
  const full = await dzAlbumFull(albumId);
  if (!full) throw new Error("Album introuvable sur Deezer.");
  const works = await analyseAlbum(full, true);
  const { tracks, ...album } = full;
  send({ kind: "album", album, works, totalDuration: tracks.reduce((a, t) => a + (t.duration || 0), 0), nbTracks: tracks.length });
  for (let i = 0; i < works.length; i++) {
    if (isCancelled()) return;
    let rec = null;
    for (const t of works[i].tracks.slice(0, 2)) {
      const isrc = await trackIsrc(t.id).catch(() => "");
      // Prioritaire : passe devant l'enrichissement en masse de la liste d'origine.
      if (isrc) rec = await mbByIsrc(isrc, true).catch(() => null);
      if (rec) break;
    }
    send({ kind: "rec", index: i, data: rec });
  }
  send({ kind: "done" });
}

// --- Index local de toutes les œuvres d'Open Opus -----------------------------------
// ~220 compositeurs, une requête chacun (en cache 30 jours) : permet de parcourir et
// de combiner instantanément instrument, formation, genre, forme, époque, tonalité.
async function buildWorksIndex(send, isCancelled) {
  const hit = await cacheGet("ooindex", TTL.ooWorks);
  if (hit) { send({ kind: "index", index: hit }); return; }
  const composers = await cached("ooall", TTL.ooComposers, async () =>
    ((await oo("/composer/list/name/all.json")).composers || []).map(compactComposer));
  const works = [];
  let n = 0;
  for (const c of composers) {
    if (isCancelled()) return;
    try {
      const d = await ooWorks(c.id);
      for (const w of d.works) works.push({ ...w, c: c.id });
    } catch { /* compositeur indisponible : ignoré */ }
    send({ kind: "progress", done: ++n, total: composers.length });
  }
  const index = { composers, works, t: Date.now() };
  await cacheSet("ooindex", index);
  send({ kind: "index", index });
}

// Albums classiques du moment sur Deezer (classement du genre Classique).
async function dzClassicalChart() {
  return cached("dzchart98", 6 * 3600 * 1000, async () => {
    const d = await dz("/chart/98/albums?limit=24", true);
    return (d.data || []).map((a) => ({ id: a.id, title: a.title, cover: a.cover_medium || "", artist: a.artist?.name || "" }));
  });
}

// --- Messages ------------------------------------------------------------------
const worksHandlers = {
  dzClassicalChart: () => dzClassicalChart(),
  ooOmni: (msg) => ooOmni(msg.q, msg.offset || 0),
  ooEpoch: (msg) => ooEpoch(msg.epoch),
  dzArtistSearch: (msg) => dzArtistSearch(msg.q),
  ooComposerSearch: (msg) => ooComposerSearch(msg.q),
  ooPopularComposers: () => ooPopularComposers(),
  ooWorks: (msg) => (String(msg.composerId).startsWith("mb:") ? mbWorks(String(msg.composerId).slice(3)) : ooWorks(msg.composerId)),
  mbComposerSearch: (msg) => mbComposerSearch(msg.q),
};

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "index") return;
  let closed = false;
  port.onDisconnect.addListener(() => { closed = true; });
  const send = (m) => { if (!closed) port.postMessage(m); };
  port.onMessage.addListener(async (m) => {
    if (m.cmd !== "build") return;
    try { await buildWorksIndex(send, () => closed); }
    catch (e) { send({ kind: "error", error: String(e.message || e) }); }
  });
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "album") return;
  let closed = false;
  port.onDisconnect.addListener(() => { closed = true; });
  const send = (m) => { if (!closed) port.postMessage(m); };
  port.onMessage.addListener(async (m) => {
    if (m.cmd !== "load") return;
    try { await loadAlbumDetail(m.albumId, send, () => closed); }
    catch (e) { send({ kind: "error", error: String(e.message || e) }); }
  });
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "artist") return;
  let closed = false;
  port.onDisconnect.addListener(() => { closed = true; });
  const send = (m) => { if (!closed) port.postMessage(m); };
  port.onMessage.addListener(async (m) => {
    if (m.cmd !== "load") return;
    try { await loadArtist(m.artistId, send, () => closed); }
    catch (e) { send({ kind: "error", error: String(e.message || e) }); }
  });
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "works") return;
  let closed = false;
  port.onDisconnect.addListener(() => { closed = true; });
  const send = (m) => { if (!closed) port.postMessage(m); };
  let queue = [];
  const done = new Set();
  let running = false;

  async function pump() {
    if (running) return;
    running = true;
    while (queue.length && !closed) {
      const e = queue.shift();
      done.add(e.id);
      try { send({ kind: "enrich", id: e.id, data: await enrichEntry(e) }); }
      catch (err) { send({ kind: "enrich", id: e.id, data: null, error: String(err.message || err) }); }
    }
    running = false;
  }

  port.onMessage.addListener(async (m) => {
    if (m.cmd === "search") {
      try { await searchWork(m.composer, m.work, send, () => closed); }
      catch (e) { send({ kind: "error", error: String(e.message || e) }); }
    } else if (m.cmd === "enrich") {
      // Les demandes prioritaires (résultats affichés) passent devant.
      const fresh = m.entries.filter((e) => !done.has(e.id));
      const ids = new Set(fresh.map((e) => e.id));
      const rest = queue.filter((e) => !ids.has(e.id));
      queue = m.priority ? [...fresh, ...rest] : [...rest, ...fresh];
      pump();
    }
  });
});

// Exposé pour les tests.
self.__testWorks = { workSignature, matchesWork, normTitle, compactRecording, latinName, splitTrackTitle, analyseAlbum, getComposerIndex };
