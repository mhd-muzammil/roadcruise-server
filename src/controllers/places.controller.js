// Geo proxy for the trip-planner widget. The browser never talks to a geo
// provider directly — it calls our API, which proxies two free, keyless
// OpenStreetMap-backed services:
//
//   GET /api/places/search?q=…            -> Photon (komoot) + Nominatim
//                                            autocomplete, merged + deduped,
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
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
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

// --- Place kinds -------------------------------------------------------------
// OSM names are usually the BARE place name: Vandalur's railway station is
// named just "Vandalur", identical to the town wrapped around it. So we surface
// each result's kind ("Railway Station"), which lets a customer tell those two
// apart, keeps them from deduping into one, and — with the category search
// below — makes them findable by the words people actually type.

const KIND_LABELS = {
  station: "Railway Station",
  halt: "Railway Halt",
  subway_entrance: "Metro Entrance",
  bus_station: "Bus Station",
  bus_stop: "Bus Stop",
  aerodrome: "Airport",
  terminal: "Airport Terminal",
  ferry_terminal: "Ferry Terminal",
  taxi: "Taxi Stand",
  hospital: "Hospital",
  clinic: "Clinic",
  place_of_worship: "Temple / Church / Mosque",
  hotel: "Hotel",
  guest_house: "Guest House",
  resort: "Resort",
  mall: "Mall",
  supermarket: "Supermarket",
  marketplace: "Market",
  school: "School",
  college: "College",
  university: "University",
  stadium: "Stadium",
  zoo: "Zoo",
  park: "Park",
  beach: "Beach",
  museum: "Museum",
  attraction: "Attraction",
  restaurant: "Restaurant",
  motorway_junction: "Junction",
  // Road classes read as jargon otherwise ("Residential", "Tertiary").
  residential: "Road",
  primary: "Road",
  secondary: "Road",
  tertiary: "Road",
  unclassified: "Road",
  service: "Road",
  living_street: "Road",
  trunk: "Highway",
  motorway: "Highway",
  track: "Path",
  path: "Path",
  footway: "Path",
};

// Kinds that add nothing to a label: administrative places (the name already
// reads as a place) and road segments (the name usually ends in "Road").
const PLAIN_KINDS = new Set([
  "city", "town", "village", "hamlet", "suburb", "neighbourhood", "locality",
  "quarter", "state", "district", "county", "region", "municipality", "borough",
  "island", "administrative", "yes",
  "residential", "primary", "secondary", "tertiary", "trunk", "motorway",
  "unclassified", "service", "living_street", "track", "path", "footway", "road",
]);

const titleCase = (s) =>
  String(s).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

// OSM tag values that carry no meaning for a customer — `building=yes` must not
// render as a "Yes" badge in the dropdown.
const NOISE_KINDS = new Set(["yes", "no", "unknown", "point", "node"]);

/** Human-readable kind for an OSM value ("station" -> "Railway Station"). */
function kindOf(osmValue) {
  if (!osmValue || NOISE_KINDS.has(osmValue)) return "";
  return KIND_LABELS[osmValue] || titleCase(osmValue);
}

/**
 * Display label: "Name (Kind), locality chain". The kind is woven in only for
 * distinguishing places (a station/airport/hospital), never for towns or roads
 * — the booking stores this label, so a driver must be able to read which
 * "Vandalur" the customer meant.
 */
function buildLabel(name, osmValue, localityParts) {
  const kind = kindOf(osmValue);
  const head = kind && !PLAIN_KINDS.has(osmValue) ? `${name} (${kind})` : name;
  const parts = [head];
  for (const part of localityParts) {
    if (part && !parts.includes(String(part)) && String(part) !== name) parts.push(String(part));
  }
  return parts.join(", ");
}

/** Photon feature -> the flat suggestion shape the autocomplete renders. */
function toSuggestion(feature) {
  const p = feature?.properties || {};
  const [lon, lat] = feature?.geometry?.coordinates || [];
  if (!p.name || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (p.countrycode && p.countrycode !== "IN") return null;
  return {
    id: `${p.osm_type || "N"}${p.osm_id || ""}:${lat.toFixed(4)},${lon.toFixed(4)}`,
    name: p.name,
    kind: kindOf(p.osm_value),
    label: buildLabel(p.name, p.osm_value, [p.street, p.district, p.city, p.state, p.postcode]),
    lat,
    lon,
  };
}

/** Nominatim (jsonv2 + addressdetails) result -> the same flat suggestion shape. */
function nominatimToSuggestion(item) {
  const lat = Number(item?.lat);
  const lon = Number(item?.lon);
  const a = item?.address || {};
  const name = item?.name || String(item?.display_name || "").split(",")[0].trim();
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    id: `nom${item.place_id || ""}:${lat.toFixed(4)},${lon.toFixed(4)}`,
    name,
    kind: kindOf(item.type),
    label: buildLabel(name, item.type, [
      a.road,
      a.neighbourhood || a.suburb,
      a.village || a.town || a.city_district || a.city,
      a.state_district || a.county,
      a.state,
      a.postcode,
    ]),
    lat,
    lon,
  };
}

// Dedup keys: same label, or same name+kind within ~1 km. The KIND matters —
// a town and the railway station inside it share a name and coordinates, and
// collapsing them would delete exactly the result the customer wanted.
const normText = (s) => String(s).toLowerCase().replace(/\s+/g, " ").trim();
const dedupKeys = (s) => [
  `${normText(s.label)}`,
  `${normText(s.name)}|${s.kind}@${s.lat.toFixed(2)},${s.lon.toFixed(2)}`,
];

// --- Category-aware search ---------------------------------------------------
// People type "vandalur railway station", but OSM calls it "Vandalur". Photon
// can filter by OSM tag, so when the query carries a category word we ALSO run
// a tagged search on the remaining words and rank those hits first. Longest
// phrases are matched first so "bus station" never resolves as bare "station".

const CATEGORY_TAGS = [
  { phrases: ["railway station", "train station", "rly station", "metro station", "railway"], tag: "railway:station" },
  { phrases: ["bus terminus", "bus terminal", "bus station", "bus stand", "bus depot"], tag: "amenity:bus_station" },
  { phrases: ["bus stop"], tag: "highway:bus_stop" },
  { phrases: ["airport"], tag: "aeroway:aerodrome" },
  { phrases: ["hospital"], tag: "amenity:hospital" },
  { phrases: ["temple", "church", "mosque"], tag: "amenity:place_of_worship" },
  { phrases: ["hotel"], tag: "tourism:hotel" },
  { phrases: ["mall"], tag: "shop:mall" },
  { phrases: ["university"], tag: "amenity:university" },
  { phrases: ["college"], tag: "amenity:college" },
  { phrases: ["school"], tag: "amenity:school" },
  { phrases: ["station"], tag: "railway:station" }, // bare "station" — last resort
];

const CATEGORY_PHRASES = CATEGORY_TAGS.flatMap(({ phrases, tag }) =>
  phrases.map((phrase) => ({ phrase, tag }))
).sort((a, b) => b.phrase.length - a.phrase.length);

/** Detect a typed category -> { tag, base } with the category words stripped. */
export function detectCategory(q) {
  const lower = String(q).toLowerCase();
  for (const { phrase, tag } of CATEGORY_PHRASES) {
    const re = new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    if (!re.test(lower)) continue;
    // The LONGEST matching phrase decides — never fall through to a shorter,
    // overlapping one ("railway station" must not degrade into searching for
    // the leftover word "station"). No place name left => nothing to look up.
    const base = lower.replace(re, " ").replace(/\s+/g, " ").trim();
    return base.length >= 2 ? { tag, base } : null;
  }
  return null;
}

/**
 * Blend the two providers 2:1 (Photon, Photon, Nominatim, …). Photon ranks
 * autocomplete better, but a strict concat let it fill every slot and Nominatim
 * never surfaced — this guarantees the second source is actually represented.
 */
function blend(photonList, nominatimList) {
  const out = [];
  let p = 0;
  let n = 0;
  while (p < photonList.length || n < nominatimList.length) {
    for (let i = 0; i < 2 && p < photonList.length; i++) out.push(photonList[p++]);
    if (n < nominatimList.length) out.push(nominatimList[n++]);
  }
  return out;
}

/**
 * GET /api/places/search?q=vandalur
 * Queries Photon AND Nominatim in parallel and merges the results — each source
 * alone misses plenty of localities (Photon's autocomplete index is much
 * sparser for small towns/streets; Nominatim has no typo tolerance), so the
 * union gives far better coverage. A typed category ("… railway station") adds
 * a third, tag-filtered lookup so places OSM names bare are still findable.
 * Any source failing never empties the list; only ALL failing is an error.
 */
export const searchPlaces = async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (q.length < 2) return res.json([]);

  const key = q.toLowerCase();
  const cached = searchCache.get(key);
  if (cached) return res.json(cached);

  const photonQuery = (text, tag) =>
    `${PHOTON_URL}?q=${encodeURIComponent(text)}&limit=15&lang=en&lat=${BIAS.lat}&lon=${BIAS.lon}` +
    (tag ? `&osm_tag=${encodeURIComponent(tag)}` : "");
  const photonUrl = photonQuery(q);
  const nominatimUrl =
    `${NOMINATIM_URL}?q=${encodeURIComponent(q)}&format=jsonv2&addressdetails=1&countrycodes=in&limit=10&accept-language=en`;

  // "vandalur railway station" -> also ask Photon for railway:station places
  // named "vandalur", because that station's OSM name is just "Vandalur".
  const category = detectCategory(q);
  const attempts = [fetchJson(photonUrl), fetchJson(nominatimUrl)];
  if (category) attempts.push(fetchJson(photonQuery(category.base, category.tag)));

  const [photon, nominatim, tagged] = await Promise.allSettled(attempts);

  const photonList = [];
  const nominatimList = [];
  const categoryList = [];
  if (photon.status === "fulfilled") {
    for (const f of photon.value?.features || []) photonList.push(toSuggestion(f));
  } else {
    console.error("[places] photon search failed:", photon.reason?.message);
  }
  if (nominatim.status === "fulfilled") {
    const items = Array.isArray(nominatim.value) ? nominatim.value : [];
    for (const item of items) nominatimList.push(nominatimToSuggestion(item));
  } else {
    console.error("[places] nominatim search failed:", nominatim.reason?.message);
  }
  if (tagged?.status === "fulfilled") {
    for (const f of tagged.value?.features || []) categoryList.push(toSuggestion(f));
  } else if (tagged?.status === "rejected") {
    console.error("[places] category search failed:", tagged.reason?.message);
  }

  const settled = [photon, nominatim, ...(tagged ? [tagged] : [])];
  if (settled.every((r) => r.status === "rejected")) {
    return res.status(502).json({ error: "Place search is temporarily unavailable" });
  }

  // Category hits first (that IS what was typed), then the two general sources
  // blended so neither monopolizes the list.
  const candidates = [...categoryList, ...blend(photonList, nominatimList)];

  const seen = new Set();
  const results = [];
  for (const s of candidates) {
    if (!s) continue;
    const keys = dedupKeys(s);
    if (keys.some((k) => seen.has(k))) continue;
    keys.forEach((k) => seen.add(k));
    results.push(s);
    if (results.length >= 8) break;
  }
  // Cache only fully-merged answers — a partial (one source down) result set
  // must not be pinned for an hour; the next request retries the failed source.
  if (settled.every((r) => r.status === "fulfilled")) {
    searchCache.set(key, results);
  }
  res.json(results);
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
