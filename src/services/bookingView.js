// Read-side helpers for presenting a stored booking. The invoice, the Excel
// export and notification templates all go through these, so every surface
// shows the same route, duration and amounts — and bookings created before
// itemised pricing / stops / rental durations existed still render cleanly.

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** "₹12,345" / "₹12,345.50" */
export const formatINR = (n) => {
  const v = Number(n || 0);
  const d = Number.isInteger(v) ? 0 : 2; // paise shown only when present
  return `₹${v.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
};

/**
 * The booking's price breakdown. Legacy bookings (no `pricing`) were priced as
 * one GST-unspecified amount, so they get a single line and no GST split.
 */
export function pricingOf(booking = {}) {
  if (booking.pricing && Array.isArray(booking.pricing.lines)) return booking.pricing;
  const fare = round2(booking.fare || 0);
  return {
    source: "legacy",
    lines: [{ key: "fare", label: "Trip fare", detail: "", amount: fare }],
    subtotal: fare,
    gstRate: null,
    gstAmount: null,
    total: fare,
  };
}

/** Stop labels in travel order (legacy bookings have none). */
export const stopLabels = (booking = {}) =>
  (Array.isArray(booking.stops) ? booking.stops : [])
    .map((s) => (typeof s === "string" ? s : s?.label))
    .filter(Boolean);

/** Every point of the trip in order: pickup, stops…, drop. */
export const bookingRoute = (booking = {}) =>
  [booking.pickup, ...stopLabels(booking), booking.drop].filter(Boolean);

/** "4 hours · 40 km package" for hourly rentals, else "". */
export function rentalLabel(booking = {}) {
  const r = booking.rental;
  if (!r || !r.hours) return "";
  return `${r.hours} hour${r.hours === 1 ? "" : "s"}${r.kms ? ` · ${r.kms} km package` : ""}`;
}

/**
 * Trip distance for display. Round trips show both legs, e.g.
 * "670 km × 2 (up & down) = 1,340 km"; everything else the route distance.
 */
export function distanceLabel(booking = {}) {
  const p = booking.pricing || {};
  const n = (v) => Number(v).toLocaleString("en-IN");
  if (p.roundTripKm && p.oneWayKm) return `${n(p.oneWayKm)} km × 2 (up & down) = ${n(p.roundTripKm)} km`;
  return booking.distanceKm ? `${n(booking.distanceKm)} km` : "";
}

/** Balance still to be paid to the driver on the advance plan. */
export const balanceDue = (booking = {}) => {
  const adv = Number(booking.advanceAmount) || 0;
  return adv ? round2((Number(booking.fare) || 0) - adv) : 0;
};

/** Booked fare plus any post-trip charges (= the final invoice total). */
export const finalTotal = (booking = {}) =>
  round2((Number(pricingOf(booking).total || booking.fare) || 0) + (Number(booking.tripClosure?.total) || 0));

export default { formatINR, pricingOf, stopLabels, bookingRoute, rentalLabel, distanceLabel, balanceDue, finalTotal };
