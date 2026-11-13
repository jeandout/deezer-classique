// Interface injectée dans deezer.com : bouton flottant + panneau latéral.
(() => {
  if (window.__dzLabelBrowser) return;
  window.__dzLabelBrowser = true;

  const PAGE = 60; // cartes affichées par lot

  // --- Utilitaires ---------------------------------------------------------
  const call = (type, extra = {}) =>
    new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type, ...extra }, (res) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!res) return reject(new Error("Pas de réponse"));
        res.ok ? resolve(res.data) : reject(new Error(res.error));
      });
    });

  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "html") el.innerHTML = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  const lang = () => {
    const seg = location.pathname.split("/")[1];
    return /^[a-z]{2}$/.test(seg) ? seg : "fr";
  };
  const albumIdFromUrl = () => (location.pathname.match(/\/album\/(\d+)/) || [])[1] || null;
  const year = (d) => (d || "").slice(0, 4);
  const naturalCmp = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  const AVAILABLE = ["exact", "label", "probable"];

  // Comparaison souple de noms de labels (« Chandos Records Ltd » ≈ « Chandos »).
  const norm = (s) => (s || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
  const LABEL_NOISE = /\b(records?|recordings?|music|musique|musik|label|ltd|limited|inc|gmbh|sa|sarl|llc|co|company|classics?|entertainment|productions?|editions?)\b/g;
  const labelKey = (s) => norm(s).replace(LABEL_NOISE, " ").replace(/\s+/g, " ").trim();
  const sameLabel = (a, b) => {
    const x = labelKey(a), y = labelKey(b);
    return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
  };
  // « © 2004 Chandos Records » -> « Chandos Records »
  const parseLegal = (t) => (t || "")
    .replace(/^\s*(?:[©℗Ⓒ]|\((?:c|p)\))\s*/i, "")
    .replace(/^\d{4}(?:\s*[-–,/]\s*\d{4})*\s*/, "")
    .trim();

  // --- État ----------------------------------------------------------------
  const state = {
    open: false,
    view: "home",        // "home" | "label"
    album: null,         // album Deezer de la page courante
    suggestions: null,   // labels proposés pour cet album
    searchResults: null,
    searching: false,
    label: null,         // infos MusicBrainz du label ouvert
    groups: new Map(),
    matches: new Map(),
    progress: null,
    loadDone: false,
    error: null,
    shown: PAGE,
    filters: { text: "", sort: "date-desc", type: "all" },
    prefs: { inApp: true, recent: [] },
  };
  let port = null;
  let requested = new Set(); // albums déjà envoyés pour vérification Deezer
  let lastPrioKey = "";

  // --- DOM : hôte + Shadow DOM ---------------------------------------------
  const host = h("div", { id: "dz-label-browser-host" });
  const root = host.attachShadow({ mode: "open" });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(CSS());
  root.adoptedStyleSheets = [sheet];

  const tab = h("button", { class: "tab", title: "Catalogue du label", onclick: () => toggle() });
  const panel = h("aside", { class: "panel", "aria-label": "Catalogues de labels" });
  root.append(tab, panel);
  document.documentElement.append(host);

  // --- Charte graphique : on reprend la police et les couleurs de la page ---
  // (thème clair ou sombre de Deezer), relues à chaque affichage du panneau.
  function syncTheme() {
    const pick = (prop, test) => {
      for (const sel of ["#page_content", "main", "#dzr-app", "body", "html"]) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const v = getComputedStyle(el)[prop];
        if (test(v)) return v;
      }
      return "";
    };
    const opaque = (c) => c && c !== "transparent" && !/rgba\([^)]*,\s*0\)$/.test(c);
    const font = getComputedStyle(document.body).fontFamily;
    const vars = {
      "--font": font,
      "--bg": pick("backgroundColor", opaque),
      "--fg": getComputedStyle(document.body).color,
    };
    for (const [k, v] of Object.entries(vars)) if (v) host.style.setProperty(k, v);
  }

  // --- Mention légale cliquable (« © 2004 Chandos Records ») ----------------
  // On ne touche pas aux éléments gérés par Deezer : un style ajouté au
  // document et un écouteur de clic global suffisent.
  const LEGAL = ".catalog-legal-notice p";
  try {
    const pageSheet = new CSSStyleSheet();
    pageSheet.replaceSync(`${LEGAL} { cursor: pointer; } ${LEGAL}:hover { color: #a238ff; text-decoration: underline; }`);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, pageSheet];
  } catch (e) { console.warn("[labels] style mention légale", e); }
  document.addEventListener("mouseover", (e) => {
    const p = e.target.closest?.(LEGAL);
    if (p && !p.title) p.title = `Voir le catalogue de ${parseLegal(p.textContent)}`;
  });
  document.addEventListener("click", (e) => {
    const p = e.target.closest?.(LEGAL);
    if (!p) return;
    const name = parseLegal(p.textContent);
    if (!name) return;
    e.preventDefault();
    e.stopPropagation();
    openForLabelName(name);
  }, true);

  // --- Navigation dans Deezer ----------------------------------------------
  function openAlbum(id, ev) {
    if (ev && (ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.button === 1)) return; // nouvel onglet
    if (ev) ev.preventDefault();
    const path = `/${lang()}/album/${id}`;
    if (state.prefs.inApp) {
      // Navigation interne de l'appli, sans recharger la page ni couper la lecture.
      history.pushState(history.state, "", path);
      window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
    } else {
      location.assign(path);
    }
  }

  // --- Ouverture / fermeture -----------------------------------------------
  function toggle(force) {
    state.open = force ?? !state.open;
    panel.classList.toggle("open", state.open);
    tab.classList.toggle("hidden", state.open);
    if (state.open) {
      syncTheme();
      if (state.view === "home" && state.album && !state.suggestions) suggestFromAlbum();
      else render();
    }
  }

  chrome.runtime.onMessage.addListener((m) => {
    if (m.type === "toggle") toggle();
  });

  // --- Album de la page courante -------------------------------------------
  let lastAlbumId = null;
  async function onUrlChange() {
    const id = albumIdFromUrl();
    if (id === lastAlbumId) return;
    lastAlbumId = id;
    state.album = null;
    state.suggestions = null;
    renderTab();
    if (!id) { if (state.open && state.view === "home") render(); return; }
    try {
      const album = await call("deezerAlbum", { id });
      if (lastAlbumId !== id) return;
      state.album = album;
      renderTab();
      if (state.open && state.view === "home") render();
    } catch (e) {
      console.warn("[labels] album Deezer", e);
    }
  }
  setInterval(onUrlChange, 800);

  function renderTab() {
    tab.replaceChildren(
      h("span", { class: "tab-icon" }, "🏷"),
      h("span", { class: "tab-text" }, state.album?.label || "Labels")
    );
    tab.title = state.album?.label ? `Catalogue de ${state.album.label}` : "Rechercher un label";
  }

  // Ouvre directement le label s'il n'y a qu'un candidat dont le nom correspond.
  function uniqueByName(list, name) {
    const exact = list.filter((l) => labelKey(l.name) === labelKey(name));
    return exact.length === 1 ? exact[0] : null;
  }

  // name : nom cliqué dans la mention légale (sinon le label indiqué par Deezer).
  async function suggestFromAlbum(name) {
    const a = state.album;
    if (!a) return;
    const wanted = name || a.label;
    state.suggestions = { loading: true, byBarcode: [], byName: [] };
    render();
    try {
      // 1) Le code-barres de l'album identifie le label avec certitude.
      const byBarcode = a.upc ? await call("labelsByBarcode", { upc: a.upc }) : [];
      const pick = byBarcode.find((l) => sameLabel(l.name, wanted)) ||
        (byBarcode.length === 1 && (!name || sameLabel(a.label, name)) ? byBarcode[0] : null);
      if (pick) {
        state.suggestions = null;
        return openLabel(pick.id);
      }
      // 2) Sinon, recherche par nom.
      const byName = wanted ? await call("searchLabels", { q: wanted }) : [];
      const only = !byBarcode.length && uniqueByName(byName, wanted);
      if (only) {
        state.suggestions = null;
        return openLabel(only.id);
      }
      state.suggestions = { loading: false, byBarcode, byName };
    } catch (e) {
      state.suggestions = { loading: false, error: e.message, byBarcode: [], byName: [] };
    }
    render();
  }

  // Clic sur la mention légale d'un album.
  function openForLabelName(name) {
    if (port) { port.disconnect(); port = null; }
    state.view = "home";
    state.suggestions = null;
    state.open = true;
    panel.classList.add("open");
    tab.classList.add("hidden");
    syncTheme();
    if (state.album && albumIdFromUrl() === String(state.album.id)) return suggestFromAlbum(name);
    state.lastQ = name;
    return searchLabels(name, true);
  }

  // --- Recherche de labels -------------------------------------------------
  async function searchLabels(q, autoOpen = false) {
    q = q.trim();
    if (!q) return;
    state.searching = true;
    state.searchResults = null;
    render();
    try {
      state.searchResults = await call("searchLabels", { q });
      state.selected = autoSelect(q, state.searchResults);
      state.userUnchecked = new Set();
      const only = autoOpen && uniqueByName(state.searchResults, q);
      if (only) { state.searching = false; return openLabel(only.id); }
    } catch (e) {
      state.searchResults = { error: e.message };
    }
    state.searching = false;
    render();
  }

  // --- Ouverture d'un label ------------------------------------------------
  // Un ou plusieurs labels, parcourus comme un seul catalogue
  // (ex. Chandos + Chaconne + Chandos Classics…).
  const openLabel = (mbid) => openLabels([mbid]);

  // Relations qui désignent un sous-label du label courant : filiale,
  // marque (imprint) ou autre nom du même label.
  const isSubLabel = (r) =>
    ((r.type === "label ownership" || r.type === "imprint") && r.direction === "forward") ||
    r.type === "label rename";

  // ids : labels demandés. Par défaut, leurs sous-labels sont ajoutés
  // automatiquement (expand). off : labels décochés par l'utilisateur
  // ([{id, name}]), affichés mais non chargés.
  // exclude : labels décochés dans la recherche ; s'ils sont des sous-labels,
  // ils apparaissent décochés au lieu d'être ajoutés.
  async function openLabels(ids, { expand = true, off = [], exclude = [] } = {}) {
    ids = [...new Set(ids)];
    if (port) { port.disconnect(); port = null; }
    if (!ids.length && !off.length) { state.view = "home"; render(); return; }
    const token = {};
    Object.assign(state, {
      view: "label", labelIds: ids, labels: ids.map((id) => ({ id, name: "…", relations: [] })), off,
      infosLoaded: false, groups: new Map(), matches: new Map(), progress: {}, doneIds: new Set(),
      loadDone: !ids.length, error: null, shown: PAGE, cachedAt: null, openToken: token,
      expanding: expand,
    });
    requested = new Set();
    lastPrioKey = "";
    cardCache = new Map();
    state.filters.text = "";
    render();

    // Fiches des labels (noms, alias, labels liés), en cache après la 1re fois.
    const infos = new Map();
    const fetchInfo = async (id) => {
      try { infos.set(id, await call("labelInfo", { mbid: id })); }
      catch (e) { state.error = e.message; }
    };
    await Promise.all(ids.map(fetchInfo));
    if (state.openToken !== token) return;

    if (expand) {
      const offIds = new Set(off.map((o) => o.id));
      const excluded = new Set(exclude.map((o) => o.id));
      const subs = new Map();
      for (const id of ids) {
        for (const r of infos.get(id)?.relations || []) {
          if (!isSubLabel(r) || ids.includes(r.id) || offIds.has(r.id)) continue;
          if (excluded.has(r.id)) { off.push({ id: r.id, name: r.name }); offIds.add(r.id); }
          else subs.set(r.id, r);
        }
      }
      state.off = off;
      await Promise.all([...subs.keys()].map(fetchInfo));
      if (state.openToken !== token) return;
      ids = [...ids, ...subs.keys()];
      state.labelIds = ids;
      state.expanding = false;
    }
    state.labels = ids.map((id) => infos.get(id) || { id, name: id, relations: [] });
    state.infosLoaded = true;
    remember();
    render();
    if (!ids.length) return;

    port = chrome.runtime.connect({ name: "catalog" });
    const myPort = port;
    myPort.onMessage.addListener((m) => {
      if (myPort !== port) return;
      if (m.kind === "groups") mergeGroups(m.groups);
      else if (m.kind === "progress") state.progress[m.mbid] = m;
      else if (m.kind === "done") {
        state.doneIds.add(m.mbid);
        if (m.cached) state.cachedAt = Math.min(state.cachedAt || Infinity, m.t);
        state.loadDone = state.doneIds.size === ids.length;
      } else if (m.kind === "match") state.matches.set(m.id, m.result);
      else if (m.kind === "error") state.error = m.error;
      scheduleRender();
    });
    myPort.postMessage({ cmd: "load", mbids: ids });
    render();
  }

  // Coche / décoche un label dans le catalogue affiché.
  function toggleLabel(id, name) {
    const ids = state.labelIds || [];
    const off = state.off || [];
    if (ids.includes(id)) openLabels(ids.filter((x) => x !== id), { expand: false, off: [...off, { id, name }] });
    else openLabels([...ids, id], { expand: false, off: off.filter((o) => o.id !== id) });
  }

  // Un même album peut figurer dans plusieurs labels : on fusionne les éditions.
  function mergeGroups(groups) {
    for (const g of groups) {
      const ex = state.groups.get(g.id);
      if (!ex) { state.groups.set(g.id, { ...g, releases: [...g.releases] }); continue; }
      const seen = new Set(ex.releases.map((r) => r.id));
      for (const r of g.releases) if (!seen.has(r.id)) ex.releases.push(r);
      if (g.date && (!ex.date || g.date < ex.date)) ex.date = g.date;
    }
  }

  function viewTitle() {
    const names = (state.labels || []).map((l) => l.name);
    return names.length > 1 ? `${names[0]} + ${names.length - 1} label${names.length > 2 ? "s" : ""}` : names[0] || "Label";
  }

  function remember() {
    if (!state.infosLoaded) return;
    const ids = state.labelIds;
    const keyOf = (list) => [...list].sort().join(",");
    const key = keyOf(ids);
    const recent = [{ ids, off: state.off || [], name: viewTitle() },
      ...(state.prefs.recent || []).filter((r) => keyOf(r.ids || [r.id]) !== key)].slice(0, 12);
    state.prefs.recent = recent;
    call("setPrefs", { prefs: { recent } }).catch(() => {});
  }

  function labelNames() {
    return (state.labels || []).flatMap((l) => [l.name, ...(l.aliases || [])]).filter((n) => n && n !== "…");
  }

  function progressSum() {
    const ps = Object.values(state.progress || {});
    if (!ps.length) return null;
    return { loaded: ps.reduce((s, p) => s + p.loaded, 0), total: ps.reduce((s, p) => s + p.total, 0) };
  }

  // Tout le catalogue est vérifié sur Deezer, en commençant par les albums
  // qui correspondent aux filtres et au tri courants.
  function requestMatches(ordered) {
    if (!port || !state.infosLoaded) return;
    const pending = ordered.filter((g) => !state.matches.has(g.id));
    const head = pending.slice(0, PAGE * 2);
    const key = head.map((g) => g.id).join(",");
    if (key && key !== lastPrioKey) {
      lastPrioKey = key;
      head.forEach((g) => requested.add(g.id));
      port.postMessage({ cmd: "match", groups: head, labelNames: labelNames(), priority: true });
    }
    const rest = [...state.groups.values()].filter((g) => !requested.has(g.id) && !state.matches.has(g.id));
    if (rest.length) {
      rest.forEach((g) => requested.add(g.id));
      port.postMessage({ cmd: "match", groups: rest, labelNames: labelNames(), priority: false });
    }
  }

  // --- Filtrage / tri ------------------------------------------------------
  // available=false : catalogue filtré complet (pour l'ordre des vérifications)
  function filteredGroups(available = true) {
    const f = state.filters;
    const q = norm(f.text);
    let list = [...state.groups.values()];
    if (f.type !== "all") list = list.filter((g) => (g.type || "").startsWith(f.type));
    if (q) {
      list = list.filter((g) => norm(`${g.title} ${state.matches.get(g.id)?.album?.title || ""} ${g.artist} ${
        g.releases.map((r) => r.catno).join(" ")}`).includes(q));
    }
    if (available) list = list.filter((g) => AVAILABLE.includes(state.matches.get(g.id)?.status));
    const catno = (g) => g.releases.map((r) => r.catno).filter(Boolean).sort(naturalCmp)[0] || "~~~~";
    const sorters = {
      "date-desc": (a, b) => (b.date || "").localeCompare(a.date || ""),
      "date-asc": (a, b) => (a.date || "9999").localeCompare(b.date || "9999"),
      title: (a, b) => naturalCmp(a.title, b.title),
      artist: (a, b) => naturalCmp(a.artist, b.artist),
      catno: (a, b) => naturalCmp(catno(a), catno(b)),
    };
    return list.sort(sorters[f.sort] || sorters["date-desc"]);
  }

  // --- Rendu ---------------------------------------------------------------
  let renderPending = false;
  function scheduleRender() {
    if (renderPending) return;
    renderPending = true;
    setTimeout(() => { renderPending = false; render(); }, 250);
  }

  const bodyEl = h("div", { class: "body" });
  let lastViewKey = "";
  let lastFullKey = "";
  let refs = null;            // parties de la vue « label » mises à jour sur place
  let cardCache = new Map();  // cartes d'albums déjà construites

  function render() {
    if (!state.open) return;
    syncTheme();
    // Vue « label » déjà affichée et structure inchangée : simple mise à jour.
    const fullKey = state.view === "label"
      ? JSON.stringify([state.labelIds, (state.off || []).map((o) => o.id), state.infosLoaded, state.expanding,
        state.error, (state.labels || []).map((l) => l.name)])
      : "home";
    if (state.view === "label" && refs && fullKey === lastFullKey && panel.contains(bodyEl)) {
      patchLabel();
      return;
    }
    lastFullKey = fullKey;
    if (state.view !== "label") refs = null;
    // Préserve le focus/la saisie dans le champ de filtre pendant les mises à jour.
    const active = root.activeElement;
    const activeKey = active?.dataset?.key;
    const caret = active?.selectionStart;
    // La zone qui défile (bodyEl) est conservée : seul son contenu est remplacé,
    // ce qui garde la position de défilement pendant les mises à jour.
    const viewKey = state.view === "label" ? "label:" + (state.labelIds || []).join(",") : "home";
    const fresh = state.view === "label" ? labelView() : homeView();
    const saved = bodyEl.scrollTop;
    panel.replaceChildren(header(), bodyEl);
    bodyEl.replaceChildren(...fresh.childNodes);
    if (activeKey) {
      const el = panel.querySelector(`[data-key="${activeKey}"]`);
      if (el) {
        el.focus({ preventScroll: true });
        // setSelectionRange fait défiler jusqu'au champ : la position est rétablie juste après.
        if (caret != null && el.setSelectionRange) el.setSelectionRange(caret, caret);
      }
    }
    if (viewKey !== lastViewKey) { bodyEl.scrollTop = 0; lastViewKey = viewKey; }
    else if (bodyEl.scrollTop !== saved) bodyEl.scrollTop = saved;
  }

  function header() {
    return h("header", { class: "head" },
      state.view === "label"
        ? h("button", { class: "icon-btn", title: "Retour", onclick: () => { state.view = "home"; if (port) port.disconnect(); port = null; render(); } }, "←")
        : null,
      h("div", { class: "head-title" }, state.view === "label" ? viewTitle() : "Catalogues de labels"),
      h("button", { class: "icon-btn", title: "Fermer", onclick: () => toggle(false) }, "✕"));
  }

  function labelRow(l, note) {
    const meta = [l.type, l.country, l.begin && `${year(l.begin)}${l.end ? "–" + year(l.end) : ""}`].filter(Boolean).join(" · ");
    return h("button", { class: "label-row", onclick: () => openLabel(l.id) },
      h("div", { class: "label-name" }, l.name, l.disambiguation ? h("span", { class: "muted" }, ` (${l.disambiguation})`) : null),
      meta || note ? h("div", { class: "muted small" }, [note, meta].filter(Boolean).join(" — ")) : null);
  }

  function selectRow(l, sel) {
    const meta = [l.type, l.country, l.begin && `${year(l.begin)}${l.end ? "–" + year(l.end) : ""}`].filter(Boolean).join(" · ");
    return h("label", { class: "label-row sel-row" },
      h("input", { type: "checkbox", checked: sel.has(l.id), onchange: (e) => {
        // Un sous-label décoché à la main ne sera pas réajouté automatiquement.
        if (e.target.checked) { sel.add(l.id); state.userUnchecked.delete(l.id); }
        else { sel.delete(l.id); state.userUnchecked.add(l.id); }
        render();
      } }),
      h("div", {},
        h("div", { class: "label-name" }, l.name, l.disambiguation ? h("span", { class: "muted" }, ` (${l.disambiguation})`) : null),
        meta ? h("div", { class: "muted small" }, meta) : null));
  }

  // Pré-coche les labels dont le nom (ou la description) contient le mot cherché,
  // sauf les éditeurs, distributeurs, etc. qui ne publient pas de disques.
  const NOT_RECORD_LABEL = /publisher|distributor|holding|rights society|manufacturer|bootleg/i;
  function autoSelect(q, list) {
    const k = norm(q);
    return new Set(list.filter((l) =>
      !NOT_RECORD_LABEL.test(l.type || "") &&
      !/not for release/i.test(l.disambiguation || "") &&
      (norm(l.name).includes(k) || norm(l.disambiguation).includes(k))).map((l) => l.id));
  }

  function homeView() {
    const body = h("div", { class: "body" });

    // Album courant
    if (state.album) {
      const s = state.suggestions;
      body.append(h("section", { class: "card-block" },
        h("div", { class: "small muted" }, "Album affiché"),
        h("div", { class: "strong" }, state.album.title),
        h("div", { class: "muted" }, `Label sur Deezer : ${state.album.label || "inconnu"}`),
        !s ? h("button", { class: "btn primary", onclick: suggestFromAlbum }, "Parcourir ce label") : null,
        s?.loading ? h("div", { class: "muted" }, "Recherche du label dans MusicBrainz…") : null,
        s?.error ? h("div", { class: "error" }, s.error) : null,
        s && !s.loading ? h("div", { class: "list" },
          s.byBarcode.map((l) => labelRow(l, `trouvé via le code-barres${l.catno ? " · " + l.catno : ""}`)),
          s.byName.filter((l) => !s.byBarcode.some((b) => b.id === l.id)).map((l) => labelRow(l)),
          !s.byBarcode.length && !s.byName.length ? h("div", { class: "muted" }, "Aucun label correspondant dans MusicBrainz. Essayez la recherche ci-dessous.") : null
        ) : null));
    }

    // Recherche
    let input;
    const form = h("form", { class: "search", onsubmit: (e) => { e.preventDefault(); searchLabels(input.value); } },
      input = h("input", { type: "search", placeholder: "Nom du label (ex. Harmonia Mundi, BIS, Alpha…)", "data-key": "label-q", value: state.lastQ || "", oninput: (e) => { state.lastQ = e.target.value; } }),
      h("button", { class: "btn primary", type: "submit" }, "Chercher"));
    body.append(h("section", {}, h("h3", {}, "Rechercher un label"), form));

    if (state.searching) body.append(h("div", { class: "muted" }, "Recherche…"));
    else if (state.searchResults?.error) body.append(h("div", { class: "error" }, state.searchResults.error));
    else if (Array.isArray(state.searchResults)) {
      const res = state.searchResults;
      const sel = state.selected;
      if (!res.length) body.append(h("div", { class: "muted" }, "Aucun résultat."));
      else {
        body.append(h("div", { class: "sel-bar" },
          h("button", { class: "btn primary", disabled: !sel.size, onclick: () => openLabels(
            res.filter((l) => sel.has(l.id)).map((l) => l.id),
            { exclude: res.filter((l) => state.userUnchecked.has(l.id)).map((l) => ({ id: l.id, name: l.name })) }) },
            sel.size > 1 ? `Parcourir les ${sel.size} labels cochés` : "Parcourir le label coché"),
          h("button", { class: "link small", onclick: () => { res.forEach((l) => sel.add(l.id)); render(); } }, "tout cocher"),
          h("button", { class: "link small", onclick: () => { sel.clear(); render(); } }, "tout décocher")));
        body.append(h("div", { class: "list" }, res.map((l) => selectRow(l, sel))));
      }
    }

    // Récents
    const recent = state.prefs.recent || [];
    if (recent.length) {
      body.append(h("section", {}, h("h3", {}, "Récemment consultés"),
        h("div", { class: "chips" }, recent.map((r) => h("button", { class: "chip", onclick: () => openLabels(r.ids || [r.id], { expand: !r.ids, off: r.off || [] }) }, r.name)))));
    }

    // Réglage de navigation
    body.append(h("label", { class: "pref small muted" },
      h("input", { type: "checkbox", checked: state.prefs.inApp, onchange: (e) => {
        state.prefs.inApp = e.target.checked; call("setPrefs", { prefs: { inApp: e.target.checked } }).catch(() => {});
      } }),
      " Ouvrir les albums sans recharger la page (décochez si le clic sur un album ne fait rien)"));
    return body;
  }

  function labelView() {
    const body = h("div", { class: "body" });
    const labels = state.labels || [];
    const ids = state.labelIds || [];
    const off = state.off || [];
    if (!state.infosLoaded) {
      body.append(h("div", { class: "muted small" }, state.expanding ? "Recherche des sous-labels…" : "Chargement des fiches des labels…"));
    } else if (labels.length === 1 && !off.length) {
      const l = labels[0];
      const meta = [l.type, l.country, l.begin && `depuis ${year(l.begin)}`, l.end && `jusqu'à ${year(l.end)}`].filter(Boolean).join(" · ");
      body.append(h("div", { class: "muted small" }, meta,
        meta ? " · " : "", h("a", { href: `https://musicbrainz.org/label/${l.id}`, target: "_blank", rel: "noopener" }, "Fiche MusicBrainz")));
    } else {
      // Labels du catalogue, cochés par défaut (label + sous-labels) ; un clic coche/décoche.
      const chip = (id, name, on) => h("button", {
        class: `chip toggle${on ? " on" : ""}`, "aria-pressed": on ? "true" : "false",
        title: on ? `Retirer ${name} du catalogue` : `Ajouter ${name} au catalogue`,
        onclick: () => toggleLabel(id, name),
      }, h("span", { class: "box" }, on ? "✓" : ""), name);
      body.append(h("div", {}, h("div", { class: "small muted sub" }, "Labels inclus — cliquez pour cocher ou décocher"),
        h("div", { class: "chips" },
          labels.map((l) => chip(l.id, l.name, true)),
          off.map((o) => chip(o.id, o.name, false)))));
    }

    // Autres labels liés (label parent, distributeur…) : « + » les ajoute au catalogue.
    const REL = {
      "label ownership": ["Label parent", "Sous-label"],
      imprint: ["Marque de", "Marque"],
      "label rename": ["Ancien nom", "Nouveau nom"],
      "label reissue": ["Rééditions par", "Réédite"],
      "label distribution": ["Distribué par", "Distribue"],
    };
    const related = new Map();
    const known = new Set([...ids, ...off.map((o) => o.id)]);
    for (const l of labels) for (const r of l.relations || []) if (!known.has(r.id) && !related.has(r.id)) related.set(r.id, r);
    if (state.infosLoaded && related.size) {
      body.append(h("div", {}, h("div", { class: "small muted sub" }, "Autres labels liés"),
        h("div", { class: "chips" }, [...related.values()].map((r) => {
          const names = REL[r.type] || [r.type, r.type];
          const kind = r.direction === "backward" ? names[0] : names[1];
          return h("button", { class: "chip", title: `Ajouter ${r.name} à ce catalogue`, onclick: () => toggleLabel(r.id, r.name) },
            h("span", { class: "plus" }, "+ "), r.name, h("span", { class: "muted" }, ` · ${kind}`));
        }))));
    }

    const p = progressSum();
    if (state.error) {
      body.append(h("div", { class: "card-block" },
        h("div", { class: "error" }, state.error),
        !state.loadDone && p
          ? h("div", { class: "muted small" }, `Chargement interrompu à ${p.loaded} / ${p.total} éditions. Les pages déjà chargées sont conservées.`)
          : null,
        h("button", { class: "btn primary", onclick: () => openLabels(ids, { expand: false, off }) }, p ? "Reprendre le chargement" : "Réessayer")));
    }

    // Filtres : ils ne sont jamais reconstruits pendant le chargement
    // (pas de perte de focus ni de saisie).
    const f = state.filters;
    const set = (k) => (e) => {
      f[k] = e.target.value;
      state.shown = PAGE;
      patchLabel();
    };
    const filters = h("div", { class: "filters" },
      h("input", { type: "search", placeholder: "Filtrer : titre, compositeur, interprète, n° de catalogue", value: f.text, "data-key": "filter", oninput: set("text") }),
      h("span", { class: "select" }, h("select", { onchange: set("sort"), "data-key": "sort" },
        [["date-desc", "Plus récents"], ["date-asc", "Plus anciens"], ["catno", "N° de catalogue"], ["title", "Titre"], ["artist", "Artiste"]]
          .map(([v, t]) => h("option", { value: v, selected: f.sort === v }, t)))),
      h("span", { class: "select" }, h("select", { onchange: set("type"), "data-key": "type" },
        [["all", "Tous types"], ["Album", "Albums"], ["Single", "Singles"], ["EP", "EP"]]
          .map(([v, t]) => h("option", { value: v, selected: f.type === v }, t)))));

    // Statut et grille : mis à jour sur place par patchLabel().
    refs = { status: h("div", { class: "status-box" }), grid: h("div", { class: "grid" }), tail: h("div", { class: "tail" }) };
    body.append(refs.status, filters, refs.grid, refs.tail);
    patchLabel();
    return body;
  }

  // Mise à jour légère pendant le chargement : statut + grille. Les cartes déjà
  // affichées sont conservées telles quelles ; seules les nouvelles sont insérées.
  // Rien n'est reconstruit et la position de défilement n'est jamais modifiée,
  // ce qui préserve le défilement avec inertie.
  function patchLabel() {
    if (!refs) return;
    const ids = state.labelIds || [];
    const off = state.off || [];
    const p = progressSum();
    const nGroups = state.groups.size;
    const checked = state.matches.size;
    const avail = [...state.matches.values()].filter((m) => AVAILABLE.includes(m.status)).length;
    const checking = state.loadDone && checked < nGroups;
    refs.status.replaceChildren(h("div", { class: "status small" },
      !state.loadDone
        ? (state.error ? `${nGroups} albums chargés · ${avail} sur Deezer`
          : `Chargement du catalogue MusicBrainz… ${p ? `${p.loaded} / ${p.total} éditions` : ""}`)
        : checking
          ? `Recherche sur Deezer… ${checked} / ${nGroups} albums · ${avail} trouvés`
          : `${avail} albums sur Deezer (${nGroups} au catalogue)`,
      state.loadDone && state.cachedAt
        ? h("span", {}, ` · catalogue du ${new Date(state.cachedAt).toLocaleDateString()} `,
          h("button", { class: "link", onclick: async () => {
            for (const id of ids) await call("clearCatalog", { mbid: id });
            openLabels(ids, { expand: false, off });
          } }, "actualiser"))
        : null),
      !state.loadDone && p && !state.error ? progressBar(p.loaded, p.total) : checking ? progressBar(checked, nGroups) : "");

    // Grille : uniquement les albums trouvés sur Deezer.
    requestMatches(filteredGroups(false));
    const list = filteredGroups();
    const visible = list.slice(0, state.shown);
    reconcile(refs.grid, visible.map(cardFor));

    refs.tail.replaceChildren(
      !visible.length && (state.loadDone || state.error)
        ? h("div", { class: "muted empty" }, checking ? "Recherche des albums sur Deezer…" : "Aucun album de ce label trouvé sur Deezer.")
        : "",
      list.length > state.shown
        ? h("button", { class: "btn more", onclick: () => { state.shown += PAGE; patchLabel(); } },
          `Afficher plus (${list.length - state.shown} restants)`)
        : "");
  }

  // Met les enfants de parent dans l'ordre voulu en déplaçant le moins possible.
  function reconcile(parent, els) {
    const wanted = new Set(els);
    for (const c of [...parent.children]) if (!wanted.has(c)) c.remove();
    els.forEach((el, i) => {
      if (parent.children[i] !== el) parent.insertBefore(el, parent.children[i] || null);
    });
  }

  function cardFor(g) {
    const key = `${g.id}:${state.matches.get(g.id).album.id}`;
    let el = cardCache.get(key);
    if (!el) { el = card(g); cardCache.set(key, el); }
    return el;
  }

  function progressBar(done, total) {
    const fill = h("div");
    fill.style.width = `${Math.min(100, (100 * done) / Math.max(1, total))}%`; // CSSOM : autorisé par la CSP
    return h("div", { class: "bar" }, fill);
  }

  function card(g) {
    const a = state.matches.get(g.id).album;
    const catnos = [...new Set(g.releases.map((r) => r.catno).filter(Boolean))];
    const cover = a.cover
      ? h("img", { src: a.cover, alt: "", loading: "lazy" })
      : h("div", { class: "ph" }, (a.title || "?").slice(0, 1).toUpperCase());
    return h("a", {
      class: "item",
      href: `/${lang()}/album/${a.id}`,
      title: `${a.title} — ${g.artist || a.artist}`,
      onclick: (e) => openAlbum(a.id, e),
    },
      h("div", { class: "cover" }, cover),
      h("div", { class: "t" }, a.title || g.title),
      h("div", { class: "a" }, g.artist || a.artist),
      h("div", { class: "m" }, [year(g.date), catnos.slice(0, 2).join(", ")].filter(Boolean).join(" · ")));
  }

  function CSS() {
    return `
:host {
  all: initial;
  /* Valeurs par défaut (thème sombre de Deezer), remplacées par celles de la page */
  --font: "Deezer Product", system-ui, -apple-system, "Segoe UI", sans-serif;
  --bg: #121216; --fg: #ffffff; --acc: #a238ff;
  --bg2: color-mix(in srgb, var(--fg) 7%, var(--bg));
  --bg3: color-mix(in srgb, var(--fg) 13%, var(--bg));
  --line: color-mix(in srgb, var(--fg) 12%, transparent);
  --mut: color-mix(in srgb, var(--fg) 62%, var(--bg));
  --link: color-mix(in srgb, var(--acc) 75%, var(--fg));
}
* { box-sizing: border-box; }
.tab, .panel, button, input, select { font-family: var(--font), sans-serif; }
.tab { position: fixed; right: 0; top: 38%; z-index: 2147483646; display: flex; align-items: center; gap: 6px;
  max-width: 220px; padding: 10px 14px 10px 12px; border: 0; border-radius: 999px 0 0 999px; cursor: pointer;
  background: var(--acc); color: #fff; font-size: 13px; font-weight: 700; line-height: 1.2;
  box-shadow: 0 4px 16px rgba(0,0,0,.3); }
.tab:hover { filter: brightness(1.08); }
.tab.hidden { display: none; }
.tab-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.panel { position: fixed; top: 0; right: 0; bottom: 0; z-index: 2147483647; width: min(580px, 100vw);
  display: none; flex-direction: column; background: var(--bg); color: var(--fg);
  font-size: 14px; line-height: 1.43; border-left: 1px solid var(--line); box-shadow: -12px 0 40px rgba(0,0,0,.35); }
.panel.open { display: flex; }
.head { display: flex; align-items: center; gap: 8px; padding: 16px 20px; }
.head-title { flex: 1; font-weight: 700; font-size: 22px; letter-spacing: -.01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.icon-btn { display: grid; place-items: center; width: 36px; height: 36px; background: none; border: 0; color: var(--fg);
  font-size: 18px; cursor: pointer; border-radius: 50%; }
.icon-btn:hover { background: var(--bg2); }
.body { flex: 1; overflow-y: auto; padding: 4px 20px 24px; display: flex; flex-direction: column; gap: 14px; }
h3 { margin: 6px 0 10px; font-size: 16px; font-weight: 700; color: var(--fg); }
a { color: var(--link); text-decoration: none; } a:hover { text-decoration: underline; }
.muted { color: var(--mut); } .small { font-size: 12px; } .strong { font-weight: 700; font-size: 16px; }
.error { color: #ff5c5c; }
.card-block { background: var(--bg2); border-radius: 8px; padding: 16px; display: flex; flex-direction: column; gap: 6px; }
.btn { border: 0; border-radius: 999px; padding: 0 20px; height: 40px; cursor: pointer; font-size: 14px; font-weight: 700;
  background: var(--bg3); color: var(--fg); }
.btn:hover { filter: brightness(1.1); }
.btn.primary { background: var(--acc); color: #fff; align-self: flex-start; }
.btn.more { align-self: center; margin-top: 4px; }
.link { background: none; border: 0; color: var(--link); cursor: pointer; font: inherit; padding: 0; }
.link:hover { text-decoration: underline; }
.search { display: flex; gap: 8px; }
input[type=search], select { height: 40px; background: var(--bg2); color: var(--fg); border: 1px solid transparent;
  border-radius: 999px; padding: 0 16px; font-size: 14px; min-width: 0; outline: none; }
input[type=search]:focus, select:focus { border-color: var(--acc); }
input[type=search]::placeholder { color: var(--mut); }
/* Flèche dessinée en CSS, à l'intérieur de la pastille (la flèche native débordait) */
.select { position: relative; display: inline-flex; }
.select select { appearance: none; -webkit-appearance: none; padding: 0 40px 0 16px; cursor: pointer; }
.select::after { content: ""; position: absolute; right: 18px; top: 50%; width: 6px; height: 6px; pointer-events: none;
  border-right: 2px solid var(--fg); border-bottom: 2px solid var(--fg); transform: translateY(-70%) rotate(45deg); }
select option { background: var(--bg); color: var(--fg); }
.search input { flex: 1; }
.list { display: flex; flex-direction: column; gap: 2px; }
.label-row { text-align: left; background: none; color: var(--fg); border: 0; border-radius: 8px; padding: 10px 12px;
  cursor: pointer; font-size: 14px; }
.label-row:hover { background: var(--bg2); }
.label-name { font-weight: 700; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip { background: var(--bg2); color: var(--fg); border: 0; border-radius: 999px; padding: 6px 14px; cursor: pointer;
  font-size: 13px; font-weight: 600; }
.chip:hover { background: var(--bg3); }
.pref { display: flex; gap: 8px; align-items: flex-start; margin-top: 8px; }
.pref input { accent-color: var(--acc); }
.status { color: var(--mut); }
.bar { height: 4px; background: var(--bg3); border-radius: 2px; overflow: hidden; }
.bar > div { height: 100%; background: var(--acc); transition: width .3s; }
.filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.filters input[type=search] { flex: 1 1 100%; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 20px 16px; }
.item { display: flex; flex-direction: column; gap: 2px; color: var(--fg); text-decoration: none; }
.item:hover { text-decoration: none; }
.item:hover .cover img { filter: brightness(.85); }
.item:hover .t { text-decoration: underline; }
.cover { aspect-ratio: 1; border-radius: 8px; overflow: hidden; background: var(--bg3); margin-bottom: 8px; }
.cover img { width: 100%; height: 100%; object-fit: cover; display: block; transition: filter .15s; }
.ph { width: 100%; height: 100%; display: grid; place-items: center; font-size: 42px; font-weight: 700; color: var(--mut); }
.t { font-weight: 600; font-size: 14px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.a { font-size: 13px; color: var(--mut); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.m { font-size: 12px; color: var(--mut); }
.empty { padding: 24px 0; text-align: center; }
.sub { margin-bottom: 6px; }
.sel-bar { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.btn:disabled { opacity: .4; cursor: default; filter: none; }
.sel-row { display: flex; align-items: flex-start; gap: 12px; }
.sel-row input { margin-top: 3px; width: 16px; height: 16px; accent-color: var(--acc); flex: none; cursor: pointer; }
.chip.toggle { display: inline-flex; align-items: center; gap: 7px; color: var(--mut); }
.chip.toggle.on { background: color-mix(in srgb, var(--acc) 22%, var(--bg)); color: var(--fg); }
.chip .box { display: inline-grid; place-items: center; width: 14px; height: 14px; border-radius: 4px;
  border: 1.5px solid var(--mut); font-size: 10px; line-height: 1; color: #fff; }
.chip.on .box { background: var(--acc); border-color: var(--acc); }
.plus { color: var(--acc); font-weight: 700; }
`;
  }

  // --- Démarrage -----------------------------------------------------------
  call("getPrefs").then((p) => { state.prefs = { inApp: true, recent: [], ...p }; }).catch(() => {});
  renderTab();
  onUrlChange();
})();
