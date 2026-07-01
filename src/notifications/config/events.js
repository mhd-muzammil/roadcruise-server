/**
 * Canonical domain-event catalog for the ERP notification engine.
 *
 * These are STABLE string constants. Any module in the ERP (booking, payment,
 * invoice, refund, auth, ...) emits one of these via the notification EventBus.
 * Never type the raw string at a call-site — import the constant.
 *
 * Adding a new event = add a constant here + a workflow in workflows/registry.js
 * + templates in templates/. No engine code changes required.
 */
export const NotificationEvents = Object.freeze({
  // Booking lifecycle
  BOOKING_CREATED: "booking.created",
  BOOKING_CONFIRMED: "booking.confirmed",
  BOOKING_CANCELLED: "booking.cancelled",
  BOOKING_RESCHEDULED: "booking.rescheduled",

  // Payment lifecycle
  PAYMENT_SUCCESSFUL: "payment.successful",
  PAYMENT_FAILED: "payment.failed",
  PAYMENT_PENDING: "payment.pending",
  REFUND_INITIATED: "refund.initiated",
  REFUND_COMPLETED: "refund.completed",

  // Trip lifecycle
  TRIP_SCHEDULED: "trip.scheduled",
  TRIP_REMINDER: "trip.reminder",
  TRIP_STARTED: "trip.started",
  TRIP_COMPLETED: "trip.completed",
  DRIVER_ASSIGNED: "driver.assigned",
  DRIVER_CHANGED: "driver.changed",

  // Documents
  INVOICE_GENERATED: "invoice.generated",

  // Identity / support
  CUSTOMER_REGISTERED: "customer.registered",
  OTP_REQUESTED: "auth.otp_requested",
  PASSWORD_RESET: "auth.password_reset",
  EMAIL_VERIFICATION: "auth.email_verification",
});

/** Delivery channels supported by the engine. */
export const Channels = Object.freeze({
  EMAIL: "email",
  SMS: "sms",
  WHATSAPP: "whatsapp",
});

/** Lifecycle states for a single notification record (per channel, per recipient). */
export const DeliveryStatus = Object.freeze({
  QUEUED: "queued",
  PROCESSING: "processing",
  SENT: "sent",
  DELIVERED: "delivered",
  READ: "read",
  FAILED: "failed",
  DEAD_LETTER: "dead_letter",
  SKIPPED: "skipped", // no recipient / channel disabled / duplicate
});

export const ALL_EVENTS = Object.values(NotificationEvents);
export const ALL_CHANNELS = Object.values(Channels);
