import { getBookingById, patchBooking } from "../../utils/db.js";

/**
 * Booking bridge — the ONLY place the payment module touches booking data. It
 * reuses utils/db.js and the existing "Approved" status value, so no booking
 * contract or schema changes. Uses the atomic patchBooking helper so a payment
 * confirmation updates a single row transactionally (no whole-file rewrite).
 * Additive and idempotent.
 */

/** Look up a booking by id (or null). */
export function getBooking(bookingId) {
  return getBookingById(bookingId);
}

/**
 * Confirm a booking after verified payment: set status -> "Approved" (the
 * existing confirmed state) only if not already. Idempotent.
 * @returns {{booking: object|null, changed: boolean}}
 */
export function confirmBooking(bookingId, patch = {}) {
  const existing = getBookingById(bookingId);
  if (!existing) return { booking: null, changed: false };

  const alreadyConfirmed = existing.status === "Approved";
  const { booking } = patchBooking(bookingId, { status: "Approved", ...patch });
  return { booking, changed: !alreadyConfirmed };
}

export default { getBooking, confirmBooking };
