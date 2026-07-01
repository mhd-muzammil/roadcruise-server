import { notify } from "../index.js";
import { NotificationEvents } from "../config/events.js";

/**
 * Integration hooks — the ONLY thing existing controllers import. Each helper
 * maps a domain object to an event payload and emits it. This keeps the touch
 * inside existing controllers to a single, side-effect-free line and centralizes
 * the field mapping here (so business code never learns notification concerns).
 *
 * All helpers are fire-and-forget and fully isolated: a failure here can never
 * affect the booking/auth response (see EventBus.emitEvent).
 */

const invoiceFor = (booking) =>
  `RC-INV-${String(booking.id || "").replace(/^RC-BK-/, "") || Date.now()}`;

/** Booking created (request received). */
export function notifyBookingCreated(booking, meta = {}) {
  return notify(NotificationEvents.BOOKING_CREATED, { ...booking }, meta);
}

/** Booking confirmed (approved). */
export function notifyBookingConfirmed(booking, meta = {}) {
  return notify(
    NotificationEvents.BOOKING_CONFIRMED,
    { ...booking, paymentAmount: booking.fare, invoiceNumber: invoiceFor(booking) },
    meta
  );
}

/** Payment successful — drives invoice/receipt notifications. */
export function notifyPaymentSuccessful(booking, meta = {}) {
  return notify(
    NotificationEvents.PAYMENT_SUCCESSFUL,
    {
      ...booking,
      paymentAmount: booking.fare,
      paymentStatus: "Paid",
      invoiceNumber: invoiceFor(booking),
    },
    meta
  );
}

/** Driver assigned/changed. */
export function notifyDriverAssigned(booking, meta = {}) {
  return notify(NotificationEvents.DRIVER_ASSIGNED, { ...booking }, meta);
}

/** Booking cancelled. */
export function notifyBookingCancelled(booking, meta = {}) {
  return notify(NotificationEvents.BOOKING_CANCELLED, { ...booking }, meta);
}

/** New customer registered. */
export function notifyCustomerRegistered(user, meta = {}) {
  return notify(NotificationEvents.CUSTOMER_REGISTERED, { ...user }, meta);
}

export default {
  notifyBookingCreated,
  notifyBookingConfirmed,
  notifyPaymentSuccessful,
  notifyDriverAssigned,
  notifyBookingCancelled,
  notifyCustomerRegistered,
};
