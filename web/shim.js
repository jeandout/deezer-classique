// Application web : imitation des quelques fonctions Chrome utilisées par le
// code de l'extension, pour le faire tourner tel quel dans une page.
// - chrome.runtime : messages et « ports » entre l'interface et le moteur,
//   ici dans la même page (les messages sont copiés, comme dans Chrome) ;
// - chrome.storage.local : cache local, stocké dans IndexedDB ;
// - fetch vers api.deezer.com : passe par JSONP (l'API Deezer n'autorise pas
//   les requêtes directes depuis une page web) ;
// - importScripts : sans effet (les fichiers sont chargés par index.html).
(() => {
  const clone = (v) => (v === undefined ? v : structuredClone(v));
  const listeners = { message: [], connect: [] };

  // --- Stockage : IndexedDB (clé → valeur) ------------------------------------
  const dbReady = new Promise((resolve, reject) => {
    const req = indexedDB.open("deezer-classique", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  async function run(mode, fn) {
    const db = await dbReady;
    return new Promise((resolve, reject) => {
      const tx = db.transaction("kv", mode);
      const result = fn(tx.objectStore("kv"));
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  const storage = {
    local: {
      async get(keys) {
        const list = keys == null ? [] : Array.isArray(keys) ? keys : [keys];
        const reqs = await run("readonly", (st) => list.map((k) => [k, st.get(k)]));
        const out = {};
        for (const [k, r] of reqs) if (r.result !== undefined) out[k] = r.result;
        return out;
      },
      set: (obj) => run("readwrite", (st) => { for (const [k, v] of Object.entries(obj)) st.put(v, k); }),
      remove: (keys) => run("readwrite", (st) => { for (const k of [].concat(keys)) st.delete(k); }),
    },
  };

  // --- Messages et ports ---------------------------------------------------------
  function makePort(name) {
    const port = {
      name, other: null, closed: false, msgL: [], discL: [],
      postMessage(m) {
        if (port.closed) return;
        const o = port.other, copy = clone(m);
        setTimeout(() => { if (!o.closed) o.msgL.forEach((f) => f(copy)); }, 0);
      },
      disconnect() {
        if (port.closed) return;
        port.closed = port.other.closed = true;
        const o = port.other;
        setTimeout(() => o.discL.forEach((f) => f()), 0);
      },
    };
    port.onMessage = { addListener: (f) => port.msgL.push(f) };
    port.onDisconnect = { addListener: (f) => port.discL.push(f) };
    return port;
  }

  const runtime = {
    lastError: undefined,
    onMessage: { addListener: (f) => listeners.message.push(f) },
    onConnect: { addListener: (f) => listeners.connect.push(f) },
    sendMessage(msg, cb) {
      let answered = false;
      const respond = (r) => { if (!answered) { answered = true; const c = clone(r); setTimeout(() => cb && cb(c), 0); } };
      const copy = clone(msg);
      setTimeout(() => { for (const f of listeners.message) f(copy, {}, respond); }, 0);
    },
    connect({ name }) {
      const a = makePort(name), b = makePort(name);
      a.other = b; b.other = a;
      setTimeout(() => listeners.connect.forEach((f) => f(b)), 0);
      return a;
    },
  };

  const shim = {
    runtime, storage,
    declarativeNetRequest: { updateSessionRules: async () => {} },
    action: { onClicked: { addListener() {} } },
    tabs: {},
  };
  Object.defineProperty(window, "chrome", { value: shim, configurable: true, writable: true });
  window.importScripts = () => {};

  // --- API Deezer via JSONP --------------------------------------------------------
  const realFetch = window.fetch.bind(window);
  let seq = 0;
  function jsonp(url) {
    return new Promise((resolve) => {
      const cb = `__dzcb${Date.now().toString(36)}${seq++}`;
      url.searchParams.set("output", "jsonp");
      url.searchParams.set("callback", cb);
      const script = document.createElement("script");
      const timer = setTimeout(() => finish(new Response("", { status: 504 })), 20000);
      function finish(res) {
        clearTimeout(timer);
        delete window[cb];
        script.remove();
        resolve(res);
      }
      window[cb] = (data) => finish(new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } }));
      script.onerror = () => finish(new Response("", { status: 503 }));
      script.src = url.toString();
      document.head.append(script);
    });
  }
  window.fetch = (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input), location.href);
    return url.host === "api.deezer.com" ? jsonp(url) : realFetch(input, init);
  };
})();
