// Trip-planner requests -> validated trip + server-computed route + per-vehicle
// prices. Shared by POST /api/bookings/quote (results page) and
// POST /api/bookings (the booking itself), so what the customer is shown and
// what they are charged come from the same code and the same cached route.
import {
  TRIP_TYPES, STOP_TRIP_TYPES, MAX_STOPS, hourlyPackageByKey, tripDays, quoteVehicleTrip,
} from "./pricing.js";
import { routeThrough, isValidPoint } from "./routing.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const cleanLabel = (v) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, 300);

function cleanPlace(raw) {
  if (!raw || !isValidPoint(raw)) return null;
  const label = cleanLabel(raw.label);
  if (!label) return null;
  return { label, lat: Number(raw.lat), lon: Number(raw.lon) };
}

/**
 * Validate a trip-planner trip. Returns { trip } or { error }.
 * trip: { type, pickup, drop, stops[], date, time, returnDate, returnTime, pkg }
 */
export function normalizeTrip(raw = {}) {
  const type = raw.type;
  if (!TRIP_TYPES[type]) return { error: "Unknown trip type" };

  const pickup = cleanPlace(raw.pickup);
  if (!pickup) return { error: "A valid pickup location is required" };

  const trip = { type, pickup, drop: null, stops: [], date: "", time: "", returnDate: "", returnTime: "", pkg: "" };

  if (type !== "hourly") {
    trip.drop = cleanPlace(raw.drop);
    if (!trip.drop) return { error: "A valid drop location is required" };
  }

  const rawStops = Array.isArray(raw.stops) ? raw.stops : [];
  if (rawStops.length && !STOP_TRIP_TYPES.includes(type)) {
    return { error: "Additional stops are available on outstation trips only" };
  }
  if (rawStops.length > MAX_STOPS) return { error: `Up to ${MAX_STOPS} additional stops can be added` };
  for (const s of rawStops) {
    const stop = cleanPlace(s);
    if (!stop) return { error: "Each additional stop must be selected from the suggestions" };
    trip.stops.push(stop);
  }

  trip.date = String(raw.date || "");
  if (!DATE_RE.test(trip.date)) return { error: "A valid trip date is required" };
  trip.time = String(raw.time || "");
  if (!TIME_RE.test(trip.time)) return { error: "A valid pickup time is required" };

  if (type === "roundtrip") {
    trip.returnDate = String(raw.returnDate || "");
    if (!DATE_RE.test(trip.returnDate)) return { error: "A valid return date is required" };
    if (trip.returnDate < trip.date) return { error: "The return date cannot be before the departure date" };
    const rt = String(raw.returnTime || "");
    trip.returnTime = TIME_RE.test(rt) ? rt : "";
  }

  if (type === "hourly") {
    if (!hourlyPackageByKey(raw.pkg)) return { error: "Choose a valid hourly package" };
    trip.pkg = raw.pkg;
  }
  return { trip };
}

/** Days the trip spans (round trips only; everything else is 1). */
export const daysForTrip = (trip) => (trip.type === "roundtrip" ? tripDays(trip.date, trip.returnDate) : 1);

/** Server-side route through pickup -> stops -> drop (null for hourly). */
export async function routeForTrip(trip) {
  if (trip.type === "hourly") return null;
  return routeThrough([trip.pickup, ...trip.stops, trip.drop]);
}

/** Quote one vehicle for an already-routed trip (null if it can't serve it). */
export function quoteTripVehicle(vehicle, trip, route) {
  const q = quoteVehicleTrip(vehicle, {
    type: trip.type,
    distanceKm: route?.distanceKm,
    days: daysForTrip(trip),
    pkg: trip.pkg,
  });
  if (!q) return null;
  if (route) q.pricing = { ...q.pricing, distanceKm: route.distanceKm };
  return q;
}

export default { normalizeTrip, daysForTrip, routeForTrip, quoteTripVehicle };
