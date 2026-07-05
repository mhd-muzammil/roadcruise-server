import { notify, NotificationEvents } from "../../notifications/index.js";

/**
 * Notification bridge. The payment module NEVER calls Twilio/SMTP/Meta — it only
 * emits domain events into the existing notification engine via notify(). The
 * engine fans out to Email/SMS/WhatsApp. Payloads carry the fields the existing
 * templates expect (paymentAmount, paymentStatus, invoiceNumber, id, name, phone…).
 */
const base = (booking, extra = {}) => ({ ...booking, ...extra });

/**
 * Verified payment success. Sends exactly:
 *   1. INVOICE_GENERATED   -> customer Email + WhatsApp (the invoice/receipt)
 *   2. BOOKING_CONFIRMED   -> customer SMS + WhatsApp (trip confirmed)
 *   3. ADMIN_BOOKING_PAID  -> the business's own Email + WhatsApp (customer details)
 * (Channel targeting is defined in notifications/workflows/registry.js.)
 */
export function emitPaymentSucceeded(booking, { amount, invoiceNumber, receiptNumber } = {}) {
  const payload = base(booking, {
    paymentAmount: amount ?? booking.fare,
    paymentStatus: "Paid",
    invoiceNumber,
    receiptNumber,
  });
  notify(NotificationEvents.INVOICE_GENERATED, payload, { actor: "payment-service" });
  notify(NotificationEvents.BOOKING_CONFIRMED, payload, { actor: "payment-service" });
  notify(NotificationEvents.ADMIN_BOOKING_PAID, payload, { actor: "payment-service" });
}

export function emitPaymentPending(booking, { amount, invoiceNumber } = {}) {
  notify(
    NotificationEvents.PAYMENT_PENDING,
    base(booking, { paymentAmount: amount ?? booking.fare, paymentStatus: "Pending", invoiceNumber }),
    { actor: "payment-service" }
  );
}

export function emitPaymentFailed(booking, { amount, failureReason } = {}) {
  notify(
    NotificationEvents.PAYMENT_FAILED,
    base(booking, { paymentAmount: amount ?? booking.fare, paymentStatus: "Failed", failureReason }),
    { actor: "payment-service" }
  );
}

export function emitRefundInitiated(booking, { amount, invoiceNumber } = {}) {
  notify(
    NotificationEvents.REFUND_INITIATED,
    base(booking, { paymentAmount: amount ?? booking.fare, paymentStatus: "Refund Initiated", invoiceNumber }),
    { actor: "payment-service" }
  );
}

export function emitRefundCompleted(booking, { amount, invoiceNumber } = {}) {
  notify(
    NotificationEvents.REFUND_COMPLETED,
    base(booking, { paymentAmount: amount ?? booking.fare, paymentStatus: "Refunded", invoiceNumber }),
    { actor: "payment-service" }
  );
}

export default {
  emitPaymentSucceeded,
  emitPaymentPending,
  emitPaymentFailed,
  emitRefundInitiated,
  emitRefundCompleted,
};
