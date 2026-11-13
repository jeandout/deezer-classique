// Mode « Œuvres » (interface) : compositeur → œuvres → enregistrements
// disponibles sur Deezer, avec filtres à facettes. Chargé avant content.js,
// qui appelle window.__dzWorks(ctx) pour créer le mode.
window.__dzWorks = function createWorks(ctx) {
  const { h, call, norm, openAlbum, schedule } = ctx;
  const PAGE = 48;

  // --- Vocabulaire ------------------------------------------------------------
  const GENRES = { Orchestral: "Orchestre", Chamber: "Musique de chambre", Keyboard: "Clavier", Vocal: "Vocal", Stage: "Scène" };
  const FORMS = [
    ["concerto", "Concerto"], ["symphon", "Symphonie"], ["sonata", "Sonate"], ["sonatina", "Sonatine"],
    ["quartet", "Quatuor"], ["quintet", "Quintette"], ["trio", "Trio"], ["sextet", "Sextuor"], ["octet", "Octuor"],
    ["prelude", "Prélude"], ["fugue", "Fugue"], ["etude", "Étude"], ["nocturne", "Nocturne"], ["waltz", "Valse"],
    ["mazurka", "Mazurka"], ["polonaise", "Polonaise"], ["ballade", "Ballade"], ["scherzo", "Scherzo"],
    ["impromptu", "Impromptu"], ["variation", "Variations"], ["suite", "Suite"], ["rhapsod", "Rhapsodie"],
    ["overture", "Ouverture"], ["mass", "Messe"], ["requiem", "Requiem"], ["cantata", "Cantate"], ["oratorio", "Oratorio"],
    ["opera", "Opéra"], ["song", "Mélodie / lied"], ["lied", "Mélodie / lied"], ["partita", "Partita"],
    ["fantasi", "Fantaisie"], ["fantasy", "Fantaisie"], ["serenade", "Sérénade"], ["divertimento", "Divertimento"],
    ["toccata", "Toccata"], ["bagatelle", "Bagatelle"], ["intermezzo", "Intermezzo"], ["romance", "Romance"],
    ["vespers", "Vêpres"], ["motet", "Motet"], ["madrigal", "Madrigal"], ["march", "Marche"], ["dance", "Danse"],
    ["poem", "Poème symphonique"], ["ballet", "Ballet"],
  ];
  const INSTRUMENTS = [
    ["piano", "Piano"], ["violin", "Violon"], ["cello", "Violoncelle"], ["viola", "Alto"], ["flute", "Flûte"],
    ["oboe", "Hautbois"], ["clarinet", "Clarinette"], ["bassoon", "Basson"], ["horn", "Cor"], ["trumpet", "Trompette"],
    ["trombone", "Trombone"], ["organ", "Orgue"], ["harpsichord", "Clavecin"], ["guitar", "Guitare"], ["harp", "Harpe"],
    ["string", "Cordes"], ["orchestra", "Orchestre"], ["choir", "Chœur"], ["chorus", "Chœur"], ["soprano", "Voix"],
    ["voice", "Voix"], ["keyboard", "Clavier"],
  ];
  const PLACE_TYPES = {
    Studio: "Studio", "Concert hall / Theatre": "Salle de concert", Venue: "Salle / lieu de concert",
    "Religious building": "Église / lieu de culte", "Indoor arena": "Arène", "Educational institution": "Établissement d'enseignement",
  };
  const ENSEMBLE_RE = /orchest|philharm|symphon|sinfoni|ensemble|quartet|quatuor|quartett|trio\b|choir|chœur|choeur|chor\b|consort|academy|akademie|camerata|players|soloists|solistes|band|filharm|kapelle|concerto (koln|köln|italiano)|baroque|virtuos|staatskapelle|gewandhaus|concertgebouw|chamber/i;
  const titleTags = (title, table) => {
    const t = ` ${norm(title)} `;
    const out = new Set();
    for (const [k, label] of table) if (new RegExp(`\\b${k}`).test(t)) out.add(label);
    return [...out];
  };

  // --- État -------------------------------------------------------------------
  const S = {
    view: "home",                // home | composer | work | omni | epoch | artist
    q: "", results: null, searching: false, popular: null,
    workHits: null, artistHits: null,           // recherche unique : œuvres et interprètes
    omni: null,                                 // œuvres d'un type, tous compositeurs { q, label, results, next, loading }
    epoch: null,                                // { id, label, composers }
    artist: null,                               // discographie d'un interprète
    albumView: null,                            // fiche d'un album { id, preview, album, works, recs, prev }
    labelHits: null,                            // recherche unique : labels
    labelView: null,                            // catalogue d'un ou plusieurs labels
    composer: null, works: null, wf: { text: "", genre: "all", form: null, instrument: null, popularOnly: false },
    work: null, entries: new Map(), enrich: new Map(), progress: null, done: false, error: null, cachedAt: null,
    sel: {}, open: {}, sort: "popular", text: "", shown: PAGE,
    mov: "all",                  // durée prise en compte pour le tempo : "all" ou n° de mouvement
  };
  let port = null, requested = new Set(), lastPrio = "", cards = new Map();
  let artistPort = null, artistCards = new Map(), albumPort = null, labelPort = null, labelCards = new Map();
  const scrollMemo = new Map(); // positions de défilement à retrouver au retour d'une fiche d'album
  let container = null, refs = null, builtKey = "";

  // --- Navigation -------------------------------------------------------------
  function go(view, patch = {}) {
    Object.assign(S, patch, { view });
    // La liste d'origine reste active pendant qu'on consulte une fiche d'album.
    if (view !== "work" && view !== "album" && port) { port.disconnect(); port = null; }
    if (view !== "artist" && view !== "album" && artistPort) { artistPort.disconnect(); artistPort = null; }
    if (view !== "album" && albumPort) { albumPort.disconnect(); albumPort = null; }
    if (view !== "label" && view !== "album" && labelPort) { labelPort.disconnect(); labelPort = null; }
    schedule(true);
  }

  // --- Fiche d'album -----------------------------------------------------------
  function rememberScroll() {
    if (!refs?.root) return;
    scrollMemo.set(builtKey, [...refs.root.querySelectorAll(".w-root, .w-scroll, .w-results, .w-facets")].concat(refs.root)
      .map((el) => [el.className, el.scrollTop]));
  }
  function openAlbumDetail(id, preview) {
    rememberScroll();
    const prev = S.view === "album" ? S.albumView.prev : { view: S.view, key: builtKey };
    if (albumPort) albumPort.disconnect();
    go("album", { albumView: { id: String(id), preview, album: null, works: [], recs: [], done: false, error: null, prev } });
    albumPort = chrome.runtime.connect({ name: "album" });
    const my = albumPort, V = S.albumView;
    my.onMessage.addListener((m) => {
      if (my !== albumPort) return;
      if (m.kind === "album") Object.assign(V, { album: m.album, works: m.works, totalDuration: m.totalDuration, nbTracks: m.nbTracks });
      else if (m.kind === "rec") V.recs[m.index] = m.data || false;
      else if (m.kind === "done") V.done = true;
      else if (m.kind === "error") V.error = m.error;
      schedule();
    });
    my.postMessage({ cmd: "load", albumId: id });
  }
  function backFromAlbum() {
    const prev = S.albumView?.prev;
    if (!prev || prev.view === "album") return go("home");
    restoreKey = prev.key;
    go(prev.view);
  }
  let restoreKey = null;

  // --- Labels ------------------------------------------------------------------
  const LABEL_NOISE_RE = /\b(records?|recordings?|music|musique|musik|label|ltd|limited|inc|gmbh|sa|sarl|llc|co|company|classics?|entertainment|productions?|editions?)\b/g;
  const labelKeyOf = (x) => norm(x).replace(LABEL_NOISE_RE, " ").replace(/\s+/g, " ").trim();
  const sameLabel = (a, b) => { const x = labelKeyOf(a), y = labelKeyOf(b); return !!x && !!y && (x === y || x.includes(y) || y.includes(x)); };
  const NOT_RECORD_LABEL = /publisher|distributor|holding|rights society|manufacturer|bootleg/i;
  // Sous-labels : filiales, marques (imprint), autres noms du même label.
  const isSubLabel = (r) => ((r.type === "label ownership" || r.type === "imprint") && r.direction === "forward") || r.type === "label rename";

  // Label cliqué dans une fiche d'album : identifié par le code-barres de l'album
  // (exact), sinon par son nom.
  async function openLabelFromAlbum(album) {
    const prev = { view: S.view, key: builtKey };
    rememberScroll();
    go("label", { labelView: { ids: [], labels: [], off: [], title: album.label, resolving: true, candidates: null, prev, groups: new Map(),
      matches: new Map(), progress: {}, doneIds: new Set(), sel: {}, open: {}, sort: "date-desc", text: "", shown: PAGE } });
    const V = S.labelView;
    try {
      const byBarcode = album.upc ? await call("labelsByBarcode", { upc: album.upc }) : [];
      const pick = byBarcode.find((l) => sameLabel(l.name, album.label)) || (byBarcode.length === 1 ? byBarcode[0] : null);
      if (pick) return openLabels([pick.id], { prev });
      const byName = await call("searchLabels", { q: album.label });
      const exact = byName.filter((l) => labelKeyOf(l.name) === labelKeyOf(album.label) && !NOT_RECORD_LABEL.test(l.type || ""));
      if (exact.length === 1) return openLabels([exact[0].id], { prev });
      if (S.labelView !== V) return;
      V.resolving = false;
      V.candidates = [...byBarcode, ...byName.filter((l) => !byBarcode.some((b) => b.id === l.id))];
    } catch (e) { V.resolving = false; V.error = e.message; }
    schedule(true);
  }

  // Catalogue d'un ou plusieurs labels. Les sous-labels sont ajoutés (et cochés)
  // automatiquement ; off = labels décochés, affichés pour pouvoir les recocher.
  async function openLabels(ids, { expand = true, off = [], prev } = {}) {
    ids = [...new Set(ids)];
    if (labelPort) { labelPort.disconnect(); labelPort = null; }
    prev = prev || S.labelView?.prev || { view: S.view === "label" ? "home" : S.view, key: builtKey };
    const token = {};
    go("label", { labelView: { ids, labels: ids.map((id) => ({ id, name: "…", relations: [] })), off, infosLoaded: false, expanding: expand,
      prev, token, groups: new Map(), matches: new Map(), progress: {}, doneIds: new Set(), loadDone: !ids.length, error: null,
      sel: {}, open: {}, sort: "date-desc", text: "", shown: PAGE } });
    labelCards = new Map();
    const V = S.labelView;
    const infos = new Map();
    const fetchInfo = async (id) => { try { infos.set(id, await call("labelInfo", { mbid: id })); } catch (e) { V.error = e.message; } };
    await Promise.all(ids.map(fetchInfo));
    if (S.labelView !== V) return;
    if (expand) {
      const subs = new Map();
      for (const id of ids) for (const r of infos.get(id)?.relations || []) {
        if (isSubLabel(r) && !ids.includes(r.id) && !off.some((o) => o.id === r.id)) subs.set(r.id, r);
      }
      await Promise.all([...subs.keys()].map(fetchInfo));
      if (S.labelView !== V) return;
      ids = [...ids, ...subs.keys()];
      V.ids = ids;
    }
    V.labels = ids.map((id) => infos.get(id) || { id, name: id, relations: [] });
    V.infosLoaded = true; V.expanding = false;
    schedule(true);
    if (!ids.length) return;
    labelPort = chrome.runtime.connect({ name: "catalog" });
    const my = labelPort;
    my.onMessage.addListener((m) => {
      if (my !== labelPort) return;
      if (m.kind === "groups") {
        for (const g of m.groups) {
          const ex = V.groups.get(g.id);
          if (!ex) { V.groups.set(g.id, { ...g, releases: [...g.releases] }); continue; }
          const seen = new Set(ex.releases.map((r) => r.id));
          for (const r of g.releases) if (!seen.has(r.id)) ex.releases.push(r);
        }
      } else if (m.kind === "progress") V.progress[m.mbid] = m;
      else if (m.kind === "done") { V.doneIds.add(m.mbid); if (m.cached) V.cachedAt = Math.min(V.cachedAt || Infinity, m.t); V.loadDone = V.doneIds.size === ids.length; }
      else if (m.kind === "match") V.matches.set(m.id, m.result);
      else if (m.kind === "error") V.error = m.error;
      schedule();
    });
    my.postMessage({ cmd: "load", mbids: ids });
    V.requested = new Set(); V.lastPrio = "";
  }

  function toggleLabel(id, name) {
    const V = S.labelView;
    if (V.ids.includes(id)) openLabels(V.ids.filter((x) => x !== id), { expand: false, off: [...V.off, { id, name }], prev: V.prev });
    else openLabels([...V.ids, id], { expand: false, off: V.off.filter((o) => o.id !== id), prev: V.prev });
  }

  // Interprète cliqué : sa page Deezer (par identifiant, sinon par recherche du nom).
  async function openArtistByName(name, id) {
    if (id) return openArtist({ id, name });
    try {
      const hits = await call("dzArtistSearch", { q: name });
      const exact = hits.find((a) => norm(a.name) === norm(name)) || hits[0];
      if (exact) openArtist(exact);
    } catch { /* recherche indisponible */ }
  }

  // Œuvre choisie depuis une autre page (recherche, type d'œuvre, interprète).
  function openWorkOf(composer, work) {
    S.composer = composer;
    S.works = null;
    openWork(work);
  }

  // Œuvres d'un type, tous compositeurs (« concerto pour violon »…). Toutes les
  // pages sont chargées pour que les filtres (époque, compositeur…) portent sur
  // la liste entière.
  async function openOmni(q, label) {
    go("omni", { omni: { q, label: label || `« ${q} »`, results: [], next: 0, loading: true, sel: {}, open: {}, text: "", popularOnly: false } });
    const o = S.omni;
    for (let page = 0; page < 30 && o.next != null; page++) {
      try {
        const d = await call("ooOmni", { q: o.q, offset: o.next });
        if (S.omni !== o) return;
        o.results.push(...d.results);
        o.next = d.next;
      } catch (e) { o.error = e.message; break; }
      schedule();
    }
    o.loading = false; schedule();
  }

  async function openEpoch(id, label) {
    go("epoch", { epoch: { id, label, composers: null } });
    try { S.epoch.composers = await call("ooEpoch", { epoch: id }); } catch (e) { S.epoch.error = e.message; }
    schedule();
  }

  // Discographie d'un interprète, analysée album par album.
  function openArtist(a) {
    if (artistPort) artistPort.disconnect();
    go("artist", { artist: { info: a, albums: new Map(), progress: null, done: false, error: null, cachedAt: null,
      sel: {}, open: {}, sort: "recent", text: "", shown: PAGE } });
    artistCards = new Map();
    artistPort = chrome.runtime.connect({ name: "artist" });
    const my = artistPort, A = S.artist;
    my.onMessage.addListener((m) => {
      if (my !== artistPort) return;
      if (m.kind === "artist") A.info = { ...A.info, ...m.artist };
      else if (m.kind === "albums") for (const al of m.albums) A.albums.set(al.id, al);
      else if (m.kind === "progress") A.progress = m;
      else if (m.kind === "done") { A.done = true; A.cachedAt = m.cached ? m.t : null; }
      else if (m.kind === "error") A.error = m.error;
      schedule();
    });
    my.postMessage({ cmd: "load", artistId: a.id });
  }

  async function openComposer(c) {
    go("composer", { composer: c, works: null, wf: { text: "", genre: "all", form: null, instrument: null, popularOnly: false } });
    try {
      const d = await call("ooWorks", { composerId: c.id });
      if (S.composer !== c) return;
      S.works = d.works.map((w) => ({ ...w, forms: titleTags(w.title, FORMS), instruments: titleTags(`${w.title} ${w.subtitle}`, INSTRUMENTS) }));
      if (d.composer) Object.assign(c, d.composer);
    } catch (e) { S.works = { error: e.message }; }
    schedule();
  }

  function openWork(w) {
    if (port) port.disconnect();
    go("work", {
      work: w, entries: new Map(), enrich: new Map(), progress: null, done: false, error: null, cachedAt: null,
      // Par défaut, seules les versions complètes (les compilations d'extraits sont nombreuses).
      // Les albums douteux (IA, hors classique) sont masqués par défaut, mais comptés dans « Fiabilité ».
      sel: { version: new Set(["Œuvre complète"]), trust: new Set(["Classique"]) }, open: {}, text: "", shown: PAGE, mov: "all",
    });
    requested = new Set(); lastPrio = ""; cards = new Map();
    port = chrome.runtime.connect({ name: "works" });
    const my = port;
    my.onMessage.addListener((m) => {
      if (my !== port) return;
      if (m.kind === "entries") for (const e of m.entries) S.entries.set(e.id, e);
      else if (m.kind === "progress") S.progress = m;
      else if (m.kind === "done") { S.done = true; S.cachedAt = m.cached ? m.t : null; }
      else if (m.kind === "enrich") { S.enrich.set(m.id, m.data); cards.delete(m.id); }
      else if (m.kind === "error") S.error = m.error;
      schedule();
    });
    my.postMessage({ cmd: "search", composer: S.composer, work: w });
  }

  let searchTimer = null;
  function onSearchInput(v) {
    S.q = v;
    clearTimeout(searchTimer);
    if (v.trim().length < 3) { S.results = null; S.workHits = null; S.artistHits = null; S.labelHits = null; schedule(); return; }
    // Deux sources en parallèle : Open Opus (rapide, compositeurs principaux)
    // puis MusicBrainz (tous les autres, tolère les fautes de frappe).
    searchTimer = setTimeout(async () => {
      const token = (S.searchToken = {});
      S.searching = true; S.results = []; schedule();
      const key = (c) => `${norm(c.complete_name)}`.split(" ").pop() + (c.birth || "");
      const merge = (list) => {
        if (S.searchToken !== token) return;
        const seen = new Set(S.results.map(key));
        S.results = [...S.results, ...list.filter((c) => !seen.has(key(c)))];
        schedule();
      };
      S.workHits = null; S.artistHits = null; S.labelHits = null;
      const oo = call("ooComposerSearch", { q: v }).then(merge).catch(() => {});
      const mbz = call("mbComposerSearch", { q: v }).then(merge).catch(() => {});
      // Œuvres de tous les compositeurs et interprètes, en même temps.
      const works = call("ooOmni", { q: v }).then((d) => { if (S.searchToken === token) { S.workHits = d.results; schedule(); } }).catch(() => {});
      const artists = call("dzArtistSearch", { q: v }).then((d) => { if (S.searchToken === token) { S.artistHits = d; schedule(); } }).catch(() => {});
      const labels = call("searchLabels", { q: v }).then((d) => {
        if (S.searchToken !== token) return;
        S.labelHits = d.filter((l) => !NOT_RECORD_LABEL.test(l.type || "") && !/not for release/i.test(l.disambiguation || "")
          && norm(`${l.name} ${l.disambiguation}`).includes(norm(v)));
        schedule();
      }).catch(() => {});
      await Promise.all([oo, mbz, works, artists, labels]);
      if (S.searchToken === token) { S.searching = false; schedule(); }
    }, 350);
  }

  // --- Données dérivées d'un enregistrement -------------------------------------
  const composerKey = () => norm(S.composer?.name || "").replace(/\s/g, "").slice(0, 5);
  let modeTracks = 1;

  // --- Mouvements et durées -------------------------------------------------------
  // « …Op. 30: I. Allegro ma non tanto (Live) » -> { n: 1, name: "Allegro ma non tanto" }
  const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12 };
  function movementOf(title) {
    const clean = (x) => x.replace(/\s*[([][^)\]]*[)\]]\s*/g, " ").replace(/\s+/g, " ").trim();
    const tail = title.split(/\s[:\-–]\s|:\s/).pop();
    let m = tail.match(/^\s*([ivx]{1,4})\.\s*(.*)$/i);
    if (m && ROMAN[m[1].toLowerCase()]) return { n: ROMAN[m[1].toLowerCase()], name: clean(m[2]) };
    m = tail.match(/^\s*(\d{1,2})[.)]\s*(.*)$/);
    if (m) return { n: +m[1], name: clean(m[2]) };
    m = title.match(/[\s,]([IVX]{1,4})\.\s+([^:,]+)$/);
    if (m && ROMAN[m[1].toLowerCase()]) return { n: ROMAN[m[1].toLowerCase()], name: clean(m[2]) };
    return null;
  }
  // Durée de chaque mouvement (n° -> secondes) ; à défaut de numéros, l'ordre des pistes.
  function movementsOf(e) {
    const out = new Map();
    let numbered = true;
    for (const t of e.tracks) {
      const mv = movementOf(t.title);
      if (!mv) { numbered = false; break; }
      if (!out.has(mv.n)) out.set(mv.n, t.duration || 0);
    }
    if (!numbered) {
      out.clear();
      if (e.tracks.length === modeTracks) e.tracks.forEach((t, i) => out.set(i + 1, t.duration || 0));
    }
    return out;
  }
  const ROM = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];
  // Nom le plus fréquent de chaque mouvement (« I. Allegro ma non tanto »).
  function movementLabels() {
    const names = new Map();
    for (const e of S.entries.values()) for (const t of e.tracks) {
      const mv = movementOf(t.title);
      if (!mv || mv.n > modeTracks) continue;
      const m = names.get(mv.n) || new Map();
      const key = mv.name.replace(/\s*,\s*/g, " ").toLowerCase();
      m.set(key, { name: mv.name.replace(/\s*,\s*(?=ma |non )/i, " "), n: (m.get(key)?.n || 0) + 1 });
      names.set(mv.n, m);
    }
    return [...names.entries()].sort((a, b) => a[0] - b[0])
      .map(([n, m]) => [n, `${ROM[n] || n}. ${[...m.values()].sort((a, b) => b.n - a.n)[0].name}`]);
  }
  const fmtDur = (s) => {
    s = Math.round(s);
    const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = String(s % 60).padStart(2, "0");
    return hh ? `${hh}:${String(mm).padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
  };
  const TEMPO = ["Très rapide", "Rapide", "Médian", "Lent", "Très lent"];
  const TEMPO_EDGES = [-0.10, -0.04, 0.04, 0.10]; // écart à la médiane
  const tempoOf = (dev) => TEMPO[TEMPO_EDGES.filter((x) => dev > x).length];
  let tempoStats = null; // { median, min, max, n }

  // Durée retenue pour chaque enregistrement (œuvre entière ou un mouvement),
  // écart à la médiane et tranche de tempo.
  function computeTempo(all) {
    for (const { e, d } of all) {
      const movs = movementsOf(e);
      d.hasMov = S.mov === "all" || movs.has(S.mov);
      let dur = 0;
      if (S.mov === "all") {
        if (d.version[0] === "Œuvre complète") {
          dur = movs.size >= modeTracks ? [...movs.values()].reduce((a, b) => a + b, 0)
            : e.tracks.length === modeTracks ? e.tracks.reduce((a, t) => a + (t.duration || 0), 0) : 0;
        }
      } else dur = movs.get(S.mov) || 0;
      d.dur = e.arrangement ? 0 : dur; // arrangements et adaptations : pas comparables
    }
    // Médiane, puis exclusion des valeurs aberrantes (extrait raccourci, mouvements
    // enchaînés dans une même piste…) : plus de 35 % d'écart.
    let durs = all.map(({ d }) => d.dur).filter(Boolean).sort((a, b) => a - b);
    if (durs.length >= 3) {
      const med = durs[Math.floor(durs.length / 2)];
      for (const { d } of all) if (d.dur && Math.abs(d.dur - med) / med > 0.35) d.dur = 0;
      durs = all.map(({ d }) => d.dur).filter(Boolean).sort((a, b) => a - b);
    }
    tempoStats = durs.length >= 3 ? { median: durs[Math.floor(durs.length / 2)], min: durs[0], max: durs[durs.length - 1], n: durs.length } : null;
    for (const { d } of all) {
      d.dev = tempoStats && d.dur ? (d.dur - tempoStats.median) / tempoStats.median : null;
      d.tempo = d.dev != null ? [tempoOf(d.dev)] : [];
    }
  }

  function derive(e) {
    const mb = S.enrich.get(e.id);
    const ck = composerKey();
    const contrib = e.album.contributors.filter((n) => !norm(n).replace(/\s/g, "").includes(ck) && !/^(various artists|divers|artistes divers|verschiedene)/i.test(n));
    let soloists, instruments = [], conductors, ensembles, guessed = false;
    if (mb) {
      soloists = mb.soloists.map((s) => s.name);
      instruments = mb.soloists.map((s) => s.instrument).filter(Boolean);
      conductors = mb.conductors;
      ensembles = mb.ensembles;
    } else {
      // Sans MusicBrainz : un nom d'ensemble se reconnaît à ses mots-clés ;
      // la personne citée après l'orchestre est en général le chef.
      ensembles = contrib.filter((n) => ENSEMBLE_RE.test(n));
      const persons = contrib.filter((n) => !ENSEMBLE_RE.test(n));
      conductors = [];
      const orch = ensembles.find((n) => /orchest|philharm|symphon|sinfoni|kapelle|gewandhaus|concertgebouw|academy|camerata|chamber/i.test(n));
      if (orch && persons.length > 1) {
        const after = contrib.slice(contrib.indexOf(orch) + 1).filter((n) => persons.includes(n));
        if (after.length) { conductors = [after[after.length - 1]]; guessed = true; }
      }
      soloists = persons.filter((p) => !conductors.includes(p));
    }
    const y = parseInt((mb?.date || e.album.date || "").slice(0, 4), 10);
    return {
      soloists, instruments, conductors, ensembles, guessed,
      label: e.album.label ? [e.album.label] : [],
      decade: y ? [`Années ${Math.floor(y / 10) * 10}`] : [],
      year: y || 0,
      live: mb ? [mb.live ? "Live" : "Studio"] : [],
      placeType: mb?.place ? [PLACE_TYPES[mb.place.type] || mb.place.type || "Autre"] : [],
      place: mb?.place ? [mb.place.name] : [],
      engineers: mb ? mb.engineers : [],
      producers: mb ? mb.producers : [],
      version: [e.arrangement ? "Arrangement / adaptation" : e.tracks.length >= modeTracks ? "Œuvre complète" : "Extrait"],
      trust: [e.suspect?.length ? "Douteux (IA, hors classique…)" : "Classique"],
      mb,
    };
  }

  const FACETS = [
    ["tempo", "Tempo"], ["soloists", "Soliste / interprète"], ["ensembles", "Orchestre / ensemble"], ["conductors", "Chef"],
    ["label", "Label"], ["decade", "Décennie"], ["live", "Live / studio"], ["placeType", "Type de lieu"],
    ["place", "Lieu d'enregistrement"], ["engineers", "Ingénieur du son"], ["producers", "Directeur artistique"],
    ["version", "Version"], ["trust", "Fiabilité"],
  ];

  function computeModeTracks() {
    const counts = new Map();
    for (const e of S.entries.values()) counts.set(e.tracks.length, (counts.get(e.tracks.length) || 0) + 1);
    let best = 1, n = 0;
    for (const [k, v] of counts) if (v > n || (v === n && k > best)) { best = k; n = v; }
    modeTracks = best;
  }

  function filtered(derived, exceptKey) {
    const q = norm(S.text);
    return derived.filter(({ e, d }) => {
      if (d.hasMov === false) return false;
      if (q && !norm(`${e.album.title} ${e.album.contributors.join(" ")} ${e.album.label} ${d.place.join(" ")} ${d.engineers.join(" ")}`).includes(q)) return false;
      for (const [k] of FACETS) {
        if (k === exceptKey) continue;
        const sel = S.sel[k];
        if (sel && sel.size && !d[k].some((v) => sel.has(v))) return false;
      }
      return true;
    });
  }

  function sorted(list) {
    const by = {
      popular: (a, b) => b.e.album.fans - a.e.album.fans,
      recent: (a, b) => b.d.year - a.d.year,
      fast: (a, b) => (a.d.dur || Infinity) - (b.d.dur || Infinity),
      slow: (a, b) => (b.d.dur || -1) - (a.d.dur || -1),
      old: (a, b) => (a.d.year || 9999) - (b.d.year || 9999),
      artist: (a, b) => (a.d.soloists[0] || a.d.ensembles[0] || "~").localeCompare(b.d.soloists[0] || b.d.ensembles[0] || "~"),
    };
    return list.sort(by[S.sort] || by.popular);
  }

  function requestEnrich(ordered) {
    if (!port) return;
    const pending = ordered.filter(({ e }) => !S.enrich.has(e.id)).slice(0, 24).map(({ e }) => e);
    const key = pending.map((e) => e.id).join(",");
    if (key && key !== lastPrio) {
      lastPrio = key;
      pending.forEach((e) => requested.add(e.id));
      port.postMessage({ cmd: "enrich", entries: pending, priority: true });
    }
    const rest = [...S.entries.values()].filter((e) => !requested.has(e.id) && !S.enrich.has(e.id));
    if (rest.length) {
      rest.forEach((e) => requested.add(e.id));
      port.postMessage({ cmd: "enrich", entries: rest, priority: false });
    }
  }

  // --- Rendu ------------------------------------------------------------------
  // Chaque vue est construite une fois, puis mise à jour sur place (patch) :
  // les listes ne sont pas reconstruites et le défilement n'est jamais touché.
  function render(el) {
    container = el;
    const key = {
      work: () => `work:${S.work?.id}`, composer: () => `composer:${S.composer?.id}`, omni: () => `omni:${S.omni?.q}`,
      epoch: () => `epoch:${S.epoch?.id}`, artist: () => `artist:${S.artist?.info?.id}`, home: () => "home",
      album: () => `album:${S.albumView?.id}`,
      label: () => `label:${(S.labelView?.ids || []).join(",")}|${(S.labelView?.off || []).map((o) => o.id).join(",")}|${S.labelView?.infosLoaded}|${!!S.labelView?.candidates}`,
    }[S.view]();
    const views = {
      home: [buildHome, patchHome], composer: [buildComposer, patchComposer], work: [buildWork, patchWork],
      omni: [buildOmni, patchOmni], epoch: [buildEpoch, patchEpoch], artist: [buildArtist, patchArtist],
      album: [buildAlbum, patchAlbum], label: [buildLabel, patchLabel],
    };
    if (key !== builtKey || !refs || !container.contains(refs.root)) {
      builtKey = key;
      refs = { root: h("div", { class: "w-root" }) };
      views[S.view][0](refs);
      container.replaceChildren(refs.root);
      views[S.view][1](refs);
      // Retour d'une fiche d'album : on retrouve la liste au même endroit.
      if (restoreKey === key && scrollMemo.has(key)) {
        const saved = scrollMemo.get(key);
        const els = [...refs.root.querySelectorAll(".w-root, .w-scroll, .w-results, .w-facets")].concat(refs.root);
        els.forEach((el, i) => { if (saved[i] && saved[i][0] === el.className) el.scrollTop = saved[i][1]; });
      }
      restoreKey = null;
      return;
    }
    views[S.view][1](refs);
  }

  function crumbs(...items) {
    return h("nav", { class: "w-crumbs" }, items.map((it, i) => [
      i ? h("span", { class: "sep" }, "›") : null,
      it.onclick ? h("button", { class: "link", onclick: it.onclick }, it.label) : h("span", { class: "cur" }, it.label),
    ]));
  }

  // --- Accueil : recherche unique (compositeurs, œuvres, interprètes) + raccourcis ---
  const TYPE_SHORTCUTS = [
    ["Concertos pour piano", "piano concerto"], ["Concertos pour violon", "violin concerto"],
    ["Concertos pour violoncelle", "cello concerto"], ["Symphonies", "symphony"], ["Quatuors à cordes", "string quartet"],
    ["Sonates pour piano", "piano sonata"], ["Sonates pour violon", "violin sonata"], ["Trios avec piano", "piano trio"],
    ["Quintettes", "quintet"], ["Requiem", "requiem"], ["Messes", "missa"], ["Opéras", "opera"], ["Ballets", "ballet"],
    ["Préludes", "prelude"], ["Nocturnes", "nocturne"], ["Variations", "variations"], ["Cantates", "cantata"],
  ];
  const EPOCHS = [
    ["Medieval", "Médiéval"], ["Renaissance", "Renaissance"], ["Baroque", "Baroque"], ["Classical", "Classique"],
    ["Early Romantic", "Premier romantisme"], ["Romantic", "Romantique"], ["Late Romantic", "Romantisme tardif"],
    ["20th Century", "XXᵉ siècle"], ["Post-War", "Après-guerre"], ["21st Century", "XXIᵉ siècle"],
  ];
  const EPOCH_FR = Object.fromEntries(EPOCHS);

  const year4 = (d) => (d || "").slice(0, 4);

  function buildHome(r) {
    r.results = h("div", { class: "w-sections" });
    r.popular = h("div", { class: "w-composers" });
    r.root.append(h("div", { class: "w-scroll" },
      h("h2", {}, "Rechercher"),
      h("input", { type: "search", class: "w-big", placeholder: "Compositeur, œuvre, interprète ou label : Rachmaninov, concerto pour violon, Trifonov, Chandos…",
        value: S.q, oninput: (e) => onSearchInput(e.target.value) }),
      r.results,
      h("h3", {}, "Par type d'œuvre"),
      h("div", { class: "chips" }, TYPE_SHORTCUTS.map(([label, q]) => h("button", { class: "chip", onclick: () => openOmni(q, label) }, label))),
      h("h3", {}, "Par époque"),
      h("div", { class: "chips" }, EPOCHS.map(([id, label]) => h("button", { class: "chip", onclick: () => openEpoch(id, label) }, label))),
      h("h3", {}, "Compositeurs populaires"),
      r.popular,
      // Réglages propres à l'extension ou à l'application web.
      ctx.homeFooter ? ctx.homeFooter() : h("label", { class: "pref small muted" },
        h("input", { type: "checkbox", checked: ctx.prefs().inApp !== false, onchange: (e) => ctx.setPref("inApp", e.target.checked) }),
        " Ouvrir les albums sans recharger la page (décochez si un clic sur un album ne fait rien)")));
    if (!S.popular) call("ooPopularComposers").then((p) => { S.popular = p; schedule(); }).catch(() => {});
    setTimeout(() => r.root.querySelector("input")?.focus({ preventScroll: true }), 0);
  }
  function composerCard(c) {
    const img = h("img", { src: c.portrait, alt: "", loading: "lazy" });
    img.addEventListener("error", () => img.replaceWith(h("div", { class: "ph" }, (c.name || "?")[0])));
    return h("button", { class: "w-composer", onclick: () => openComposer(c) },
      c.portrait ? img : h("div", { class: "ph" }, (c.name || "?")[0]),
      h("div", {}, h("div", { class: "strong" }, c.complete_name || c.name),
        h("div", { class: "muted small" }, [c.birth && `${c.birth}–${c.death || ""}`, EPOCH_FR[c.epoch] || c.epoch, c.source === "mb" ? "MusicBrainz" : ""].filter(Boolean).join(" · "))));
  }
  function artistCard(a) {
    const img = h("img", { src: a.picture, alt: "", loading: "lazy" });
    img.addEventListener("error", () => img.replaceWith(h("div", { class: "ph" }, (a.name || "?")[0])));
    return h("button", { class: "w-composer", onclick: () => openArtist(a) },
      a.picture ? img : h("div", { class: "ph" }, (a.name || "?")[0]),
      h("div", {}, h("div", { class: "strong" }, a.name),
        h("div", { class: "muted small" }, `${a.nbAlbums} album${a.nbAlbums > 1 ? "s" : ""} sur Deezer`)));
  }
  function workRow(c, w) {
    return h("button", { class: "w-work", onclick: () => openWorkOf(c, w) },
      h("div", {}, h("div", { class: "strong" }, w.title, w.popular ? h("span", { class: "star", title: "Œuvre populaire (selon Open Opus)" }, " ★") : ""),
        h("div", { class: "muted small" }, c.complete_name || c.name, w.subtitle ? ` · ${w.subtitle}` : "")),
      w.genre ? h("span", { class: "tag" }, GENRES[w.genre] || w.genre) : "");
  }
  function patchHome(r) {
    const searching = Array.isArray(S.results);
    const section = (title, body, more) => h("section", { class: "w-section" }, h("div", { class: "w-section-head" }, h("h3", {}, title), more || ""), body);
    r.results.replaceChildren(...[
      searching && S.results.length ? section("Compositeurs", h("div", { class: "w-composers" }, S.results.map(composerCard))) : "",
      searching && S.workHits?.length ? section("Œuvres", h("div", { class: "w-works" }, S.workHits.slice(0, 8).map((x) => workRow(x.composer, x.work))),
        S.workHits.length > 8 || S.workHits.length === 20 ? h("button", { class: "link small", onclick: () => openOmni(S.q.trim()) }, "toutes les œuvres →") : "") : "",
      searching && S.artistHits?.length ? section("Interprètes", h("div", { class: "w-composers" }, S.artistHits.slice(0, 6).map(artistCard))) : "",
      searching && S.labelHits?.length ? section("Labels", h("div", { class: "w-works" }, S.labelHits.slice(0, 6).map((l) =>
        h("button", { class: "w-work", onclick: () => openLabels([l.id]) },
          h("div", {}, h("div", { class: "strong" }, l.name), h("div", { class: "muted small" }, [l.disambiguation, l.type, l.country, l.begin && year4(l.begin)].filter(Boolean).join(" · "))),
          h("span", { class: "tag" }, "Label"))))) : "",
      S.searching ? h("div", { class: "muted small" }, "Recherche…") : "",
      searching && !S.searching && !S.results.length && !S.workHits?.length && !S.artistHits?.length && !S.labelHits?.length ? h("div", { class: "muted" }, "Aucun résultat.") : "",
    ].flat());
    if (r.popular.childElementCount !== (S.popular || []).length) r.popular.replaceChildren(...(S.popular || []).map(composerCard));
  }

  // --- Œuvres d'un type, tous compositeurs, avec filtres --------------------------
  const EPOCH_ORDER = EPOCHS.map(([id]) => id);
  const OMNI_FACETS = [["epoch", "Époque"], ["composer", "Compositeur"], ["genre", "Genre"], ["instrument", "Instrument"]];
  const omniValues = (x) => ({
    epoch: [EPOCH_FR[x.composer.epoch] || x.composer.epoch].filter(Boolean),
    composer: [x.composer.complete_name || x.composer.name],
    genre: [GENRES[x.work.genre] || x.work.genre].filter(Boolean),
    instrument: titleTags(`${x.work.title} ${x.work.subtitle}`, INSTRUMENTS),
  });

  function buildOmni(r) {
    const o = S.omni;
    r.status = h("div", { class: "muted small" });
    r.facets = h("div", { class: "w-facets-body" });
    r.list = h("div", { class: "w-works" });
    r.tail = h("div", { class: "tail" });
    r.count = h("span", { class: "muted small" });
    r.filterBtn = h("button", { class: "btn w-filter-btn", onclick: () => r.root.classList.add("show-filters") }, "Filtres");
    r.root.append(
      h("div", { class: "w-workhead" },
        crumbs({ label: "Accueil", onclick: () => go("home") }, { label: o.label }),
        h("h2", {}, o.label), r.status),
      h("div", { class: "w-cols" },
        h("aside", { class: "w-facets" },
          h("div", { class: "w-facets-head" }, h("span", { class: "strong" }, "Filtres"),
            h("button", { class: "btn primary", onclick: () => r.root.classList.remove("show-filters") }, "Voir les résultats")),
          r.facets),
        h("section", { class: "w-results" },
          h("div", { class: "w-toolbar" },
            r.filterBtn,
            h("input", { type: "search", placeholder: "Filtrer : titre, compositeur, op. …", value: o.text,
              oninput: (e) => { o.text = e.target.value; patchOmni(r); } }),
            h("label", { class: "small" }, h("input", { type: "checkbox", checked: o.popularOnly,
              onchange: (e) => { o.popularOnly = e.target.checked; patchOmni(r); } }), " Populaires et recommandées"),
            r.count),
          r.list, r.tail)));
  }

  function patchOmni(r) {
    const o = S.omni;
    const all = o.results.map((x) => ({ x, v: omniValues(x) }));
    const q = norm(o.text);
    const pass = ({ x, v }, except) => {
      if (o.popularOnly && !x.work.popular && !x.work.recommended) return false;
      if (q && !norm(`${x.work.title} ${x.work.subtitle} ${x.composer.complete_name}`).includes(q)) return false;
      for (const [k] of OMNI_FACETS) {
        if (k === except) continue;
        const sel = o.sel[k];
        if (sel?.size && !v[k].some((val) => sel.has(val))) return false;
      }
      return true;
    };
    r.status.textContent = o.loading ? `Chargement des œuvres… ${o.results.length}` : `${o.results.length} œuvres de ${new Set(o.results.map((x) => x.composer.id)).size} compositeurs (Open Opus)`;
    r.facets.replaceChildren(...OMNI_FACETS.map(([k, label]) => {
      const counts = new Map();
      for (const it of all) if (pass(it, k)) for (const val of it.v[k]) counts.set(val, (counts.get(val) || 0) + 1);
      const sel = o.sel[k] || new Set();
      for (const val of sel) if (!counts.has(val)) counts.set(val, 0);
      if (!counts.size) return "";
      const items = [...counts.entries()].sort(k === "epoch"
        ? (a, b) => EPOCH_ORDER.indexOf(EPOCHS.find(([, fr]) => fr === a[0])?.[0]) - EPOCH_ORDER.indexOf(EPOCHS.find(([, fr]) => fr === b[0])?.[0])
        : (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      const limit = o.open[k] || k === "epoch" ? items.length : 8;
      return h("div", { class: "w-facet" },
        h("div", { class: "w-facet-title" }, label, sel.size ? h("button", { class: "link small", onclick: () => { o.sel[k] = new Set(); patchOmni(r); } }, "effacer") : ""),
        items.filter(([val], i) => i < limit || sel.has(val)).map(([val, n]) => h("label", { class: `w-opt${sel.has(val) ? " on" : ""}` },
          h("input", { type: "checkbox", checked: sel.has(val), onchange: (e) => {
            const set = o.sel[k] || (o.sel[k] = new Set());
            e.target.checked ? set.add(val) : set.delete(val);
            patchOmni(r);
          } }),
          h("span", { class: "v" }, val), h("span", { class: "n" }, n))),
        items.length > limit || o.open[k] ? (items.length > 8 && k !== "epoch" ? h("button", { class: "link small", onclick: () => { o.open[k] = !o.open[k]; patchOmni(r); } }, o.open[k] ? "moins" : `+ ${items.length - 8} autres`) : "") : "");
    }));
    // Ordre : époque, puis compositeur, puis titre.
    const list = all.filter((it) => pass(it)).sort((a, b) =>
      (EPOCH_ORDER.indexOf(a.x.composer.epoch) - EPOCH_ORDER.indexOf(b.x.composer.epoch))
      || (a.x.composer.name || "").localeCompare(b.x.composer.name || "")
      || a.x.work.title.localeCompare(b.x.work.title, undefined, { numeric: true }));
    const active = Object.values(o.sel).reduce((n, set) => n + (set?.size || 0), 0);
    r.filterBtn.textContent = active ? `Filtres (${active})` : "Filtres";
    r.count.textContent = `${list.length} œuvre${list.length > 1 ? "s" : ""}`;
    const key = list.map((it) => it.x.work.id).join(",");
    if (r.list.dataset.key !== key) { r.list.dataset.key = key; r.list.replaceChildren(...list.map((it) => workRow(it.x.composer, it.x.work))); }
    r.tail.replaceChildren(
      o.error ? h("div", { class: "error" }, o.error) : "",
      !o.loading && !list.length ? h("div", { class: "muted empty" }, o.results.length ? "Aucune œuvre ne correspond à ces filtres." : "Aucune œuvre trouvée.") : "");
  }

  // --- Compositeurs d'une époque -------------------------------------------------
  function buildEpoch(r) {
    r.list = h("div", { class: "w-composers" });
    r.root.append(h("div", { class: "w-scroll" },
      crumbs({ label: "Accueil", onclick: () => go("home") }, { label: S.epoch.label }),
      h("h2", {}, S.epoch.label), r.list));
  }
  function patchEpoch(r) {
    const e = S.epoch;
    if (e.error) r.list.replaceChildren(h("div", { class: "error" }, e.error));
    else if (!e.composers) r.list.replaceChildren(h("div", { class: "muted" }, "Chargement…"));
    else if (r.list.childElementCount !== e.composers.length) r.list.replaceChildren(...e.composers.map(composerCard));
  }

  // Compositeur : liste de ses œuvres, filtrable par genre, forme, instrument.
  function buildComposer(r) {
    const c = S.composer;
    r.chips = h("div", { class: "w-chiprows" });
    r.list = h("div", { class: "w-works" });
    r.count = h("span", { class: "muted small" });
    r.root.append(h("div", { class: "w-scroll" },
      crumbs({ label: "Accueil", onclick: () => go("home") }, { label: c.complete_name || c.name }),
      h("div", { class: "w-composer-head" },
        c.portrait ? h("img", { src: c.portrait, alt: "" }) : null,
        h("div", {}, h("h2", {}, c.complete_name || c.name),
          h("div", { class: "muted" }, [c.birth && `${c.birth}–${c.death || ""}`, c.epoch].filter(Boolean).join(" · ")))),
      h("div", { class: "w-toolbar" },
        h("input", { type: "search", placeholder: "Filtrer les œuvres : concerto, op. 18, sonate…", value: S.wf.text,
          oninput: (e) => { S.wf.text = e.target.value; patchComposer(r); } }),
        h("label", { class: "small" }, h("input", { type: "checkbox", checked: S.wf.popularOnly,
          onchange: (e) => { S.wf.popularOnly = e.target.checked; patchComposer(r); } }), " Œuvres populaires et recommandées"),
        h("span", { class: "muted small", title: "Selon Open Opus. « Recommandée » : œuvre jugée essentielle, sans étoile." }, "★ = œuvre populaire"),
        r.count),
      r.chips, r.list));
  }
  function patchComposer(r) {
    if (!S.works) {
      r.list.replaceChildren(h("div", { class: "muted" }, S.composer?.source === "mb"
        ? "Chargement des œuvres depuis MusicBrainz (quelques secondes la première fois)…" : "Chargement des œuvres…"));
      return;
    }
    if (S.works.error) { r.list.replaceChildren(h("div", { class: "error" }, S.works.error)); return; }
    const f = S.wf, q = norm(f.text);
    const pass = (w, except) =>
      (except === "genre" || f.genre === "all" || (w.genre || "Autre") === f.genre) &&
      (except === "form" || !f.form || w.forms.includes(f.form)) &&
      (except === "instrument" || !f.instrument || w.instruments.includes(f.instrument)) &&
      (!f.popularOnly || w.popular || w.recommended) &&
      (!q || norm(`${w.title} ${w.subtitle}`).includes(q));
    const countBy = (except, get) => {
      const m = new Map();
      for (const w of S.works) if (pass(w, except)) for (const v of get(w)) m.set(v, (m.get(v) || 0) + 1);
      return [...m.entries()].sort((a, b) => b[1] - a[1]);
    };
    const chipRow = (title, key, entries, labelOf = (v) => v) => entries.length ? h("div", { class: "w-chiprow" },
      h("span", { class: "muted small lbl" }, title),
      [["__all", null]].concat(entries).map(([v, n]) => {
        const val = v === "__all" ? (key === "genre" ? "all" : null) : v;
        const on = f[key] === val;
        return h("button", { class: `chip${on ? " sel" : ""}`, onclick: () => { f[key] = val; patchComposer(r); } },
          v === "__all" ? "Tous" : `${labelOf(v)} `, v === "__all" ? "" : h("span", { class: "n" }, n));
      })) : "";
    r.chips.replaceChildren(
      chipRow("Genre", "genre", countBy("genre", (w) => [w.genre || "Autre"]), (v) => GENRES[v] || v),
      chipRow("Forme", "form", countBy("form", (w) => w.forms).slice(0, 16)),
      chipRow("Instrument", "instrument", countBy("instrument", (w) => w.instruments).slice(0, 14)));
    const list = S.works.filter((w) => pass(w))
      .sort((a, b) => (b.popular + b.recommended) - (a.popular + a.recommended) || a.title.localeCompare(b.title, undefined, { numeric: true }));
    r.count.textContent = `${list.length} œuvre${list.length > 1 ? "s" : ""}`;
    r.list.replaceChildren(...list.map((w) => h("button", { class: "w-work", onclick: () => openWork(w) },
      h("div", {}, h("div", { class: "strong" }, w.title, w.popular ? h("span", { class: "star", title: "Œuvre populaire : parmi les plus jouées et les plus connues du compositeur (selon Open Opus)" }, " ★") : ""),
        w.subtitle ? h("div", { class: "muted small" }, w.subtitle) : ""),
      w.genre ? h("span", { class: "tag" }, GENRES[w.genre] || w.genre) : "")));
  }

  // Œuvre : enregistrements disponibles sur Deezer + facettes.
  function buildWork(r) {
    const c = S.composer, w = S.work;
    r.status = h("div", { class: "w-status" });
    // Filtres : colonne de gauche ; sur écran étroit, panneau qui glisse depuis le bas.
    r.facets = h("div", { class: "w-facets-body" });
    r.filterBtn = h("button", { class: "btn w-filter-btn", onclick: () => r.root.classList.add("show-filters") }, "Filtres");
    const facetsBox = h("aside", { class: "w-facets" },
      h("div", { class: "w-facets-head" }, h("span", { class: "strong" }, "Filtres"),
        h("button", { class: "btn primary", onclick: () => r.root.classList.remove("show-filters") }, "Voir les résultats")),
      r.facets);
    r.grid = h("div", { class: "grid w-grid" });
    r.tail = h("div", { class: "tail" });
    r.count = h("span", { class: "muted small" });
    r.root.append(
      h("div", { class: "w-workhead" },
        crumbs({ label: "Accueil", onclick: () => go("home") }, { label: c.complete_name || c.name, onclick: () => (S.works ? go("composer") : openComposer(c)) }, { label: w.title }),
        h("h2", {}, w.title), r.movs = h("div", { class: "w-movs" }), r.status),
      h("div", { class: "w-cols" },
        facetsBox,
        h("section", { class: "w-results" },
          h("div", { class: "w-toolbar" },
            r.filterBtn,
            h("input", { type: "search", placeholder: "Filtrer : interprète, orchestre, label, lieu…", value: S.text,
              oninput: (e) => { S.text = e.target.value; S.shown = PAGE; patchWork(r); } }),
            h("span", { class: "select" }, h("select", { onchange: (e) => { S.sort = e.target.value; patchWork(r); } },
              [["popular", "Popularité"], ["fast", "Plus rapide"], ["slow", "Plus lent"], ["recent", "Plus récents"], ["old", "Plus anciens"], ["artist", "Interprète"]]
                .map(([v, t]) => h("option", { value: v, selected: S.sort === v }, t)))),
            r.count),
          r.grid, r.tail)));
  }

  function selectMovement(r, v) {
    if (S.mov === v) return;
    if (v !== "all" && S.mov === "all") { S.savedVersion = S.sel.version; S.sel.version = new Set(); }
    if (v === "all") S.sel.version = S.savedVersion || new Set(["Œuvre complète"]);
    S.mov = v;
    S.sel.tempo = new Set();
    S.shown = PAGE;
    patchWork(r);
  }

  function patchWork(r) {
    computeModeTracks();
    const all = [...S.entries.values()].map((e) => ({ e, d: derive(e) }));
    // Aucune version complète trouvée : on ne masque pas tout.
    if (S.done && S.sel.version?.has("Œuvre complète") && S.sel.version.size === 1 && !all.some(({ d }) => d.version[0] === "Œuvre complète")) S.sel.version = new Set();
    const enriched = [...S.enrich.values()];
    const p = S.progress;
    const nMb = enriched.filter(Boolean).length;
    const phase = !S.done
      ? `Recherche sur Deezer… ${p ? (p.phase === "deezer" ? "pistes" : `albums ${p.done}/${p.total}`) : ""}`
      : `${all.length} enregistrement${all.length > 1 ? "s" : ""} sur Deezer`;
    const mbLine = S.done && all.length
      ? (S.enrich.size < all.length ? ` · détails MusicBrainz ${S.enrich.size}/${all.length} (${nMb} trouvés)` : ` · détails MusicBrainz pour ${nMb} sur ${all.length}`)
      : "";
    const bar = h("div", { class: "bar" }, h("div"));
    const frac = !S.done ? (p ? p.done / Math.max(1, p.total) : 0) : S.enrich.size / Math.max(1, all.length);
    bar.firstChild.style.width = `${Math.round(100 * Math.min(1, frac))}%`;
    r.status.replaceChildren(h("div", { class: "muted small" }, phase, mbLine,
      S.cachedAt ? ` · résultats du ${new Date(S.cachedAt).toLocaleDateString()}` : ""),
      S.error ? h("div", { class: "error" }, S.error) : "",
      (!S.done || S.enrich.size < all.length) ? bar : "");

    // Mouvements : « Œuvre entière » ou un mouvement précis. Un mouvement choisi
    // affiche tous les enregistrements qui le contiennent (extraits compris) et
    // sert de référence pour le tempo.
    const labels = modeTracks >= 2 && modeTracks <= 12 ? movementLabels() : [];
    if (S.mov !== "all" && labels.length && !labels.some(([n]) => n === S.mov)) S.mov = "all";
    const movKey = `${labels.map((l) => l.join(":")).join("|")}#${S.mov}`;
    if (r.movs.dataset.key !== movKey) {
      r.movs.dataset.key = movKey;
      const chip = (v, label) => h("button", { class: `chip${S.mov === v ? " sel" : ""}`, onclick: () => selectMovement(r, v) }, label);
      r.movs.replaceChildren(...(labels.length ? [chip("all", "Œuvre entière"), ...labels.map(([n, l]) => chip(n, l))] : []));
    }
    computeTempo(all);

    // Facettes : nombre de résultats par valeur, compte tenu des autres filtres.
    r.facets.replaceChildren(...FACETS.map(([k, label]) => {
      const counts = new Map();
      for (const { d } of filtered(all, k)) for (const v of new Set(d[k])) counts.set(v, (counts.get(v) || 0) + 1);
      const sel = S.sel[k] || new Set();
      for (const v of sel) if (!counts.has(v)) counts.set(v, 0);
      if (!counts.size) return "";
      const items = k === "tempo"
        ? [...counts.entries()].sort((a, b) => TEMPO.indexOf(a[0]) - TEMPO.indexOf(b[0]))
        : [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      const limit = S.open[k] || k === "tempo" ? items.length : 6;
      const shown = items.filter(([v], i) => i < limit || sel.has(v));
      // Tranches de tempo : bornes en minutes:secondes, d'après la médiane.
      const hint = (v) => {
        if (k !== "tempo" || !tempoStats) return "";
        const i = TEMPO.indexOf(v), m = tempoStats.median;
        const lo = i > 0 ? fmtDur(m * (1 + TEMPO_EDGES[i - 1])) : "", hi = i < 4 ? fmtDur(m * (1 + TEMPO_EDGES[i])) : "";
        return lo && hi ? `${lo}–${hi}` : lo ? `> ${lo}` : `< ${hi}`;
      };
      return h("div", { class: "w-facet" },
        h("div", { class: "w-facet-title" }, k === "tempo" ? `Tempo (${S.mov === "all" ? "œuvre entière" : `mouvement ${S.mov}`})` : label,
          sel.size ? h("button", { class: "link small", onclick: () => { S.sel[k] = new Set(); S.shown = PAGE; patchWork(r); } }, "effacer") : ""),
        k === "tempo" && tempoStats ? h("div", { class: "muted small w-tempo-stats" },
          `Médiane ${fmtDur(tempoStats.median)} · de ${fmtDur(tempoStats.min)} à ${fmtDur(tempoStats.max)} (${tempoStats.n} versions)`) : "",
        shown.map(([v, n]) => h("label", { class: `w-opt${sel.has(v) ? " on" : ""}` },
          h("input", { type: "checkbox", checked: sel.has(v), onchange: (e) => {
            const s = S.sel[k] || (S.sel[k] = new Set());
            e.target.checked ? s.add(v) : s.delete(v);
            S.shown = PAGE;
            patchWork(r);
          } }),
          h("span", { class: "v" }, v, hint(v) ? h("span", { class: "muted small" }, ` ${hint(v)}`) : ""), h("span", { class: "n" }, n))),
        items.length > 6 ? h("button", { class: "link small", onclick: () => { S.open[k] = !S.open[k]; patchWork(r); } },
          S.open[k] ? "moins" : `+ ${items.length - 6} autres`) : "");
    }));

    const active = Object.values(S.sel).reduce((n, set) => n + (set?.size || 0), 0);
    r.filterBtn.textContent = active ? `Filtres (${active})` : "Filtres";
    const list = sorted(filtered(all));
    requestEnrich(list);
    r.count.textContent = `${list.length} résultat${list.length > 1 ? "s" : ""}`;
    const visible = list.slice(0, S.shown);
    reconcile(r.grid, visible.map(cardFor));
    r.tail.replaceChildren(
      !visible.length && S.done ? h("div", { class: "muted empty" }, all.length ? "Aucun enregistrement ne correspond à ces filtres." : "Aucun enregistrement trouvé sur Deezer pour cette œuvre.") : "",
      list.length > S.shown ? h("button", { class: "btn more", onclick: () => { S.shown += PAGE; patchWork(r); } }, `Afficher plus (${list.length - S.shown} restants)`) : "");
  }

  function reconcile(parent, els) {
    const wanted = new Set(els);
    for (const c of [...parent.children]) if (!wanted.has(c)) c.remove();
    els.forEach((el, i) => { if (parent.children[i] !== el) parent.insertBefore(el, parent.children[i] || null); });
  }

  const pct = (dev) => {
    const p = Math.round(dev * 100);
    return p === 0 ? "0 %" : `${p > 0 ? "+" : "−"}${Math.abs(p)} %`;
  };

  // Bouton ▶ : écouter l'album dans Deezer (sans ouvrir la fiche).
  function playButton(id, big) {
    return h("a", { class: `w-play${big ? " big" : ""}`, href: ctx.albumUrl(id), target: ctx.albumTarget || null, rel: ctx.albumTarget ? "noopener" : null,
      title: "Écouter sur Deezer", "aria-label": "Écouter sur Deezer",
      onclick: (ev) => { ev.stopPropagation(); openAlbum(id, ev); } }, big ? "▶  Écouter sur Deezer" : "▶");
  }

  function cardFor({ e, d }) {
    let el = cards.get(e.id);
    if (!el) { el = card(e, d); cards.set(e.id, el); }
    // Durée et écart à la médiane : mis à jour sans reconstruire la carte.
    const txt = d.dur ? `⏱ ${S.mov === "all" ? "" : `${ROM[S.mov] || S.mov}. `}${fmtDur(d.dur)}${d.dev != null ? ` · ${pct(d.dev)}` : ""}` : "";
    if (el._dur.textContent !== txt) el._dur.textContent = txt;
    return el;
  }

  function card(e, d) {
    const a = e.album;
    const cover = a.cover ? h("img", { src: a.cover, alt: "", loading: "lazy" }) : h("div", { class: "ph" }, (a.title || "?")[0]);
    const solo = d.mb ? d.mb.soloists.map((s) => s.name + (s.instrument ? ` (${s.instrument})` : "")) : d.soloists;
    const line2 = [d.ensembles.join(", "), d.conductors.length ? `dir. ${d.conductors.join(", ")}${d.guessed ? " ?" : ""}` : ""].filter(Boolean).join(" · ");
    const meta = [d.year || "", a.label].filter(Boolean).join(" · ");
    const dur = h("div", { class: "m dur" });
    const rec = d.mb ? [d.mb.live ? "Live" : "", d.mb.place ? d.mb.place.name : "", d.mb.engineers.length ? `ing. ${d.mb.engineers.join(", ")}` : ""].filter(Boolean).join(" · ") : "";
    const el = h("div", { class: "item", role: "button", tabindex: "0", title: `${a.title}\n${a.contributors.join(", ")}\n(cliquez pour la fiche de l'album)`,
      onclick: () => openAlbumDetail(a.id, a), onkeydown: (ev) => { if (ev.key === "Enter") openAlbumDetail(a.id, a); } },
      h("div", { class: "cover" }, cover, playButton(a.id), e.suspect?.length
        ? h("span", { class: "w-badge warn", title: `Album douteux : ${e.suspect.join(" · ")}` }, "Douteux")
        : d.version[0] !== "Œuvre complète" ? h("span", { class: "w-badge" }, d.version[0] === "Extrait" ? `Extrait (${e.tracks.length}/${modeTracks})` : "Arrangement") : ""),
      h("div", { class: "t" }, a.title),
      solo.length ? h("div", { class: "a" }, solo.join(", ")) : "",
      line2 ? h("div", { class: "a" }, line2) : "",
      h("div", { class: "m" }, meta),
      rec ? h("div", { class: "m rec" }, rec) : "",
      e.suspect?.length ? h("div", { class: "m warn" }, `⚠ ${e.suspect.join(" · ")}`) : "",
      dur);
    el._dur = dur;
    return el;
  }

  // --- Interprète : discographie analysée, filtrable --------------------------------
  const RECORD_TYPES = { album: "Album", single: "Single", ep: "EP", compile: "Compilation" };

  function deriveAlbum(al) {
    const y = parseInt((al.album.date || "").slice(0, 4), 10);
    const works = al.works || [];
    return {
      composer: [...new Set(works.map((w) => w.composer?.complete_name || w.composerName).filter(Boolean))],
      genre: [...new Set(works.map((w) => w.work?.genre).filter(Boolean).map((g) => GENRES[g] || g))],
      form: [...new Set(works.flatMap((w) => titleTags(w.title, FORMS)))],
      decade: y ? [`Années ${Math.floor(y / 10) * 10}`] : [],
      label: al.album.label ? [al.album.label] : [],
      type: [RECORD_TYPES[al.album.recordType] || "Album"],
      year: y || 0,
    };
  }
  const ARTIST_FACETS = [["composer", "Compositeur"], ["genre", "Genre"], ["form", "Forme"], ["decade", "Décennie"], ["label", "Label"], ["type", "Type d'album"]];

  function buildArtist(r) {
    const A = S.artist;
    r.status = h("div", { class: "w-status" });
    r.facets = h("div", { class: "w-facets-body" });
    r.grid = h("div", { class: "w-albums" });
    r.tail = h("div", { class: "tail" });
    r.count = h("span", { class: "muted small" });
    r.head = h("div", { class: "w-composer-head" });
    r.filterBtn = h("button", { class: "btn w-filter-btn", onclick: () => r.root.classList.add("show-filters") }, "Filtres");
    r.root.append(
      h("div", { class: "w-workhead" },
        crumbs({ label: "Accueil", onclick: () => go("home") }, { label: A.info.name }), r.head, r.status),
      h("div", { class: "w-cols" },
        h("aside", { class: "w-facets" },
          h("div", { class: "w-facets-head" }, h("span", { class: "strong" }, "Filtres"),
            h("button", { class: "btn primary", onclick: () => r.root.classList.remove("show-filters") }, "Voir les résultats")),
          r.facets),
        h("section", { class: "w-results" },
          h("div", { class: "w-toolbar" },
            r.filterBtn,
            h("input", { type: "search", placeholder: "Filtrer : œuvre, compositeur, album…", value: A.text,
              oninput: (e) => { A.text = e.target.value; A.shown = PAGE; patchArtist(r); } }),
            h("span", { class: "select" }, h("select", { onchange: (e) => { A.sort = e.target.value; patchArtist(r); } },
              [["recent", "Plus récents"], ["old", "Plus anciens"], ["popular", "Popularité"], ["title", "Titre"]]
                .map(([v, t]) => h("option", { value: v, selected: A.sort === v }, t)))),
            r.count),
          r.grid, r.tail)));
  }

  function patchArtist(r) {
    const A = S.artist, info = A.info;
    const headKey = `${info.name}|${info.picture}|${info.nbAlbums}`;
    if (r.head.dataset.key !== headKey) {
      r.head.dataset.key = headKey;
      const img = info.picture ? h("img", { src: info.picture, alt: "" }) : "";
      r.head.replaceChildren(img, h("div", {}, h("h2", {}, info.name),
        h("div", { class: "muted" }, `${info.nbAlbums || "?"} albums sur Deezer`)));
    }
    const all = [...A.albums.values()].map((al) => ({ al, d: deriveAlbum(al) }));
    const p = A.progress;
    const nWorks = all.reduce((n, { al }) => n + al.works.length, 0);
    const bar = h("div", { class: "bar" }, h("div"));
    bar.firstChild.style.width = `${Math.round(100 * Math.min(1, p ? p.done / Math.max(1, p.total) : 0))}%`;
    r.status.replaceChildren(h("div", { class: "muted small" },
      A.done ? `${all.length} albums analysés · ${nWorks} œuvres` : `Analyse de la discographie… ${p ? (p.phase === "list" ? "liste des albums" : `${p.done}/${p.total} albums`) : ""}`,
      A.cachedAt ? ` · du ${new Date(A.cachedAt).toLocaleDateString()}` : ""),
      A.error ? h("div", { class: "error" }, A.error) : "", !A.done ? bar : "");

    const q = norm(A.text);
    const pass = ({ al, d }, except) => {
      if (q && !norm(`${al.album.title} ${al.works.map((w) => `${w.title} ${w.composerName}`).join(" ")}`).includes(q)) return false;
      for (const [k] of ARTIST_FACETS) {
        if (k === except) continue;
        const sel = A.sel[k];
        if (sel?.size && !d[k].some((v) => sel.has(v))) return false;
      }
      return true;
    };
    r.facets.replaceChildren(...ARTIST_FACETS.map(([k, label]) => {
      const counts = new Map();
      for (const x of all) if (pass(x, k)) for (const v of x.d[k]) counts.set(v, (counts.get(v) || 0) + 1);
      const sel = A.sel[k] || new Set();
      for (const v of sel) if (!counts.has(v)) counts.set(v, 0);
      if (!counts.size) return "";
      const items = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      const limit = A.open[k] ? items.length : 8;
      return h("div", { class: "w-facet" },
        h("div", { class: "w-facet-title" }, label, sel.size ? h("button", { class: "link small", onclick: () => { A.sel[k] = new Set(); A.shown = PAGE; patchArtist(r); } }, "effacer") : ""),
        items.filter(([v], i) => i < limit || sel.has(v)).map(([v, n]) => h("label", { class: `w-opt${sel.has(v) ? " on" : ""}` },
          h("input", { type: "checkbox", checked: sel.has(v), onchange: (e) => {
            const set = A.sel[k] || (A.sel[k] = new Set());
            e.target.checked ? set.add(v) : set.delete(v);
            A.shown = PAGE;
            patchArtist(r);
          } }),
          h("span", { class: "v" }, v), h("span", { class: "n" }, n))),
        items.length > 8 ? h("button", { class: "link small", onclick: () => { A.open[k] = !A.open[k]; patchArtist(r); } }, A.open[k] ? "moins" : `+ ${items.length - 8} autres`) : "");
    }));

    const by = {
      recent: (a, b) => b.d.year - a.d.year, old: (a, b) => (a.d.year || 9999) - (b.d.year || 9999),
      popular: (a, b) => b.al.album.fans - a.al.album.fans, title: (a, b) => a.al.album.title.localeCompare(b.al.album.title),
    };
    const list = all.filter((x) => pass(x)).sort(by[A.sort] || by.recent);
    const active = Object.values(A.sel).reduce((n, set) => n + (set?.size || 0), 0);
    r.filterBtn.textContent = active ? `Filtres (${active})` : "Filtres";
    r.count.textContent = `${list.length} album${list.length > 1 ? "s" : ""}`;
    const visible = list.slice(0, A.shown);
    reconcile(r.grid, visible.map(({ al }) => artistCards.get(al.id) || (artistCards.set(al.id, albumCard(al)), artistCards.get(al.id))));
    r.tail.replaceChildren(
      !visible.length && A.done ? h("div", { class: "muted empty" }, "Aucun album ne correspond.") : "",
      list.length > A.shown ? h("button", { class: "btn more", onclick: () => { A.shown += PAGE; patchArtist(r); } }, `Afficher plus (${list.length - A.shown} restants)`) : "");
  }

  // Carte d'album : pochette et titre ouvrent l'album dans Deezer ; chaque œuvre
  // reconnue ouvre la page de ses enregistrements.
  function albumCard(al) {
    const a = al.album;
    const link = (child, cls) => h("button", { class: `${cls} w-plain`, title: "Fiche de l'album", onclick: () => openAlbumDetail(a.id, a) }, child);
    const y = (a.date || "").slice(0, 4);
    const works = al.works.slice(0, 6);
    return h("div", { class: "w-album" },
      h("div", { class: "w-album-cover" }, link(h("div", { class: "cover" }, a.cover ? h("img", { src: a.cover, alt: "", loading: "lazy" }) : h("div", { class: "ph" }, (a.title || "?")[0])), "w-cover-btn"), playButton(a.id)),
      h("div", { class: "w-album-body" },
        link(a.title, "t"),
        h("div", { class: "m" }, [y, a.label, RECORD_TYPES[a.recordType] && a.recordType !== "album" ? RECORD_TYPES[a.recordType] : ""].filter(Boolean).join(" · ")),
        h("ul", { class: "w-album-works" }, works.map((w) => {
          const label = [w.composer?.name || w.composerName, w.title].filter(Boolean).join(" — ");
          return h("li", {}, w.work && w.composer
            ? h("button", { class: "link", title: "Voir tous les enregistrements de cette œuvre", onclick: () => openWorkOf(w.composer, w.work) }, label)
            : h("span", { class: "muted" }, label));
        }), al.works.length > works.length ? h("li", { class: "muted small" }, `+ ${al.works.length - works.length} autres`) : "")));
  }

  // --- Fiche d'album : contenu, interprètes, détails d'enregistrement --------------
  const movementTail = (title) => title.split(/\s[:\-–]\s|:\s/).pop().replace(/\s*[([][^)\]]*[)\]]\s*/g, " ").replace(/[\s–-]+$/, "").trim();

  function buildAlbum(r) {
    r.body = h("div", { class: "w-scroll w-albumview" });
    r.root.append(r.body);
  }

  function patchAlbum(r) {
    const V = S.albumView, a = V.album || V.preview || {};
    const key = `${!!V.album}|${V.recs.map((x) => (x === undefined ? "?" : x ? 1 : 0)).join("")}|${V.error || ""}|${V.done}`;
    if (r.body.dataset.key === key) return;
    r.body.dataset.key = key;
    const backLabel = { work: "Retour aux enregistrements", artist: "Retour à l'interprète", omni: "Retour à la liste", epoch: "Retour à la liste", label: "Retour au label",
      composer: "Retour au compositeur", home: "Retour à l'accueil" }[V.prev?.view] || "Retour";

    // Interprètes : rôles MusicBrainz quand on les connaît, sinon les artistes Deezer.
    const contribs = a.contribs || (a.contributors || []).map((name) => ({ name }));
    // Compositeurs comparés sur les 5 premières lettres du nom (Rachmaninoff / Rachmaninov).
    const k5 = (n) => (norm(n).split(" ").pop() || "").slice(0, 5);
    const composerKeys = new Set(V.works.map((w) => k5(w.composer?.name || w.composerName || "")).filter(Boolean));
    const isComposer = (n) => composerKeys.has(k5(n));
    const idOf = (name) => {
      const n = norm(name), last = n.split(" ").pop();
      const hit = contribs.find((c) => norm(c.name) === n) || contribs.find((c) => norm(c.name).split(" ").pop() === last && norm(c.name)[0] === n[0]);
      return hit?.id;
    };
    const roles = { soloists: new Map(), conductors: new Set(), ensembles: new Set() };
    for (const rec of V.recs) if (rec) {
      rec.soloists.forEach((x) => roles.soloists.set(x.name, x.instrument));
      rec.conductors.forEach((x) => roles.conductors.add(x));
      rec.ensembles.forEach((x) => roles.ensembles.add(x));
    }
    const known = new Set([...roles.soloists.keys(), ...roles.conductors, ...roles.ensembles].map(norm));
    const others = contribs.filter((c) => !isComposer(c.name) && !known.has(norm(c.name)) && !/^various artists/i.test(c.name));
    const person = (name, extra) => h("button", { class: "chip", title: `Voir la discographie de ${name}`, onclick: () => openArtistByName(name, idOf(name)) }, name, extra ? h("span", { class: "muted" }, ` · ${extra}`) : "");
    const peopleRow = (label, items) => items.length ? h("div", { class: "w-people" }, h("span", { class: "muted small lbl" }, label), h("div", { class: "chips" }, items)) : "";

    const y = (a.date || "").slice(0, 4);
    const cover = a.cover ? h("img", { src: (a.cover || "").replace("250x250", "500x500"), alt: "" }) : h("div", { class: "ph" }, (a.title || "?")[0]);
    r.body.replaceChildren(
      h("div", { class: "w-toolbar" }, h("button", { class: "btn", onclick: backFromAlbum }, `← ${backLabel}`)),
      h("div", { class: "w-album-head" },
        h("div", { class: "cover big" }, cover),
        h("div", { class: "w-album-info" },
          h("div", { class: "muted small" }, a.recordType === "single" ? "Single" : a.recordType === "compile" ? "Compilation" : a.recordType === "ep" ? "EP" : "Album"),
          h("h2", {}, a.title || "…"),
          h("div", { class: "muted" }, y, a.label ? [" · Label : ", h("button", { class: "link", title: "Voir tous les albums de ce label", onclick: () => openLabelFromAlbum(a) }, a.label)] : "",
            [V.nbTracks ? `${V.nbTracks} pistes` : "", V.totalDuration ? fmtDur(V.totalDuration) : ""].filter(Boolean).map((x) => ` · ${x}`).join("")),
          playButton(V.id, true),
          peopleRow("Soliste", [...roles.soloists].map(([n, inst]) => person(n, inst))),
          peopleRow("Chef", [...roles.conductors].map((n) => person(n))),
          peopleRow("Orchestre / ensemble", [...roles.ensembles].map((n) => person(n))),
          peopleRow(known.size ? "Autres artistes" : "Interprètes", others.map((c) => person(c.name))))),
      V.error ? h("div", { class: "error" }, V.error) : "",
      !V.album && !V.error ? h("div", { class: "muted" }, "Chargement de l'album…") : "",
      V.works.length ? h("h3", {}, V.works.length > 1 ? `${V.works.length} œuvres` : "Œuvre") : "",
      ...V.works.map((w, i) => workBlock(w, V.recs[i])));
  }

  // « le 26 avril 1959 », « en novembre 1991 », « en 1963 »
  function recDate(d) {
    if (d.length >= 10) return `le ${new Date(d).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" })}`;
    if (d.length >= 7) return `en ${new Date(`${d.slice(0, 7)}-15`).toLocaleDateString("fr-FR", { month: "long", year: "numeric" })}`;
    return `en ${d}`;
  }

  function workBlock(w, rec) {
    const comp = w.composer
      ? h("button", { class: "link strong", title: "Voir les œuvres de ce compositeur", onclick: () => openComposer(w.composer) }, w.composer.complete_name || w.composer.name)
      : (w.composerName ? h("span", { class: "strong" }, w.composerName) : "");
    const title = w.work && w.composer
      ? h("button", { class: "link w-wtitle", title: "Voir tous les enregistrements de cette œuvre", onclick: () => openWorkOf(w.composer, w.work) }, w.title)
      : h("span", { class: "w-wtitle" }, w.title);
    const recLine = rec ? [
      rec.date ? `enregistré ${recDate(rec.date)}` : "",
      rec.live ? "en concert (live)" : "en studio",
      rec.place ? `${rec.place.name}${rec.place.type ? ` (${PLACE_TYPES[rec.place.type] || rec.place.type})` : ""}${rec.place.area ? `, ${rec.place.area}` : ""}` : "",
    ].filter(Boolean).join(" · ") : "";
    const team = rec ? [rec.engineers.length ? `Ingénieur du son : ${rec.engineers.join(", ")}` : "", rec.producers.length ? `Direction artistique : ${rec.producers.join(", ")}` : ""].filter(Boolean) : [];
    const performers = rec ? [
      ...rec.soloists.map((x) => [x.name, x.instrument]), ...rec.conductors.map((x) => [x, "direction"]), ...rec.ensembles.map((x) => [x, ""]),
    ] : [];
    return h("section", { class: "w-work-block" },
      h("div", { class: "w-work-title" }, comp, comp ? h("span", { class: "muted" }, " — ") : "", title),
      performers.length ? h("div", { class: "chips" }, performers.map(([n, role]) => h("button", { class: "chip", onclick: () => openArtistByName(n) }, n, role ? h("span", { class: "muted" }, ` · ${role}`) : ""))) : "",
      recLine ? h("div", { class: "m rec" }, recLine) : "",
      team.map((t) => h("div", { class: "m" }, t)),
      rec === undefined ? h("div", { class: "muted small" }, "Recherche des détails d'enregistrement…") : rec === false ? h("div", { class: "muted small" }, "Pas de détails d'enregistrement dans MusicBrainz.") : "",
      h("ol", { class: "w-tracks" }, (w.tracks || []).map((t) => h("li", {}, h("span", { class: "tt" }, movementTail(t.title)), h("span", { class: "td" }, fmtDur(t.duration || 0))))));
  }

  // --- Catalogue d'un label ------------------------------------------------------
  const LABEL_FACETS = [["artist", "Artiste principal"], ["decade", "Décennie"], ["type", "Type"]];
  const LABEL_REL = {
    "label ownership": ["Label parent", "Sous-label"], imprint: ["Marque de", "Marque"], "label rename": ["Ancien nom", "Nouveau nom"],
    "label reissue": ["Rééditions par", "Réédite"], "label distribution": ["Distribué par", "Distribue"],
  };

  function buildLabel(r) {
    const V = S.labelView;
    const back = V.prev && V.prev.view !== "home" ? h("button", { class: "btn", onclick: () => { restoreKey = V.prev.key; go(V.prev.view); } },
      `← ${V.prev.view === "album" ? "Retour à l'album" : "Retour"}`) : "";
    if (V.resolving || V.candidates || V.error && !V.infosLoaded) {
      r.body = h("div", { class: "w-scroll" });
      r.root.append(r.body);
      r.body.append(back, h("h2", {}, V.title || "Label"),
        V.resolving ? h("div", { class: "muted" }, "Recherche du label dans MusicBrainz…") : "",
        V.error ? h("div", { class: "error" }, V.error) : "",
        V.candidates ? [h("div", { class: "muted" }, V.candidates.length ? "Plusieurs labels possibles : choisissez." : "Label introuvable dans MusicBrainz."),
          h("div", { class: "w-works" }, V.candidates.map((l) => h("button", { class: "w-work", onclick: () => openLabels([l.id], { prev: V.prev }) },
            h("div", {}, h("div", { class: "strong" }, l.name), h("div", { class: "muted small" }, [l.disambiguation, l.type, l.country, l.catno].filter(Boolean).join(" · "))))))] : "");
      r.resolveOnly = true;
      return;
    }
    r.chips = h("div", {});
    r.status = h("div", { class: "w-status" });
    r.facets = h("div", { class: "w-facets-body" });
    r.grid = h("div", { class: "grid w-grid" });
    r.tail = h("div", { class: "tail" });
    r.count = h("span", { class: "muted small" });
    r.title = h("h2", {});
    r.filterBtn = h("button", { class: "btn w-filter-btn", onclick: () => r.root.classList.add("show-filters") }, "Filtres");
    r.root.append(
      h("div", { class: "w-workhead" }, back,
        crumbs({ label: "Accueil", onclick: () => go("home") }, { label: "Label" }), r.title, r.chips, r.status),
      h("div", { class: "w-cols" },
        h("aside", { class: "w-facets" },
          h("div", { class: "w-facets-head" }, h("span", { class: "strong" }, "Filtres"),
            h("button", { class: "btn primary", onclick: () => r.root.classList.remove("show-filters") }, "Voir les résultats")),
          r.facets),
        h("section", { class: "w-results" },
          h("div", { class: "w-toolbar" },
            r.filterBtn,
            h("input", { type: "search", placeholder: "Filtrer : titre, compositeur, interprète, n° de catalogue", value: V.text,
              oninput: (e) => { V.text = e.target.value; V.shown = PAGE; patchLabel(r); } }),
            h("span", { class: "select" }, h("select", { onchange: (e) => { V.sort = e.target.value; patchLabel(r); } },
              [["date-desc", "Plus récents"], ["date-asc", "Plus anciens"], ["catno", "N° de catalogue"], ["title", "Titre"]]
                .map(([v, t]) => h("option", { value: v, selected: V.sort === v }, t)))),
            r.count),
          r.grid, r.tail)));
  }

  function patchLabel(r) {
    if (r.resolveOnly) return;
    const V = S.labelView;
    const names = V.labels.map((l) => l.name);
    r.title.textContent = names.length > 1 ? `${names[0]} + ${names.length - 1} label${names.length > 2 ? "s" : ""}` : names[0] || V.title || "Label";
    // Labels inclus (cochés) / décochés, puis autres labels liés (« + »).
    const chipKey = `${V.infosLoaded}|${V.ids.join(",")}|${V.off.map((o) => o.id).join(",")}`;
    if (r.chips.dataset.key !== chipKey) {
      r.chips.dataset.key = chipKey;
      const chip = (id, name, on) => h("button", { class: `chip toggle${on ? " on" : ""}`, title: on ? `Retirer ${name}` : `Ajouter ${name}`, onclick: () => toggleLabel(id, name) },
        h("span", { class: "box" }, on ? "✓" : ""), name);
      const known = new Set([...V.ids, ...V.off.map((o) => o.id)]);
      const related = new Map();
      for (const l of V.labels) for (const rel of l.relations || []) if (!known.has(rel.id) && !related.has(rel.id)) related.set(rel.id, rel);
      r.chips.replaceChildren(
        !V.infosLoaded ? h("div", { class: "muted small" }, V.expanding ? "Recherche des sous-labels…" : "Chargement…") : "",
        V.infosLoaded && (V.labels.length > 1 || V.off.length) ? h("div", { class: "chips" }, V.labels.map((l) => chip(l.id, l.name, true)), V.off.map((o) => chip(o.id, o.name, false))) : "",
        V.infosLoaded && related.size ? h("div", { class: "chips w-related" }, h("span", { class: "muted small" }, "Labels liés :"),
          [...related.values()].map((rel) => {
            const nm = LABEL_REL[rel.type] || [rel.type, rel.type];
            return h("button", { class: "chip", onclick: () => toggleLabel(rel.id, rel.name) }, h("span", { class: "plus" }, "+ "), rel.name, h("span", { class: "muted" }, ` · ${rel.direction === "backward" ? nm[0] : nm[1]}`));
          })) : "");
    }

    const all = [...V.groups.values()].map((g) => {
      const m = V.matches.get(g.id);
      const y = parseInt((g.date || "").slice(0, 4), 10);
      return { g, m, d: { artist: g.firstArtist ? [g.firstArtist] : [], decade: y ? [`Années ${Math.floor(y / 10) * 10}`] : [], type: [(g.type || "Album").split(" · ")[0]], year: y || 0 } };
    });
    const available = (x) => x.m && ["exact", "label", "probable"].includes(x.m.status);
    const q = norm(V.text);
    const pass = (x, except) => {
      if (q && !norm(`${g2text(x.g)} ${x.m?.album?.title || ""}`).includes(q)) return false;
      for (const [k] of LABEL_FACETS) {
        if (k === except) continue;
        const sel = V.sel[k];
        if (sel?.size && !x.d[k].some((v) => sel.has(v))) return false;
      }
      return true;
    };
    const catno = (g) => g.releases.map((rr) => rr.catno).filter(Boolean).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))[0] || "~~~~";
    const by = {
      "date-desc": (a, b) => (b.g.date || "").localeCompare(a.g.date || ""), "date-asc": (a, b) => (a.g.date || "9999").localeCompare(b.g.date || "9999"),
      catno: (a, b) => catno(a.g).localeCompare(catno(b.g), undefined, { numeric: true }), title: (a, b) => a.g.title.localeCompare(b.g.title),
    };
    const ordered = all.filter((x) => pass(x)).sort(by[V.sort] || by["date-desc"]);

    // Vérification sur Deezer : d'abord les albums affichés, puis tout le catalogue.
    if (labelPort && V.infosLoaded) {
      const labelNames = V.labels.flatMap((l) => [l.name, ...(l.aliases || [])]).filter(Boolean);
      const head = ordered.filter((x) => !V.matches.has(x.g.id)).slice(0, PAGE * 2).map((x) => x.g);
      const k = head.map((g) => g.id).join(",");
      if (k && k !== V.lastPrio) { V.lastPrio = k; head.forEach((g) => V.requested.add(g.id)); labelPort.postMessage({ cmd: "match", groups: head, labelNames, priority: true }); }
      const rest = [...V.groups.values()].filter((g) => !V.requested.has(g.id) && !V.matches.has(g.id));
      if (rest.length) { rest.forEach((g) => V.requested.add(g.id)); labelPort.postMessage({ cmd: "match", groups: rest, labelNames, priority: false }); }
    }

    const ps = Object.values(V.progress);
    const p = ps.length ? { loaded: ps.reduce((n, x) => n + x.loaded, 0), total: ps.reduce((n, x) => n + x.total, 0) } : null;
    const nGroups = V.groups.size, checked = V.matches.size, avail = all.filter(available).length;
    const checking = V.loadDone && checked < nGroups;
    const bar = h("div", { class: "bar" }, h("div"));
    bar.firstChild.style.width = `${Math.round(100 * Math.min(1, !V.loadDone ? (p ? p.loaded / Math.max(1, p.total) : 0) : checked / Math.max(1, nGroups)))}%`;
    r.status.replaceChildren(h("div", { class: "muted small" },
      !V.loadDone ? `Chargement du catalogue MusicBrainz… ${p ? `${p.loaded} / ${p.total} éditions` : ""}${
        // Grand label : 100 éditions par seconde au mieux (limite de MusicBrainz).
        p && p.total - p.loaded > 3000 ? ` · grand label, environ ${Math.ceil((p.total - p.loaded) / 100 / 50)} min restantes (les albums s'affichent au fur et à mesure)` : ""}`
        : checking ? `Recherche sur Deezer… ${checked} / ${nGroups} albums · ${avail} trouvés` : `${avail} albums sur Deezer (${nGroups} au catalogue)`,
      V.cachedAt ? ` · catalogue du ${new Date(V.cachedAt).toLocaleDateString()}` : ""),
      V.error ? h("div", { class: "error" }, V.error) : "",
      !V.loadDone || checking ? bar : "");

    const shownAll = all.filter(available);
    r.facets.replaceChildren(...LABEL_FACETS.map(([k, label]) => {
      const counts = new Map();
      for (const x of shownAll) if (pass(x, k)) for (const v of x.d[k]) counts.set(v, (counts.get(v) || 0) + 1);
      const sel = V.sel[k] || new Set();
      for (const v of sel) if (!counts.has(v)) counts.set(v, 0);
      if (!counts.size) return "";
      const items = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      const limit = V.open[k] ? items.length : 8;
      return h("div", { class: "w-facet" },
        h("div", { class: "w-facet-title" }, label, sel.size ? h("button", { class: "link small", onclick: () => { V.sel[k] = new Set(); V.shown = PAGE; patchLabel(r); } }, "effacer") : ""),
        items.filter(([v], i) => i < limit || sel.has(v)).map(([v, n]) => h("label", { class: `w-opt${sel.has(v) ? " on" : ""}` },
          h("input", { type: "checkbox", checked: sel.has(v), onchange: (e) => {
            const set = V.sel[k] || (V.sel[k] = new Set());
            e.target.checked ? set.add(v) : set.delete(v);
            V.shown = PAGE;
            patchLabel(r);
          } }),
          h("span", { class: "v" }, v), h("span", { class: "n" }, n))),
        items.length > 8 ? h("button", { class: "link small", onclick: () => { V.open[k] = !V.open[k]; patchLabel(r); } }, V.open[k] ? "moins" : `+ ${items.length - 8} autres`) : "");
    }));

    const list = ordered.filter(available);
    const active = Object.values(V.sel).reduce((n, set) => n + (set?.size || 0), 0);
    r.filterBtn.textContent = active ? `Filtres (${active})` : "Filtres";
    r.count.textContent = `${list.length} album${list.length > 1 ? "s" : ""}`;
    const visible = list.slice(0, V.shown);
    reconcile(r.grid, visible.map((x) => labelCards.get(x.g.id) || (labelCards.set(x.g.id, labelCard(x.g, x.m.album)), labelCards.get(x.g.id))));
    r.tail.replaceChildren(
      !visible.length && V.loadDone && !checking ? h("div", { class: "muted empty" }, "Aucun album de ce label trouvé sur Deezer.") : "",
      list.length > V.shown ? h("button", { class: "btn more", onclick: () => { V.shown += PAGE; patchLabel(r); } }, `Afficher plus (${list.length - V.shown} restants)`) : "");
  }
  const g2text = (g) => `${g.title} ${g.artist} ${g.releases.map((rr) => rr.catno).join(" ")}`;

  function labelCard(g, a) {
    const catnos = [...new Set(g.releases.map((rr) => rr.catno).filter(Boolean))];
    const preview = { id: a.id, title: a.title, cover: a.cover, label: a.label, date: a.date };
    return h("div", { class: "item", role: "button", tabindex: "0", title: `${a.title}\n(cliquez pour la fiche de l'album)`,
      onclick: () => openAlbumDetail(a.id, preview), onkeydown: (ev) => { if (ev.key === "Enter") openAlbumDetail(a.id, preview); } },
      h("div", { class: "cover" }, a.cover ? h("img", { src: a.cover, alt: "", loading: "lazy" }) : h("div", { class: "ph" }, (a.title || "?")[0]), playButton(a.id)),
      h("div", { class: "t" }, a.title || g.title),
      h("div", { class: "a" }, g.artist || a.artist),
      h("div", { class: "m" }, [(g.date || "").slice(0, 4), catnos.slice(0, 2).join(", ")].filter(Boolean).join(" · ")));
  }

  return {
    render,
    reset: () => go("home"),
    get view() { return S.view; },
  };
};
