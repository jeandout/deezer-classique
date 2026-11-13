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

// --- Recherche des enregistrements d'une œuvre sur Deezer --------------------
function compactAlbumFull(a) {
  return {
    id: a.id, title: a.title, cover: a.cover_medium || "", label: a.label || "", upc: a.upc || "",
    date: a.release_date || "", fans: a.fans || 0, nbTracks: a.nb_tracks || 0, recordType: a.record_type || "",
    contributors: (a.contributors || []).map((c) => c.name),
    tracks: (a.tracks?.data || []).map((t) => ({ id: t.id, title: t.title, duration: t.duration || 0, rank: t.rank || 0 })),
  };
}

async function dzAlbumFull(id) {
  return cached(`dzA2:${id}`, TTL.dzAlbumFull, async () => {
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
  const key = `ws5:${work.id}`;
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
    const hay = norm(`${album.contributors.join(" ")} ${album.title} ${trs.map((t) => t.title).join(" ")}`).replace(/\s/g, "");
    if (ck && !hay.includes(ck)) continue; // autre compositeur
    // Toutes les pistes de l'album qui appartiennent à l'œuvre (tous les mouvements),
    // en gardant l'ISRC connu par la recherche.
    const isrcs = new Map(trs.map((t) => [t.id, t.isrc]));
    const fromAlbum = album.tracks.filter((t) => trackMatches(sig, t.title, album.title))
      .map((t) => ({ ...t, isrc: isrcs.get(t.id) || "" }));
    const known = new Set(fromAlbum.map((t) => t.id));
    const all = [...fromAlbum, ...trs.filter((t) => !known.has(t.id))];
    const arrangement = all.some((t) => ARRANGEMENT_RE.test(t.title)) || ARRANGEMENT_RE.test(album.title);
    const { tracks: _drop, ...albumInfo } = album;
    const entry = { id: String(albumId), album: albumInfo, tracks: all, arrangement, rank: Math.max(...all.map((t) => t.rank || 0)) };
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

async function mbByIsrc(isrc) {
  const key = `isrc:${isrc}`;
  const o = (await chrome.storage.local.get(key))[key];
  if (o && Date.now() - o.t < (o.v ? TTL.isrcFound : TTL.isrcNone)) return o.v;
  const d = await mb(`/isrc/${isrc}?inc=artist-rels+place-rels+work-rels`);
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

// --- Messages ------------------------------------------------------------------
const worksHandlers = {
  ooComposerSearch: (msg) => ooComposerSearch(msg.q),
  ooPopularComposers: () => ooPopularComposers(),
  ooWorks: (msg) => (String(msg.composerId).startsWith("mb:") ? mbWorks(String(msg.composerId).slice(3)) : ooWorks(msg.composerId)),
  mbComposerSearch: (msg) => mbComposerSearch(msg.q),
};

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
self.__testWorks = { workSignature, matchesWork, normTitle, compactRecording, latinName };
