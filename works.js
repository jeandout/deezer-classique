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
      sel: { version: new Set(["Œuvre complète"]) }, open: {}, text: "", shown: PAGE,
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
    searchTimer = setTimeout(async () => {
      S.searching = true; schedule();
      try { S.results = await call("ooComposerSearch", { q: v }); } catch (e) { S.results = { error: e.message }; }
      S.searching = false; schedule();
    }, 300);
  }

  // --- Données dérivées d'un enregistrement -------------------------------------
  const composerKey = () => norm(S.composer?.name || "").replace(/\s/g, "").slice(0, 5);
  let modeTracks = 1;

  function derive(e) {
    const mb = S.enrich.get(e.id);
    const ck = composerKey();
    const contrib = e.album.contributors.filter((n) => !norm(n).replace(/\s/g, "").includes(ck));
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
    ["soloists", "Soliste / interprète"], ["ensembles", "Orchestre / ensemble"], ["conductors", "Chef"],
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
      r.popular));
    if (!S.popular) call("ooPopularComposers").then((p) => { S.popular = p; schedule(); }).catch(() => {});
    setTimeout(() => r.root.querySelector("input")?.focus({ preventScroll: true }), 0);
  }
  function composerCard(c) {
    const img = h("img", { src: c.portrait, alt: "", loading: "lazy" });
    img.addEventListener("error", () => img.replaceWith(h("div", { class: "ph" }, (c.name || "?")[0])));
    return h("button", { class: "w-composer", onclick: () => openComposer(c) },
      c.portrait ? img : h("div", { class: "ph" }, (c.name || "?")[0]),
      h("div", {}, h("div", { class: "strong" }, c.complete_name || c.name),
        h("div", { class: "muted small" }, [c.birth && `${c.birth}–${c.death || ""}`, c.epoch].filter(Boolean).join(" · "))));
  }
  function patchHome(r) {
    r.results.replaceChildren(...[
      S.searching ? h("div", { class: "muted" }, "Recherche…") : "",
      S.results?.error ? h("div", { class: "error" }, S.results.error) : "",
      Array.isArray(S.results) ? (S.results.length ? S.results.map(composerCard) : h("div", { class: "muted" }, "Aucun compositeur trouvé.")) : "",
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
          onchange: (e) => { S.wf.popularOnly = e.target.checked; patchComposer(r); } }), " Œuvres populaires"),
        r.count),
      r.chips, r.list));
  }
  function patchComposer(r) {
    if (!S.works) { r.list.replaceChildren(h("div", { class: "muted" }, "Chargement des œuvres…")); return; }
    if (S.works.error) { r.list.replaceChildren(h("div", { class: "error" }, S.works.error)); return; }
    const f = S.wf, q = norm(f.text);
    const pass = (w, except) =>
      (except === "genre" || f.genre === "all" || w.genre === f.genre) &&
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
      chipRow("Genre", "genre", countBy("genre", (w) => [w.genre]), (v) => GENRES[v] || v),
      chipRow("Forme", "form", countBy("form", (w) => w.forms).slice(0, 16)),
      chipRow("Instrument", "instrument", countBy("instrument", (w) => w.instruments).slice(0, 14)));
    const list = S.works.filter((w) => pass(w))
      .sort((a, b) => (b.popular + b.recommended) - (a.popular + a.recommended) || a.title.localeCompare(b.title, undefined, { numeric: true }));
    r.count.textContent = `${list.length} œuvre${list.length > 1 ? "s" : ""}`;
    r.list.replaceChildren(...list.map((w) => h("button", { class: "w-work", onclick: () => openWork(w) },
      h("div", {}, h("div", { class: "strong" }, w.title, w.popular ? h("span", { class: "star", title: "Œuvre populaire" }, " ★") : ""),
        w.subtitle ? h("div", { class: "muted small" }, w.subtitle) : ""),
      h("span", { class: "tag" }, GENRES[w.genre] || w.genre))));
  }

  // Œuvre : enregistrements disponibles sur Deezer + facettes.
  function buildWork(r) {
    const c = S.composer, w = S.work;
    r.status = h("div", { class: "w-status" });
    r.facets = h("aside", { class: "w-facets" });
    r.grid = h("div", { class: "grid w-grid" });
    r.tail = h("div", { class: "tail" });
    r.count = h("span", { class: "muted small" });
    r.root.append(
      h("div", { class: "w-workhead" },
        crumbs({ label: "Compositeurs", onclick: () => go("home") }, { label: c.complete_name || c.name, onclick: () => go("composer") }, { label: w.title }),
        h("h2", {}, w.title), r.status),
      h("div", { class: "w-cols" },
        r.facets,
        h("section", { class: "w-results" },
          h("div", { class: "w-toolbar" },
            h("input", { type: "search", placeholder: "Filtrer : interprète, orchestre, label, lieu…", value: S.text,
              oninput: (e) => { S.text = e.target.value; S.shown = PAGE; patchWork(r); } }),
            h("span", { class: "select" }, h("select", { onchange: (e) => { S.sort = e.target.value; patchWork(r); } },
              [["popular", "Popularité"], ["recent", "Plus récents"], ["old", "Plus anciens"], ["artist", "Interprète"]]
                .map(([v, t]) => h("option", { value: v, selected: S.sort === v }, t)))),
            r.count),
          r.grid, r.tail)));
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

    // Facettes : nombre de résultats par valeur, compte tenu des autres filtres.
    r.facets.replaceChildren(...FACETS.map(([k, label]) => {
      const counts = new Map();
      for (const { d } of filtered(all, k)) for (const v of new Set(d[k])) counts.set(v, (counts.get(v) || 0) + 1);
      const sel = S.sel[k] || new Set();
      for (const v of sel) if (!counts.has(v)) counts.set(v, 0);
      if (!counts.size) return "";
      const items = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      const limit = S.open[k] ? items.length : 6;
      const shown = items.filter(([v], i) => i < limit || sel.has(v));
      return h("div", { class: "w-facet" },
        h("div", { class: "w-facet-title" }, label, sel.size ? h("button", { class: "link small", onclick: () => { S.sel[k] = new Set(); S.shown = PAGE; patchWork(r); } }, "effacer") : ""),
        shown.map(([v, n]) => h("label", { class: `w-opt${sel.has(v) ? " on" : ""}` },
          h("input", { type: "checkbox", checked: sel.has(v), onchange: (e) => {
            const s = S.sel[k] || (S.sel[k] = new Set());
            e.target.checked ? s.add(v) : s.delete(v);
            S.shown = PAGE;
            patchWork(r);
          } }),
          h("span", { class: "v" }, v), h("span", { class: "n" }, n))),
        items.length > 6 ? h("button", { class: "link small", onclick: () => { S.open[k] = !S.open[k]; patchWork(r); } },
          S.open[k] ? "moins" : `+ ${items.length - 6} autres`) : "");
    }));

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

  function cardFor({ e, d }) {
    let el = cards.get(e.id);
    if (!el) { el = card(e, d); cards.set(e.id, el); }
    return el;
  }

  function card(e, d) {
    const a = e.album;
    const cover = a.cover ? h("img", { src: a.cover, alt: "", loading: "lazy" }) : h("div", { class: "ph" }, (a.title || "?")[0]);
    const solo = d.mb ? d.mb.soloists.map((s) => s.name + (s.instrument ? ` (${s.instrument})` : "")) : d.soloists;
    const line2 = [d.ensembles.join(", "), d.conductors.length ? `dir. ${d.conductors.join(", ")}${d.guessed ? " ?" : ""}` : ""].filter(Boolean).join(" · ");
    const meta = [d.year || "", a.label].filter(Boolean).join(" · ");
    const rec = d.mb ? [d.mb.live ? "Live" : "", d.mb.place ? d.mb.place.name : "", d.mb.engineers.length ? `ing. ${d.mb.engineers.join(", ")}` : ""].filter(Boolean).join(" · ") : "";
    return h("a", { class: "item", href: `/${ctx.lang()}/album/${a.id}`, title: `${a.title}\n${a.contributors.join(", ")}`, onclick: (ev) => openAlbum(a.id, ev) },
      h("div", { class: "cover" }, cover, d.version[0] !== "Œuvre complète" ? h("span", { class: "w-badge" }, d.version[0] === "Extrait" ? `Extrait (${e.tracks.length}/${modeTracks})` : "Arrangement") : ""),
      h("div", { class: "t" }, a.title),
      solo.length ? h("div", { class: "a" }, solo.join(", ")) : "",
      line2 ? h("div", { class: "a" }, line2) : "",
      h("div", { class: "m" }, meta),
      rec ? h("div", { class: "m rec" }, rec) : "");
  }

  return {
    render,
    reset: () => go("home"),
    get view() { return S.view; },
  };
};
