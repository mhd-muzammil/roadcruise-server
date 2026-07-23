// Vehicle availability (manual-free model), shared by the vehicle + booking
// controllers so neither has to import the other.
//
// Each vehicle has `totalUnits` (default 1). A booking HOLDS one unit of a
// vehicle when it references that vehicleId, is not Cancelled, and has not been
// released (`vehicleReleased`). A unit is freed ONLY when an admin releases the
// booking's hold. So a vehicle reads "already booked" once every unit is held,
// until an admin frees one.
import { listVehicles, getVehicle } from "../db/vehicles.db.js";
import { listBookings } from "../utils/db.js";

const unitsOf = (vehicle) => Math.max(1, parseInt(vehicle?.totalUnits, 10) || 1);

/** vehicleId -> number of currently-held units, across all bookings. */
export function heldCounts() {
  const map = {};
  for (const b of listBookings()) {
    if (!b.vehicleId || b.status === "Cancelled" || b.vehicleReleased) continue;
    map[b.vehicleId] = (map[b.vehicleId] || 0) + 1;
  }
  return map;
}

/** Bookings currently holding a given vehicleId (for the admin "Free" UI). */
export function heldBookingsFor(vehicleId) {
  return listBookings()
    .filter((b) => b.vehicleId === vehicleId && b.status !== "Cancelled" && !b.vehicleReleased)
    .map((b) => ({
      id: b.id,
      name: b.name,
      phone: b.phone,
      fromDate: b.fromDate,
      toDate: b.toDate,
      status: b.status,
    }));
}

/** Attach { totalUnits, heldCount, available } to a vehicle object. */
export function withAvailability(vehicle, held = heldCounts()) {
  const totalUnits = unitsOf(vehicle);
  const heldCount = held[vehicle.id] || 0;
  return { ...vehicle, totalUnits, heldCount, available: heldCount < totalUnits };
}

/**
 * Is a concrete vehicle bookable right now? Unknown/absent ids never block
 * (custom or "no preference" bookings), only real fleet vehicles are enforced.
 */
export function isVehicleAvailable(vehicleId) {
  if (!vehicleId) return true;
  const vehicle = getVehicle(vehicleId);
  if (!vehicle) return true;
  return (heldCounts()[vehicleId] || 0) < unitsOf(vehicle);
}

/** All vehicles with availability attached (optionally including inactive). */
export function listVehiclesWithAvailability({ includeInactive = false } = {}) {
  const held = heldCounts();
  return listVehicles({ includeInactive }).map((v) => withAvailability(v, held));
}

export default {
  heldCounts, heldBookingsFor, withAvailability, isVehicleAvailable, listVehiclesWithAvailability,
};
