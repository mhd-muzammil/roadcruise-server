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
 * Default template context builder. Maps a domain payload onto the canonical
 * placeholder names ({{customerName}}, {{bookingId}}, ...). Branding is merged
 * in by the engine, but included here for completeness.
 */
export function defaultContext(payload = {}) {
  return {
    ...config.branding,
    customerName: payload.name || payload.customerName || "Customer",
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
    // ---- additive: auth flows (password reset / email verification / OTP) ----
    resetLink: payload.resetLink || "",
    verificationLink: payload.verificationLink || "",
    otp: payload.otp || "",
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
  [NotificationEvents.BOOKING_CONFIRMED]: base(),
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

  [NotificationEvents.INVOICE_GENERATED]: base([Channels.EMAIL]),

  [NotificationEvents.CUSTOMER_REGISTERED]: base([Channels.EMAIL, Channels.WHATSAPP]),
  [NotificationEvents.OTP_REQUESTED]: base([Channels.SMS, Channels.EMAIL]),
  [NotificationEvents.PASSWORD_RESET]: base([Channels.EMAIL]),
  [NotificationEvents.EMAIL_VERIFICATION]: base([Channels.EMAIL]),

  __default: base(),
};

export function getWorkflow(event) {
  return workflows[event] || workflows.__default;
}

export default getWorkflow;
