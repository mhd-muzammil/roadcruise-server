import { NotificationEvents, Channels } from "../config/events.js";
import config from "../config/notification.config.js";

const ALL = [Channels.EMAIL, Channels.SMS, Channels.WHATSAPP];

/**
 * Default recipient resolver. Pulls channel addresses + identity from a domain
 * payload. Works for booking/customer/payment shapes used across the ERP.
 * A channel with no resolvable recipient is SKIPPED (not failed) by the engine.
 */
export function defaultRecipients(payload = {}) {
  const phone = payload.phone || payload.customerPhone || null;
  return {
    customerId: payload.customerId ?? payload.userId ?? payload.email ?? null,
    name: payload.name || payload.customerName || "Customer",
    // Keys MUST match channel names — the engine looks up recipients[channel].
    email: payload.email || payload.customerEmail || null,
    sms: phone,
    // WhatsApp uses the phone number unless a dedicated wa id is provided.
    whatsapp: payload.whatsapp || phone,
  };
}

/**
 * Admin recipient resolver. Ignores the customer's contact details and routes
 * the message to the business's own inbox + WhatsApp (config.admin.email /
 * config.admin.whatsapp). Used only by the internal ADMIN_* alert events. SMS is
 * intentionally off for admin alerts. If an admin address is not configured, its
 * channel recipient is null and the engine SKIPS that channel (no crash).
 */
export function adminRecipients() {
  return {
    customerId: "admin",
    name: config.admin?.name || "Admin",
    email: config.admin?.email || null,
    sms: null,
    whatsapp: config.admin?.whatsapp || null,
  };
}

/**
 * Default template context builder. Maps a domain payload onto the canonical
 * placeholder names ({{customerName}}, {{bookingId}}, ...). Branding is merged
 * in by the engine, but included here for completeness.
 */
export function defaultContext(payload = {}) {
  return {
    ...config.branding,
    customerName: payload.name || payload.customerName || "Customer",
    customerPhone: payload.phone || payload.customerPhone || "—",
    bookingId: payload.bookingId || payload.id || "—",
    tripDate:
      payload.tripDate ||
      (payload.fromDate && payload.toDate
        ? `${payload.fromDate} → ${payload.toDate}`
        : payload.fromDate || "—"),
    tripType: payload.tripType || "—",
    pickup: payload.pickup || payload.from || "—",
    drop: payload.drop || payload.to || "—",
    vehicle: payload.vehicle || payload.item || "—",
    driver: payload.driver && payload.driver !== "None" ? payload.driver : "To be assigned",
    paymentAmount: payload.paymentAmount ?? payload.fare ?? "—",
    paymentStatus: payload.paymentStatus || payload.status || "—",
    invoiceNumber: payload.invoiceNumber || "—",
    // ---- additive: context-specific booking details (vehicle / package forms).
    // Empty-string defaults so templates can conditionally SHOW a row only when
    // the value is actually present (see `has()` in templates/email/index.js).
    packageName: payload.packageName || payload.package || "",
    passengers: payload.passengers || "",
    pickupTime: payload.pickupTime || "",
    specialRequests: payload.notes || payload.specialRequests || "",
    // ---- additive: auth flows (password reset / email verification / OTP) ----
    resetLink: payload.resetLink || "",
    verificationLink: payload.verificationLink || "",
    otp: payload.otp || "",
  };
}

/**
 * Context builder for the website "Contact Us" enquiry events. Maps the enquiry
 * payload ({ name, email, phone, subject, message }) onto template placeholders.
 * Used by both CONTACT_ENQUIRY (to admin) and CONTACT_ACK (to the enquirer).
 */
export function contactContext(payload = {}) {
  return {
    ...config.branding,
    customerName: payload.name || "Customer",
    enquiryName: payload.name || "—",
    enquiryEmail: payload.email || "—",
    enquiryPhone: payload.phone || "—",
    subject: payload.subject || "General Enquiry",
    message: payload.message || "—",
  };
}

const base = (channels = ALL, overrides = {}) => ({
  channels,
  resolveRecipients: defaultRecipients,
  buildContext: defaultContext,
  ...overrides,
});

/**
 * Event -> workflow. Booking + payment key flows go to all 3 channels.
 * Identity/OTP flows are scoped appropriately. Any event NOT listed here uses
 * `__default` (all channels, generic template) — the registered extension point
 * for the remaining lifecycle events.
 */
export const workflows = {
  [NotificationEvents.BOOKING_CREATED]: base(),
  // Confirmation-after-payment message -> customer Email + SMS + WhatsApp, so the
  // customer always gets the full trip-details confirmation by email even when
  // SMS/WhatsApp providers are in mock mode.
  [NotificationEvents.BOOKING_CONFIRMED]: base([Channels.EMAIL, Channels.SMS, Channels.WHATSAPP]),
  [NotificationEvents.BOOKING_CANCELLED]: base(),
  [NotificationEvents.BOOKING_RESCHEDULED]: base(),

  [NotificationEvents.PAYMENT_SUCCESSFUL]: base(),
  [NotificationEvents.PAYMENT_FAILED]: base(),
  [NotificationEvents.PAYMENT_PENDING]: base([Channels.EMAIL, Channels.SMS]),
  [NotificationEvents.REFUND_INITIATED]: base(),
  [NotificationEvents.REFUND_COMPLETED]: base(),

  [NotificationEvents.TRIP_SCHEDULED]: base(),
  [NotificationEvents.TRIP_REMINDER]: base([Channels.SMS, Channels.WHATSAPP]),
  [NotificationEvents.TRIP_STARTED]: base([Channels.SMS, Channels.WHATSAPP]),
  [NotificationEvents.TRIP_COMPLETED]: base(),
  [NotificationEvents.DRIVER_ASSIGNED]: base(),
  [NotificationEvents.DRIVER_CHANGED]: base(),

  // The paid-booking invoice -> customer Email + WhatsApp.
  [NotificationEvents.INVOICE_GENERATED]: base([Channels.EMAIL, Channels.WHATSAPP]),

  [NotificationEvents.CUSTOMER_REGISTERED]: base([Channels.EMAIL, Channels.WHATSAPP]),
  [NotificationEvents.OTP_REQUESTED]: base([Channels.SMS, Channels.EMAIL]),
  [NotificationEvents.PASSWORD_RESET]: base([Channels.EMAIL]),
  [NotificationEvents.EMAIL_VERIFICATION]: base([Channels.EMAIL]),

  // Internal admin alerts -> the business's own inbox (Email) + WhatsApp.
  [NotificationEvents.ADMIN_BOOKING_PAID]: base([Channels.EMAIL, Channels.WHATSAPP], { resolveRecipients: adminRecipients }),
  [NotificationEvents.ADMIN_BOOKING_UNPAID]: base([Channels.EMAIL, Channels.WHATSAPP], { resolveRecipients: adminRecipients }),
  [NotificationEvents.ADMIN_BOOKING_CANCELLED]: base([Channels.EMAIL, Channels.WHATSAPP], { resolveRecipients: adminRecipients }),
  [NotificationEvents.ADMIN_BOOKING_MODIFIED]: base([Channels.EMAIL, Channels.WHATSAPP], { resolveRecipients: adminRecipients }),

  // Contact-form enquiry -> business inbox (Email). Acknowledgement -> the
  // person who wrote in (Email). Both use the contact context builder.
  [NotificationEvents.CONTACT_ENQUIRY]: base([Channels.EMAIL], { resolveRecipients: adminRecipients, buildContext: contactContext }),
  [NotificationEvents.CONTACT_ACK]: base([Channels.EMAIL], { buildContext: contactContext }),

  __default: base(),
};

export function getWorkflow(event) {
  return workflows[event] || workflows.__default;
}

export default getWorkflow;
