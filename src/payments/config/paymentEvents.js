/**
 * Payment-domain event + state catalog.
 *
 * PaymentEvents are emitted on the payment module's own EventEmitter for
 * observability/admin. The CROSS-MODULE notifications (customer email/SMS/
 * WhatsApp) are emitted by reusing the existing notification engine's events
 * (NotificationEvents.PAYMENT_SUCCESSFUL / INVOICE_GENERATED / BOOKING_CONFIRMED)
 * via integration/notifications.js — the payment module never calls a provider.
 */
export const PaymentEvents = Object.freeze({
  PAYMENT_CREATED: "payment.created",
  PAYMENT_AUTHORIZED: "payment.authorized",
  PAYMENT_SUCCEEDED: "payment.succeeded",
  PAYMENT_FAILED: "payment.failed",
  PAYMENT_CANCELLED: "payment.cancelled",
  PAYMENT_EXPIRED: "payment.expired",
  REFUND_INITIATED: "payment.refund_initiated",
  REFUND_COMPLETED: "payment.refund_completed",
  INVOICE_GENERATED: "payment.invoice_generated",
  BOOKING_CONFIRMED: "payment.booking_confirmed",
});

/**
 * Canonical payment lifecycle states. Transitions are enforced in PaymentService.
 *
 *   PENDING -> CREATED -> AUTHORIZED -> CAPTURED -> PAID
 *   (any) -> FAILED | CANCELLED | EXPIRED
 *   PAID -> REFUND_INITIATED -> REFUNDED | PARTIALLY_REFUNDED
 */
export const PaymentStatus = Object.freeze({
  PENDING: "pending",
  CREATED: "created",
  AUTHORIZED: "authorized",
  CAPTURED: "captured",
  PAID: "paid",
  FAILED: "failed",
  CANCELLED: "cancelled",
  EXPIRED: "expired",
  REFUND_INITIATED: "refund_initiated",
  REFUNDED: "refunded",
  PARTIALLY_REFUNDED: "partially_refunded",
});

/** Terminal states a payment can no longer leave (except refunds from PAID). */
export const TERMINAL_STATES = new Set([
  PaymentStatus.FAILED,
  PaymentStatus.CANCELLED,
  PaymentStatus.EXPIRED,
  PaymentStatus.REFUNDED,
]);

/** Razorpay webhook event names this module handles. */
export const WebhookEvents = Object.freeze({
  PAYMENT_AUTHORIZED: "payment.authorized",
  PAYMENT_CAPTURED: "payment.captured",
  PAYMENT_FAILED: "payment.failed",
  REFUND_CREATED: "refund.created",
  REFUND_PROCESSED: "refund.processed",
  ORDER_PAID: "order.paid",
});

export const ALL_PAYMENT_EVENTS = Object.values(PaymentEvents);
export const ALL_PAYMENT_STATUSES = Object.values(PaymentStatus);
