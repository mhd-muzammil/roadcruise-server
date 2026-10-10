// Driving distance for pricing. The booking controller prices trips from a
// route it computes ITSELF (never a distance the browser sends), so a tampered
// request can't shrink the fare. Supports intermediate stops: OSRM takes any
// number of coordinates and returns one route through all of them in order.
//
// Same provider + fallback as GET /api/places/route: OSRM (free, keyless),
// and a road-factor haversine estimate when OSRM is unreachable, flagged
// `estimated: true`. Results are cached for 24h, so the quote a customer sees
// on the results page and the amount stored at booking time come from the
// same route.

const OSRM_URL = "https://router.project-osrm.org/route/v1/driving";
const FETCH_TIMEOUT_MS = 6000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 1000;

const cache = new Map(); // key -> { at, value }

const cacheGet = (key) => {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
};
const cacheSet = (key, value) => {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), value });
};

/** True for a { lat, lon } pair of finite, in-range numbers. */
export const isValidPoint = (p) =>
  !!p &&
  Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lon)) &&
  Math.abs(Number(p.lat)) <= 90 && Math.abs(Number(p.lon)) <= 180;

// Great-circle distance (km), scaled by 1.35 for road distance in the fallback.
function haversineKm(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

async function osrmRoute(points) {
  const coords = points.map((p) => `${p.lon},${p.lat}`).join(";");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${OSRM_URL}/${coords}?overview=false&alternatives=false&steps=false`, {
      signal: ctrl.signal,
      headers: { "User-Agent": "RoadCruise/1.0 (https://roadcruise.in)" },
    });
    if (!res.ok) throw new Error(`OSRM responded ${res.status}`);
    const data = await res.json();
    const route = data?.routes?.[0];
    if (data?.code !== "Ok" || !route) throw new Error(data?.code || "No route found");
    return {
      distanceKm: Math.max(1, Math.round(route.distance / 1000)),
      durationMin: Math.max(1, Math.round(route.duration / 60)),
      estimated: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

function estimateRoute(points) {
  let km = 0;
  for (let i = 1; i < points.length; i++) km += haversineKm(points[i - 1], points[i]);
  km = Math.max(1, Math.round(km * 1.35));
  return { distanceKm: km, durationMin: Math.max(5, Math.round((km / 45) * 60)), estimated: true };
}

// Tests swap the resolver so they never touch the network.
let resolver = osrmRoute;
export function setRouteResolver(fn) {
  resolver = fn || osrmRoute;
  cache.clear();
}

/**
 * Driving route through `points` in order (pickup, ...stops, drop).
 * Always resolves: falls back to an estimate when routing is unavailable.
 * @returns {Promise<{distanceKm:number, durationMin:number, estimated:boolean}>}
 */
export async function routeThrough(points) {
  const pts = points.map((p) => ({ lat: Number(p.lat), lon: Number(p.lon) }));
  const key = pts.map((p) => `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`).join("|");
  const cached = cacheGet(key);
  if (cached) return cached;
  try {
    const result = await resolver(pts);
    cacheSet(key, result);
    return result;
  } catch (e) {
    console.error("[routing] route failed, using haversine estimate:", e.message);
    return estimateRoute(pts);
  }
}

export default { routeThrough, isValidPoint, setRouteResolver };
