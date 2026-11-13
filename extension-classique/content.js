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
  sheet.replaceSync(window.__dzClassiqueCSS);
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
    albumUrl: (id) => `/${lang()}/album/${id}`,
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

  // --- Démarrage -----------------------------------------------------------
  call("getPrefs").then((p) => { state.prefs = { inApp: true, ...p }; }).catch(() => {});
})();
