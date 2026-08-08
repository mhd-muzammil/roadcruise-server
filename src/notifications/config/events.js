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

  // Website "Contact Us" enquiry. ENQUIRY -> the business inbox (staff act on
  // it); ACK -> an acknowledgement back to the person who wrote in.
  CONTACT_ENQUIRY: "contact.enquiry",
  CONTACT_ACK: "contact.acknowledgement",

  // Internal ADMIN alerts — sent to the business's own WhatsApp (not the
  // customer) so staff can act on each booking. PAID = money already collected
  // online; UNPAID = customer must be contacted to collect payment manually.
  ADMIN_BOOKING_PAID: "admin.booking_paid",
  ADMIN_BOOKING_UNPAID: "admin.booking_unpaid",
  // A booking was cancelled (by the customer from "My Bookings", or by an admin).
  // Alerts the business inbox so staff can free the vehicle / handle any refund.
  ADMIN_BOOKING_CANCELLED: "admin.booking_cancelled",
  // A customer edited their booking from "My Bookings" (dates/pickup/drop/etc.).
  // Alerts the business inbox so staff can re-check the schedule and driver.
  ADMIN_BOOKING_MODIFIED: "admin.booking_modified",
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
  // Accepted by the gateway's API but NOT yet known to have been handed to the
  // operator. Distinct from SENT because MSG91's v5 Flow API answers HTTP 200
  // {"type":"success"} and can still reject the message asynchronously
  // (e.g. API-failed code 400) — visible only in its panel/alert emails. A
  // provider opts into this by returning status:"submitted"; every other
  // adapter keeps returning "sent" and is unaffected.
  SUBMITTED: "submitted",
  DELIVERED: "delivered",
  READ: "read",
  FAILED: "failed",
  DEAD_LETTER: "dead_letter",
  SKIPPED: "skipped", // no recipient / channel disabled / duplicate
});

export const ALL_EVENTS = Object.values(NotificationEvents);
export const ALL_CHANNELS = Object.values(Channels);
