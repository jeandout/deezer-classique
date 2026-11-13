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
    view: "home",                // home | composer | work
    q: "", results: null, searching: false, popular: null,
    composer: null, works: null, wf: { text: "", genre: "all", form: null, instrument: null, popularOnly: false },
    work: null, entries: new Map(), enrich: new Map(), progress: null, done: false, error: null, cachedAt: null,
    sel: {}, open: {}, sort: "popular", text: "", shown: PAGE,
    mov: "all",                  // durée prise en compte pour le tempo : "all" ou n° de mouvement
  };
  let port = null, requested = new Set(), lastPrio = "", cards = new Map();
  let container = null, refs = null, builtKey = "";

  // --- Navigation -------------------------------------------------------------
  function go(view, patch = {}) {
    Object.assign(S, patch, { view });
    if (view !== "work" && port) { port.disconnect(); port = null; }
    schedule(true);
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
      sel: { version: new Set(["Œuvre complète"]) }, open: {}, text: "", shown: PAGE, mov: "all",
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
    if (v.trim().length < 3) { S.results = null; schedule(); return; }
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
      const oo = call("ooComposerSearch", { q: v }).then(merge).catch(() => {});
      const mbz = call("mbComposerSearch", { q: v }).then(merge).catch(() => {});
      await Promise.all([oo, mbz]);
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
      mb,
    };
  }

  const FACETS = [
    ["tempo", "Tempo"], ["soloists", "Soliste / interprète"], ["ensembles", "Orchestre / ensemble"], ["conductors", "Chef"],
    ["label", "Label"], ["decade", "Décennie"], ["live", "Live / studio"], ["placeType", "Type de lieu"],
    ["place", "Lieu d'enregistrement"], ["engineers", "Ingénieur du son"], ["producers", "Directeur artistique"],
    ["version", "Version"],
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
    const key = S.view === "work" ? `work:${S.work?.id}` : S.view === "composer" ? `composer:${S.composer?.id}` : "home";
    if (key !== builtKey || !refs || !container.contains(refs.root)) {
      builtKey = key;
      refs = { root: h("div", { class: "w-root" }) };
      ({ home: buildHome, composer: buildComposer, work: buildWork })[S.view](refs);
      container.replaceChildren(refs.root);
    }
    ({ home: patchHome, composer: patchComposer, work: patchWork })[S.view](refs);
  }

  function crumbs(...items) {
    return h("nav", { class: "w-crumbs" }, items.map((it, i) => [
      i ? h("span", { class: "sep" }, "›") : null,
      it.onclick ? h("button", { class: "link", onclick: it.onclick }, it.label) : h("span", { class: "cur" }, it.label),
    ]));
  }

  // Accueil : recherche de compositeur + compositeurs populaires.
  function buildHome(r) {
    r.results = h("div", { class: "w-composers" });
    r.popular = h("div", { class: "w-composers" });
    r.root.append(h("div", { class: "w-scroll" },
      h("h2", {}, "Rechercher un compositeur"),
      h("input", { type: "search", class: "w-big", placeholder: "Rachmaninov, Bach, Debussy…", value: S.q, oninput: (e) => onSearchInput(e.target.value) }),
      r.results,
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
        h("div", { class: "muted small" }, [c.birth && `${c.birth}–${c.death || ""}`, c.epoch, c.source === "mb" ? "MusicBrainz" : ""].filter(Boolean).join(" · "))));
  }
  function patchHome(r) {
    r.results.replaceChildren(...[
      Array.isArray(S.results) ? S.results.map(composerCard) : "",
      S.searching ? h("div", { class: "muted small" }, S.results?.length ? "Recherche dans MusicBrainz…" : "Recherche…") : "",
      !S.searching && Array.isArray(S.results) && !S.results.length ? h("div", { class: "muted" }, "Aucun compositeur trouvé.") : "",
    ].flat());
    if (r.popular.childElementCount !== (S.popular || []).length) r.popular.replaceChildren(...(S.popular || []).map(composerCard));
  }

  // Compositeur : liste de ses œuvres, filtrable par genre, forme, instrument.
  function buildComposer(r) {
    const c = S.composer;
    r.chips = h("div", { class: "w-chiprows" });
    r.list = h("div", { class: "w-works" });
    r.count = h("span", { class: "muted small" });
    r.root.append(h("div", { class: "w-scroll" },
      crumbs({ label: "Compositeurs", onclick: () => go("home") }, { label: c.complete_name || c.name }),
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
        crumbs({ label: "Compositeurs", onclick: () => go("home") }, { label: c.complete_name || c.name, onclick: () => go("composer") }, { label: w.title }),
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
    const el = h("a", { class: "item", href: ctx.albumUrl(a.id), target: ctx.albumTarget || null, rel: ctx.albumTarget ? "noopener" : null, title: `${a.title}\n${a.contributors.join(", ")}`, onclick: (ev) => openAlbum(a.id, ev) },
      h("div", { class: "cover" }, cover, d.version[0] !== "Œuvre complète" ? h("span", { class: "w-badge" }, d.version[0] === "Extrait" ? `Extrait (${e.tracks.length}/${modeTracks})` : "Arrangement") : ""),
      h("div", { class: "t" }, a.title),
      solo.length ? h("div", { class: "a" }, solo.join(", ")) : "",
      line2 ? h("div", { class: "a" }, line2) : "",
      h("div", { class: "m" }, meta),
      rec ? h("div", { class: "m rec" }, rec) : "",
      dur);
    el._dur = dur;
    return el;
  }

  return {
    render,
    reset: () => go("home"),
    get view() { return S.view; },
  };
};
