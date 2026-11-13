// Navigation par label (reprise de l'extension « Catalogues de labels ») :
// identification du label (code-barres ou nom, MusicBrainz), sous-labels,
// catalogue complet page par page, puis recherche de chaque album sur Deezer.
// Chargé par background.js après bg-works.js (utilise mb(), dz(), cached()…).

Object.assign(TTL, {
  catalog: 7 * DAY, matchFound: 90 * DAY, matchNone: 14 * DAY,
  labelSearch: 7 * DAY, labelInfo: 30 * DAY, barcode: 30 * DAY,
});

function tokens(s) { return new Set(norm(s).split(" ").filter(Boolean)); }
function similarity(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return (2 * inter) / (A.size + B.size);
}
const LABEL_NOISE = /\b(records?|recordings?|music|musique|musik|label|ltd|limited|inc|gmbh|sa|sarl|llc|co|company|classics?|entertainment|productions?|editions?)\b/g;
function labelKey(s) { return norm(s).replace(LABEL_NOISE, " ").replace(/\s+/g, " ").trim(); }
function labelMatches(deezerLabel, names) {
  const d = labelKey(deezerLabel);
  if (!d) return false;
  return names.some((n) => {
    const k = labelKey(n);
    return k && (d === k || d.includes(k) || k.includes(d) || similarity(d, k) >= 0.6);
  });
}

// Variantes d'un code-barres : UPC-A (12 chiffres) <-> EAN-13 (avec 0 initial).
function barcodeVariants(code) {
  const c = (code || "").replace(/\D/g, "");
  if (c.length < 8) return [];
  const out = [c];
  if (c.length === 12) out.push("0" + c);
  if (c.length === 13 && c.startsWith("0")) out.push(c.slice(1));
  return out;
}

// --- MusicBrainz -----------------------------------------------------------
function compactLabel(l) {
  return {
    id: l.id,
    name: l.name,
    type: l.type || "",
    country: l.country || l.area?.name || "",
    disambiguation: l.disambiguation || "",
    begin: l["life-span"]?.begin || "",
    end: l["life-span"]?.end || "",
    score: l.score,
  };
}

async function searchLabels(q) {
  // Nom, alias ou description (« sub-label of Chandos »), jusqu'à 50 labels.
  const t = q.replace(/"/g, "");
  const query = `label:"${t}" OR alias:"${t}" OR comment:"${t}"`;
  const data = await mb(`/label?query=${encodeURIComponent(query)}&limit=50`, true);
  return (data.labels || []).map(compactLabel);
}

async function labelsByBarcode(upc) {
  const out = new Map();
  for (const code of barcodeVariants(upc)) {
    const data = await mb(`/release?query=${encodeURIComponent(`barcode:${code}`)}&limit=5`, true);
    for (const r of data.releases || []) {
      for (const li of r["label-info"] || []) {
        if (li.label?.id) out.set(li.label.id, { id: li.label.id, name: li.label.name, catno: li["catalog-number"] || "" });
      }
    }
    if (out.size) break;
  }
  return [...out.values()];
}

async function labelInfo(mbid) {
  const data = await mb(`/label/${mbid}?inc=label-rels+aliases`, true);
  const relations = (data.relations || [])
    .filter((r) => r.label)
    .map((r) => ({ type: r.type, direction: r.direction, id: r.label.id, name: r.label.name }));
  return { ...compactLabel(data), relations, aliases: (data.aliases || []).map((a) => a.name) };
}

function artistCredit(ac) {
  return (ac || []).map((c) => (c.name || c.artist?.name || "") + (c.joinphrase || "")).join("").trim();
}

// Regroupe les éditions (releases) par release-group = l'« album ».
function addReleasesToGroups(groups, releases, mbid) {
  const changed = new Set();
  for (const r of releases) {
    const rg = r["release-group"] || { id: r.id, title: r.title };
    let g = groups[rg.id];
    if (!g) {
      g = groups[rg.id] = {
        id: rg.id,
        title: rg.title || r.title,
        artist: artistCredit(rg["artist-credit"]) || artistCredit(r["artist-credit"]),
        firstArtist: (rg["artist-credit"] || r["artist-credit"] || [])[0]?.name || "",
        date: rg["first-release-date"] || r.date || "",
        type: [rg["primary-type"], ...(rg["secondary-types"] || [])].filter(Boolean).join(" · "),
        releases: [],
      };
    }
    const catnos = (r["label-info"] || [])
      .filter((li) => !mbid || li.label?.id === mbid)
      .map((li) => li["catalog-number"]).filter(Boolean);
    g.releases.push({
      id: r.id,
      barcode: (r.barcode || "").trim(),
      catno: catnos[0] || "",
      date: r.date || "",
      country: r.country || "",
    });
    if (!g.date && r.date) g.date = r.date;
    changed.add(rg.id);
  }
  return [...changed].map((id) => groups[id]);
}

// Charge le catalogue complet d'un label, page par page (100 éditions / page).
// Chaque page est sauvegardée : après une interruption, le chargement
// reprend là où il s'était arrêté.
async function loadCatalog(mbid, send, isCancelled) {
  const cached = await cacheGet(`cat:${mbid}`, TTL.catalog);
  if (cached) {
    send({ kind: "groups", groups: Object.values(cached.groups) });
    send({ kind: "progress", loaded: cached.total, total: cached.total });
    send({ kind: "done", cached: true, t: cached.t });
    return;
  }
  const partial = await cacheGet(`catp:${mbid}`, TTL.catalog);
  const groups = partial?.groups || {};
  let offset = partial?.offset || 0;
  let total = partial?.total ?? Infinity;
  if (partial) {
    send({ kind: "groups", groups: Object.values(groups) });
    send({ kind: "progress", loaded: offset, total });
  }
  while (offset < total) {
    if (isCancelled()) return;
    const data = await mb(`/release?label=${mbid}&inc=release-groups+artist-credits+labels&limit=100&offset=${offset}`);
    total = data["release-count"] ?? 0;
    const releases = data.releases || [];
    send({ kind: "groups", groups: addReleasesToGroups(groups, releases, mbid) });
    offset += releases.length;
    send({ kind: "progress", loaded: offset, total });
    if (!releases.length) break;
    await cacheSet(`catp:${mbid}`, { groups, offset, total });
  }
  await cacheSet(`cat:${mbid}`, { groups, total, t: Date.now() });
  await chrome.storage.local.remove(`catp:${mbid}`);
  send({ kind: "done", cached: false, t: Date.now() });
}

// --- Rapprochement avec Deezer ---------------------------------------------
function compactDz(a) {
  return {
    id: a.id,
    title: a.title,
    artist: a.artist?.name || "",
    cover: a.cover_medium || a.cover || "",
    label: a.label || "",
    date: a.release_date || "",
  };
}

async function dzByUpc(code) {
  const key = `upc:${code}`;
  const c = await cacheGet(key, TTL.matchNone);
  if (c !== undefined) return c;
  const data = await dz(`/album/upc:${code}`);
  const v = data && data.id ? compactDz(data) : null;
  await cacheSet(key, v);
  return v;
}

async function matchGroup(g, labelNames) {
  const key = `m:${g.id}`;
  const cached = (await chrome.storage.local.get(key))[key];
  if (cached) {
    const ttl = cached.v.status === "none" ? TTL.matchNone : TTL.matchFound;
    if (Date.now() - cached.t < ttl) return cached.v;
  }

  let result = { status: "none" };

  // 1) Code-barres : correspondance exacte.
  const codes = [...new Set(g.releases.flatMap((r) => barcodeVariants(r.barcode)))];
  for (const code of codes) {
    const a = await dzByUpc(code);
    if (a) { result = { status: "exact", album: a }; break; }
  }

  // 2) Recherche textuelle sur le titre, vérifiée par le label.
  if (result.status === "none" && g.title) {
    const q = `album:"${g.title.replace(/"/g, "")}"`;
    const data = await dz(`/search/album?q=${encodeURIComponent(q)}&limit=15`);
    const fa = norm(g.firstArtist);
    const candidates = (data.data || [])
      .map((a) => {
        const sim = similarity(g.title, a.title);
        const artistOk = fa && (norm(a.artist?.name).includes(fa) || fa.includes(norm(a.artist?.name)) ||
          norm(g.artist).includes(norm(a.artist?.name)));
        return { a, sim, artistOk, score: sim + (artistOk ? 0.3 : 0) };
      })
      .filter((c) => c.sim >= 0.7)
      .sort((x, y) => y.score - x.score)
      .slice(0, 3);
    for (const c of candidates) {
      const full = await dz(`/album/${c.a.id}`);
      if (!full || !full.id) continue;
      if (labelMatches(full.label, labelNames)) {
        result = { status: "label", album: compactDz(full) };
        break;
      }
      if (result.status === "none" && c.sim >= 0.9 && c.artistOk) {
        result = { status: "probable", album: compactDz(full) };
      }
    }
  }

  await cacheSet(key, result);
  return result;
}


const labelsHandlers = {
  labelsByBarcode: (msg) => cached(`lb:${msg.upc}`, TTL.barcode, () => labelsByBarcode(msg.upc)),
  searchLabels: (msg) => cached(`ls2:${norm(msg.q)}`, TTL.labelSearch, () => searchLabels(msg.q)),
  labelInfo: (msg) => cached(`li:${msg.mbid}`, TTL.labelInfo, () => labelInfo(msg.mbid)),
  clearCatalog: async (msg) => { await chrome.storage.local.remove([`cat:${msg.mbid}`, `catp:${msg.mbid}`, `li:${msg.mbid}`]); return true; },
};

// Port longue durée : chargement du catalogue et rapprochements progressifs.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "catalog") return; // catalogue d'un ou plusieurs labels
  let closed = false;
  port.onDisconnect.addListener(() => { closed = true; });
  const send = (m) => { if (!closed) port.postMessage(m); };

  let matchQueue = [];
  const done = new Set();
  let labelNames = [];
  let running = false;

  async function pump() {
    if (running) return;
    running = true;
    while (matchQueue.length && !closed) {
      const g = matchQueue.shift();
      done.add(g.id);
      try {
        send({ kind: "match", id: g.id, result: await matchGroup(g, labelNames) });
      } catch (e) {
        send({ kind: "match", id: g.id, result: { status: "error", error: String(e.message || e) } });
      }
    }
    running = false;
  }

  port.onMessage.addListener(async (m) => {
    if (m.cmd === "load") {
      // Plusieurs labels : chargés l'un après l'autre (débit MusicBrainz).
      for (const mbid of m.mbids || [m.mbid]) {
        if (closed) return;
        try {
          await loadCatalog(mbid, (x) => send({ ...x, mbid }), () => closed);
        } catch (e) {
          send({ kind: "error", mbid, error: String(e.message || e) });
        }
      }
    } else if (m.cmd === "match") {
      labelNames = m.labelNames || labelNames;
      // Les demandes prioritaires (filtres et tri affichés) passent devant,
      // même si elles étaient déjà en file.
      const fresh = m.groups.filter((g) => !done.has(g.id));
      const ids = new Set(fresh.map((g) => g.id));
      const rest = matchQueue.filter((g) => !ids.has(g.id));
      matchQueue = m.priority ? [...fresh, ...rest] : [...rest, ...fresh];
      pump();
    }
  });
});
