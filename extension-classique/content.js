// Deezer Classique : bouton flottant et grand panneau injectés dans deezer.com.
// Le contenu du panneau (recherche compositeur → œuvre → enregistrements)
// est fourni par works.js.
(() => {
  if (window.__dzClassique) return;
  window.__dzClassique = true;

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
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      el.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  const lang = () => {
    const seg = location.pathname.split("/")[1];
    return /^[a-z]{2}$/.test(seg) ? seg : "fr";
  };
  const norm = (s) => (s || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();

  const state = { open: false, prefs: { inApp: true } };

  // --- DOM : hôte + Shadow DOM ---------------------------------------------
  const host = h("div", { id: "dz-classique-host" });
  const root = host.attachShadow({ mode: "open" });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(CSS());
  root.adoptedStyleSheets = [sheet];

  const tab = h("button", { class: "tab", title: "Recherche classique : compositeurs, œuvres, interprètes", onclick: () => toggle(true) },
    h("span", { class: "tab-icon" }, "🎼"), h("span", { class: "tab-text" }, "Classique"));
  const tabs = h("div", { class: "tabs-float" }, tab);
  const panel = h("aside", { class: "panel", "aria-label": "Deezer Classique" });
  const worksEl = h("div", { class: "w-host" });
  root.append(tabs, panel);
  document.documentElement.append(host);

  // --- Charte graphique : police et couleurs de la page (thème clair/sombre) ---
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
    const vars = {
      "--font": getComputedStyle(document.body).fontFamily,
      "--bg": pick("backgroundColor", opaque),
      "--fg": getComputedStyle(document.body).color,
    };
    for (const [k, v] of Object.entries(vars)) if (v) host.style.setProperty(k, v);
  }

  // Le panneau s'arrête au-dessus de la barre de lecture de Deezer.
  function playerHeight() {
    const prev = host.style.display;
    host.style.display = "none";
    let el = document.elementFromPoint(innerWidth / 2, innerHeight - 4);
    let best = 0;
    while (el && el !== document.body && el !== document.documentElement) {
      const r = el.getBoundingClientRect();
      if (r.bottom >= innerHeight - 2 && r.height < 220 && r.width > innerWidth * 0.6) best = Math.max(best, r.height);
      el = el.parentElement;
    }
    host.style.display = prev;
    return Math.round(best);
  }
  const placePanel = () => host.style.setProperty("--player", `${playerHeight()}px`);
  addEventListener("resize", () => { if (state.open) placePanel(); });
  addEventListener("keydown", (e) => { if (e.key === "Escape" && state.open) toggle(false); });

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
    tabs.classList.toggle("hidden", state.open);
    if (state.open) { syncTheme(); placePanel(); render(); }
  }
  chrome.runtime.onMessage.addListener((m) => { if (m.type === "toggle") toggle(); });

  // --- Rendu ---------------------------------------------------------------
  let works = null;
  const getWorks = () => works || (works = window.__dzWorks({
    h, call, norm, lang, openAlbum,
    schedule: (now) => (now ? render() : scheduleRender()),
    prefs: () => state.prefs,
    setPref: (k, v) => { state.prefs[k] = v; call("setPrefs", { prefs: { [k]: v } }).catch(() => {}); },
  }));

  let renderPending = false;
  function scheduleRender() {
    if (renderPending) return;
    renderPending = true;
    setTimeout(() => { renderPending = false; render(); }, 250);
  }

  function header() {
    return h("header", { class: "head" },
      h("div", { class: "head-title" }, "🎼 Deezer Classique"),
      h("button", { class: "icon-btn", title: "Fermer (Échap)", onclick: () => toggle(false) }, "✕"));
  }

  function render() {
    if (!state.open) return;
    syncTheme();
    // Le contenu gère lui-même ses mises à jour (construit une fois, puis modifié sur place).
    if (panel.children[1] === worksEl) panel.firstElementChild.replaceWith(header());
    else panel.replaceChildren(header(), worksEl);
    getWorks().render(worksEl);
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
.tabs-float { position: fixed; right: 0; top: 26%; z-index: 2147483646; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
.tabs-float.hidden { display: none; }
.tab { display: flex; align-items: center; gap: 6px;
  max-width: 220px; padding: 10px 14px 10px 12px; border: 0; border-radius: 999px 0 0 999px; cursor: pointer;
  background: var(--acc); color: #fff; font-size: 13px; font-weight: 700; line-height: 1.2;
  box-shadow: 0 4px 16px rgba(0,0,0,.3); }
.tab:hover { filter: brightness(1.08); }
.tab.hidden { display: none; }
.tab-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.panel { position: fixed; top: 0; right: 0; bottom: var(--player, 0px); z-index: 2147483647; width: min(1280px, calc(100vw - 24px));
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
/* --- Onglets de mode --- */
.modes { display: flex; gap: 4px; background: var(--bg2); border-radius: 999px; padding: 4px; }
.mode { border: 0; background: none; color: var(--mut); font-size: 14px; font-weight: 700; padding: 6px 16px; border-radius: 999px; cursor: pointer; }
.mode.on { background: var(--bg); color: var(--fg); box-shadow: 0 1px 4px rgba(0,0,0,.2); }
.mode:hover:not(.on) { color: var(--fg); }
/* --- Mode Œuvres --- */
.w-host, .w-root { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.w-scroll { flex: 1; overflow-y: auto; padding: 4px 24px 32px; display: flex; flex-direction: column; gap: 14px; }
.w-scroll h2, .w-workhead h2 { margin: 0; font-size: 26px; font-weight: 800; letter-spacing: -.01em; }
.w-big { height: 52px !important; font-size: 18px !important; padding: 0 22px !important; }
.w-composers { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 8px; }
.w-composer { display: flex; align-items: center; gap: 12px; text-align: left; background: none; border: 0; color: var(--fg);
  padding: 8px; border-radius: 8px; cursor: pointer; font-size: 14px; }
.w-composer:hover { background: var(--bg2); }
.w-composer img, .w-composer .ph { width: 52px; height: 52px; border-radius: 50%; object-fit: cover; flex: none; font-size: 22px; background: var(--bg3); }
.w-composer-head { display: flex; align-items: center; gap: 18px; }
.w-composer-head img { width: 88px; height: 88px; border-radius: 50%; object-fit: cover; }
.w-crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 13px; color: var(--mut); }
.w-crumbs .cur { color: var(--fg); }
.w-crumbs .sep { opacity: .6; }
.w-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.w-toolbar input[type=search] { flex: 1 1 320px; }
.w-toolbar label { display: flex; align-items: center; gap: 6px; }
.w-toolbar input[type=checkbox] { accent-color: var(--acc); }
.w-chiprows { display: flex; flex-direction: column; gap: 8px; }
.w-chiprow { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.w-chiprow .lbl { width: 84px; flex: none; }
.chip.sel { background: var(--acc); color: #fff; }
.chip .n { opacity: .65; font-weight: 500; font-size: 12px; }
.w-works { display: flex; flex-direction: column; }
.w-work { display: flex; align-items: center; justify-content: space-between; gap: 12px; text-align: left; background: none; border: 0;
  border-bottom: 1px solid var(--line); color: var(--fg); padding: 12px 8px; cursor: pointer; font-size: 14px; }
.w-work:hover { background: var(--bg2); }
.w-work .star { color: var(--acc); }
.tag { font-size: 12px; color: var(--mut); background: var(--bg2); border-radius: 999px; padding: 3px 10px; white-space: nowrap; }
.w-workhead { padding: 4px 24px 12px; display: flex; flex-direction: column; gap: 8px; border-bottom: 1px solid var(--line); }
.w-status { display: flex; flex-direction: column; gap: 6px; }
.w-movs { display: flex; flex-wrap: wrap; gap: 6px; }
.w-movs:empty { display: none; }
.w-tempo-stats { margin: -2px 0 4px; }
.m.dur { color: var(--fg); font-variant-numeric: tabular-nums; }
.w-cols { flex: 1; min-height: 0; display: grid; grid-template-columns: 270px 1fr; }
.w-facets { overflow-y: auto; padding: 16px 16px 32px 24px; border-right: 1px solid var(--line); display: flex; flex-direction: column; gap: 18px; }
.w-results { overflow-y: auto; padding: 16px 24px 32px 20px; display: flex; flex-direction: column; gap: 16px; }
.w-facet { display: flex; flex-direction: column; gap: 2px; }
.w-facet-title { display: flex; justify-content: space-between; align-items: baseline; font-weight: 700; font-size: 14px; margin-bottom: 4px; }
.w-opt { display: flex; align-items: center; gap: 8px; padding: 3px 4px; border-radius: 6px; cursor: pointer; font-size: 13px; }
.w-opt:hover { background: var(--bg2); }
.w-opt input { accent-color: var(--acc); flex: none; margin: 0; }
.w-opt .v { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.w-opt .n { color: var(--mut); font-size: 12px; }
.w-opt.on .v { font-weight: 700; }
.w-facet .link { align-self: flex-start; margin-top: 2px; }
.w-grid { grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); }
.cover { position: relative; }
.w-badge { position: absolute; left: 6px; top: 6px; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 999px; background: rgba(0,0,0,.65); color: #fff; }
.m.rec { color: color-mix(in srgb, var(--acc) 55%, var(--mut)); }
@media (max-width: 760px) {
  .w-cols { grid-template-columns: 1fr; overflow-y: auto; }
  .w-facets, .w-results { overflow: visible; border-right: 0; }
}
`;
  }

  // --- Démarrage -----------------------------------------------------------
  call("getPrefs").then((p) => { state.prefs = { inApp: true, ...p }; }).catch(() => {});
})();
