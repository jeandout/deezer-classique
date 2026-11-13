// Service worker de Deezer Classique : briques communes (files d'attente à
// débit limité, requêtes avec reprise, cache local), puis le mode Œuvres
// (bg-works.js).

const MB = "https://musicbrainz.org/ws/2";
const DZ = "https://api.deezer.com";
const USER_AGENT = "DeezerClassique/0.6.1 (extension personnelle)";

const DAY = 24 * 3600 * 1000;
const TTL = {};

// --- User-Agent pour MusicBrainz -------------------------------------------
// MusicBrainz demande un User-Agent identifiant l'application. Un fetch() ne
// peut pas le modifier : règle declarativeNetRequest limitée aux requêtes de
// l'extension elle-même (tabId -1).
chrome.declarativeNetRequest.updateSessionRules({
  removeRuleIds: [1],
  addRules: [{
    id: 1,
    priority: 1,
    action: { type: "modifyHeaders", requestHeaders: [{ header: "User-Agent", operation: "set", value: USER_AGENT }] },
    condition: { requestDomains: ["musicbrainz.org"], tabIds: [-1] },
  }],
}).catch((e) => console.warn("Règle User-Agent non installée", e));

// --- Files d'attente à débit limité ----------------------------------------
// Deux niveaux : les requêtes « urgentes » (action directe de l'utilisateur)
// passent devant les traitements en masse. Quand le serveur signale une
// surcharge, le rythme ralentit pendant une minute.
function makeQueue(baseMs) {
  const high = [], low = [];
  let last = 0, timer = null, interval = baseMs, slowUntil = 0;
  function tick() {
    timer = null;
    if (interval !== baseMs && Date.now() > slowUntil) interval = baseMs;
    const job = high.shift() || low.shift();
    if (!job) return;
    last = Date.now();
    Promise.resolve().then(job.fn).then(job.resolve, job.reject);
    if (high.length || low.length) timer = setTimeout(tick, interval);
  }
  const enqueue = (fn, urgent = false) => new Promise((resolve, reject) => {
    (urgent ? high : low).push({ fn, resolve, reject });
    if (!timer) timer = setTimeout(tick, Math.max(0, last + interval - Date.now()));
  });
  enqueue.slowDown = () => {
    interval = Math.min(baseMs * 4, Math.round(interval * 1.5));
    slowUntil = Date.now() + 60000;
  };
  return enqueue;
}
const mbQueue = makeQueue(1100); // MusicBrainz : 1 requête / seconde
const dzQueue = makeQueue(110);  // Deezer : 50 requêtes / 5 secondes

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRY_STATUS = new Set([429, 502, 503, 504]);

// Jusqu'à 6 tentatives, avec des attentes croissantes (2, 4, 8, 16, 30 s)
// ou celle indiquée par le serveur (Retry-After).
async function getJson(queue, url, urgent = false, tries = 6) {
  let why = "";
  for (let i = 0; i < tries; i++) {
    const backoff = Math.min(30000, 2000 * 2 ** i);
    let res;
    try {
      res = await queue(() => fetch(url, { headers: { Accept: "application/json" } }), urgent);
    } catch (e) {
      why = "erreur réseau";
      await sleep(backoff);
      continue;
    }
    if (RETRY_STATUS.has(res.status)) {
      why = `HTTP ${res.status}`;
      queue.slowDown();
      const retryAfter = Number(res.headers.get("Retry-After"));
      await sleep(retryAfter > 0 ? retryAfter * 1000 : backoff);
      continue;
    }
    if (!res.ok && res.status !== 404) throw new Error(`${new URL(url).host} a répondu HTTP ${res.status}`);
    const data = await res.json();
    // Deezer renvoie 200 avec {error:{code:4}} quand le quota est dépassé.
    if (data && data.error && data.error.code === 4) {
      why = "quota Deezer dépassé";
      queue.slowDown();
      await sleep(backoff);
      continue;
    }
    return data;
  }
  throw new Error(`${new URL(url).host} est surchargé et refuse les requêtes pour le moment (${why}).`);
}
const mb = (path, urgent) => getJson(mbQueue, `${MB}${path}${path.includes("?") ? "&" : "?"}fmt=json`, urgent);
const dz = (path, urgent) => getJson(dzQueue, `${DZ}${path}`, urgent);

// --- Cache (chrome.storage.local) ------------------------------------------
async function cacheGet(key, ttl) {
  const o = (await chrome.storage.local.get(key))[key];
  if (!o) return undefined;
  if (ttl && Date.now() - o.t > ttl) return undefined;
  return o.v;
}
const cacheSet = (key, v) => chrome.storage.local.set({ [key]: { v, t: Date.now() } });
async function cached(key, ttl, fn) {
  const c = await cacheGet(key, ttl);
  if (c !== undefined) return c;
  const v = await fn();
  await cacheSet(key, v);
  return v;
}

// --- Normalisation de textes -------------------------------------------------
function norm(s) {
  return (s || "")
    .replace(/\b(?:n\s*[°º]|nr\.?|no\.?|num\.?)\s*(?=\d)/gi, "no ") // n° 5, Nr. 5, No.5 -> no 5
    .normalize("NFD").replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// --- Mode Œuvres -------------------------------------------------------------
importScripts("bg-works.js");

// --- Messages depuis le panneau ----------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handlers = {
    ...worksHandlers,
    getPrefs: async () => (await chrome.storage.local.get("prefs")).prefs || {},
    setPrefs: async () => {
      const prefs = { ...((await chrome.storage.local.get("prefs")).prefs || {}), ...msg.prefs };
      await chrome.storage.local.set({ prefs });
      return prefs;
    },
  };
  const h = handlers[msg?.type];
  if (!h) return false;
  Promise.resolve(h(msg))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
  return true; // réponse asynchrone
});

// Clic sur l'icône : ouvre/ferme le panneau, ou ouvre Deezer.
chrome.action.onClicked.addListener(async (tab) => {
  if (tab.url && tab.url.startsWith("https://www.deezer.com/")) {
    chrome.tabs.sendMessage(tab.id, { type: "toggle" }).catch(() => {});
  } else {
    chrome.tabs.create({ url: "https://www.deezer.com/" });
  }
});
