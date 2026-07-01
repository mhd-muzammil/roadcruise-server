import { readDb, writeDb } from "../../utils/db.js";

/**
 * Booking bridge — the ONLY place the payment module touches booking data. It
 * reuses the existing utils/db.js (readDb/writeDb) and the existing "Approved"
 * status value, so no booking contract or schema changes. Additive and idempotent.
 */

/** Look up a booking by id (or null). */
export function getBooking(bookingId) {
  const db = readDb();
  return db.bookings.find((b) => b.id === bookingId) || null;
}

/**
 * Confirm a booking after verified payment: set status -> "Approved" (the
 * existing confirmed state) only if not already. Idempotent.
 * @returns {{booking: object|null, changed: boolean}}
 */
export function confirmBooking(bookingId, patch = {}) {
  const db = readDb();
  const idx = db.bookings.findIndex((b) => b.id === bookingId);
  if (idx === -1) return { booking: null, changed: false };

  const prev = db.bookings[idx].status;
  const alreadyConfirmed = prev === "Approved";
  db.bookings[idx] = { ...db.bookings[idx], status: "Approved", ...patch };
  writeDb(db);
  return { booking: db.bookings[idx], changed: !alreadyConfirmed };
}

export default { getBooking, confirmBooking };
