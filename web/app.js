// Application web : enveloppe de la page autour du moteur de recherche de
// l'extension (works.js), plein écran, installable sur l'écran d'accueil.
(() => {
  // --- Utilitaires (mêmes conventions que l'extension) -------------------------
  const call = (type, extra = {}) =>
    new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type, ...extra }, (res) => {
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
  const norm = (s) => (s || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();

  // --- Styles : la feuille de l'extension, adaptée à une page normale ----------
  const style = document.createElement("style");
  style.textContent = window.__dzClassiqueCSS.replace(":host {\n  all: initial;", ":root {").replace(/:host\b/g, ":root");
  document.head.prepend(style); // avant les réglages de la page (thème clair…)

  // --- Ouverture des albums ------------------------------------------------------
  // Sur téléphone : directement dans l'appli Deezer (lien deezer://) ;
  // sur ordinateur : deezer.com dans un nouvel onglet. Réglable sur l'accueil.
  const touch = matchMedia("(pointer: coarse)").matches;
  const state = { prefs: { open: touch ? "app" : "web" } };
  const useApp = () => state.prefs.open === "app";
  const albumUrl = (id) => (useApp() ? `deezer://www.deezer.com/album/${id}` : `https://www.deezer.com/album/${id}`);

  function setPref(k, v) {
    state.prefs[k] = v;
    call("setPrefs", { prefs: { [k]: v } }).catch(() => {});
  }

  const homeFooter = () => h("div", { class: "pref small muted web-pref" },
    "Ouvrir les albums dans ",
    h("span", { class: "select" }, h("select", { onchange: (e) => { setPref("open", e.target.value); location.reload(); } },
      h("option", { value: "app", selected: useApp() }, "l'appli Deezer"),
      h("option", { value: "web", selected: !useApp() }, "deezer.com (navigateur)"))),
    h("div", { class: "web-about" },
      "Projet personnel, non affilié à Deezer. Données : ",
      h("a", { href: "https://openopus.org", target: "_blank", rel: "noopener" }, "Open Opus"), ", ",
      h("a", { href: "https://musicbrainz.org", target: "_blank", rel: "noopener" }, "MusicBrainz"), ", API Deezer."));

  // --- Page ----------------------------------------------------------------------
  const worksEl = h("div", { class: "w-host" });
  const panel = h("main", { class: "panel open web" },
    h("header", { class: "head" },
      h("div", { class: "head-title" }, h("span", { class: "brand" }, "🎼 Classique"), h("span", { class: "muted small" }, " · recherche pour Deezer"))),
    worksEl);
  document.body.append(panel);

  let works = null, pending = false;
  function render() { works.render(worksEl); }
  function scheduleRender() {
    if (pending) return;
    pending = true;
    setTimeout(() => { pending = false; render(); }, 250);
  }

  call("getPrefs").catch(() => ({})).then((p) => {
    Object.assign(state.prefs, p || {});
    works = window.__dzWorks({
      h, call, norm, lang: () => "fr",
      albumUrl, albumTarget: useApp() ? null : "_blank",
      openAlbum: () => {}, // le lien suffit (appli ou nouvel onglet)
      schedule: (now) => (now ? render() : scheduleRender()),
      prefs: () => state.prefs, setPref, homeFooter,
    });
    render();
  });

  // Installation hors ligne de l'interface (le cache des recherches est dans IndexedDB).
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
