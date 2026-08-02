// Geo proxy for the trip-planner widget. The browser never talks to a geo
// provider directly — it calls our API, which proxies two free, keyless
// OpenStreetMap-backed services:
//
//   GET /api/places/search?q=…            -> Photon (komoot) autocomplete,
//                                            biased to South India, IN-only
//   GET /api/places/route?fromLat=…&…     -> OSRM driving distance + duration,
//                                            with a haversine fallback so a
//                                            quote is ALWAYS produced
//
// Proxying (instead of calling from the SPA) keeps a single origin for the
// client, lets us cache aggressively (both upstreams ask for fair use), and
// makes a future swap to Google Places/Distance Matrix a server-only change.

// Search bias centre: Chennai — the fleet's home base. Results are still
// nationwide (IN); the bias only ranks nearby places first.
const BIAS = { lat: 13.0827, lon: 80.2707 };
const PHOTON_URL = "https://photon.komoot.io/api/";
const OSRM_URL = "https://router.project-osrm.org/route/v1/driving";
const FETCH_TIMEOUT_MS = 6000;

// --- Tiny TTL cache (insertion-ordered Map => cheap oldest-first eviction) ---
function makeCache(ttlMs, maxEntries) {
  const map = new Map(); // key -> { at, value }
  return {
    get(key) {
      const hit = map.get(key);
      if (!hit) return undefined;
      if (Date.now() - hit.at > ttlMs) {
        map.delete(key);
        return undefined;
      }
      return hit.value;
    },
    set(key, value) {
      if (map.size >= maxEntries) map.delete(map.keys().next().value);
      map.set(key, { at: Date.now(), value });
    },
  };
}
const searchCache = makeCache(60 * 60 * 1000, 500); // 1h — place names barely change
const routeCache = makeCache(24 * 60 * 60 * 1000, 500); // 24h — road distances are stable

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "RoadCruise/1.0 (https://roadcruise.in)" },
    });
    if (!res.ok) throw new Error(`Upstream responded ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Photon feature -> the flat suggestion shape the autocomplete renders. */
function toSuggestion(feature) {
  const p = feature?.properties || {};
  const [lon, lat] = feature?.geometry?.coordinates || [];
  if (!p.name || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (p.countrycode && p.countrycode !== "IN") return null;
  // Human label: name + locality chain, deduped (Photon often repeats the name
  // as the city/district for towns).
  const parts = [];
  for (const part of [p.name, p.street, p.district, p.city, p.state, p.postcode]) {
    if (part && !parts.includes(String(part))) parts.push(String(part));
  }
  return {
    id: `${p.osm_type || "N"}${p.osm_id || ""}:${lat.toFixed(4)},${lon.toFixed(4)}`,
    name: p.name,
    label: parts.join(", "),
    lat,
    lon,
  };
}

/** GET /api/places/search?q=vandalur */
export const searchPlaces = async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (q.length < 2) return res.json([]);

  const key = q.toLowerCase();
  const cached = searchCache.get(key);
  if (cached) return res.json(cached);

  try {
    const url = `${PHOTON_URL}?q=${encodeURIComponent(q)}&limit=8&lang=en&lat=${BIAS.lat}&lon=${BIAS.lon}`;
    const data = await fetchJson(url);
    const seen = new Set();
    const results = [];
    for (const f of data?.features || []) {
      const s = toSuggestion(f);
      if (!s || seen.has(s.label)) continue;
      seen.add(s.label);
      results.push(s);
      if (results.length >= 6) break;
    }
    searchCache.set(key, results);
    res.json(results);
  } catch (e) {
    console.error("[places] search failed:", e.message);
    res.status(502).json({ error: "Place search is temporarily unavailable" });
  }
};

// Great-circle distance (km) — the fallback when OSRM is unreachable. Scaled
// by 1.35 to approximate road distance from the straight line.
function haversineKm(lat1, lon1, lat2, lon2) {
  const rad = (d) => (d * Math.PI) / 180;
  const a =
    Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** GET /api/places/route?fromLat=&fromLon=&toLat=&toLon= */
export const getRoute = async (req, res) => {
  const fromLat = num(req.query.fromLat);
  const fromLon = num(req.query.fromLon);
  const toLat = num(req.query.toLat);
  const toLon = num(req.query.toLon);
  const valid =
    fromLat !== null && fromLon !== null && toLat !== null && toLon !== null &&
    Math.abs(fromLat) <= 90 && Math.abs(toLat) <= 90 &&
    Math.abs(fromLon) <= 180 && Math.abs(toLon) <= 180;
  if (!valid) return res.status(400).json({ error: "Valid from/to coordinates are required" });

  const key = `${fromLat.toFixed(4)},${fromLon.toFixed(4)}|${toLat.toFixed(4)},${toLon.toFixed(4)}`;
  const cached = routeCache.get(key);
  if (cached) return res.json(cached);

  try {
    const url = `${OSRM_URL}/${fromLon},${fromLat};${toLon},${toLat}?overview=false&alternatives=false&steps=false`;
    const data = await fetchJson(url);
    const route = data?.routes?.[0];
    if (data?.code !== "Ok" || !route) throw new Error(data?.code || "No route found");
    const result = {
      distanceKm: Math.max(1, Math.round(route.distance / 1000)),
      durationMin: Math.max(1, Math.round(route.duration / 60)),
      estimated: false,
    };
    routeCache.set(key, result);
    res.json(result);
  } catch (e) {
    // Never dead-end the booking flow on a routing outage — answer with a
    // road-factor haversine estimate instead (flagged so the UI can say "approx").
    console.error("[places] route failed, using haversine fallback:", e.message);
    const km = Math.max(1, Math.round(haversineKm(fromLat, fromLon, toLat, toLon) * 1.35));
    const result = { distanceKm: km, durationMin: Math.max(5, Math.round((km / 45) * 60)), estimated: true };
    res.json(result);
  }
};
