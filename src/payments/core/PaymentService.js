import { EventEmitter } from "events";
import { config } from "../config/payment.config.js";
import { PaymentStatus, PaymentEvents, WebhookEvents } from "../config/paymentEvents.js";
import { getGateway } from "../gateways/index.js";
import { toMinor, fromMinor } from "../gateways/Gateway.js";
import { getPaymentRepository } from "../repository/PaymentRepository.js";
import { generateReceiptNumber, generateInvoiceNumber } from "./receiptNumber.js";
import * as bookingBridge from "../integration/bookingBridge.js";
import * as notif from "../integration/notifications.js";
import { generateInvoice, generateReceipt } from "../receipts/ReceiptService.js";

/**
 * PaymentService — orchestrates the payment lifecycle over the Gateway interface.
 * Business modules call this; it never exposes the gateway. Backend NEVER trusts
 * frontend success: verifyAndCapture and handleWebhook both validate signatures
 * before mutating state, and all state changes are idempotent.
 */
export class PaymentService extends EventEmitter {
  constructor({ repository = getPaymentRepository(), gateway = getGateway() } = {}) {
    super();
    this.repository = repository;
    this.gateway = gateway;
  }

  _publicCheckout(payment) {
    return {
      provider: config.provider,
      keyId: config.provider === "razorpay" ? config.razorpay.keyId : "mock_key_id",
      orderId: payment.gatewayOrderId,
      amount: toMinor(payment.amount),
      currency: payment.currency,
      paymentId: payment.paymentId,
      receiptNumber: payment.receiptNumber,
    };
  }

  /**
   * Create (or reuse) a gateway order for a booking. Idempotent per booking:
   * an existing PAID payment is returned as-is; an active CREATED order is reused.
   */
  async createOrderForBooking({ bookingId, customerId, actor = "system" } = {}) {
    if (!config.enabled) throw new Error("Payments are disabled (PAYMENTS_ENABLED=false)");
    const booking = bookingBridge.getBooking(bookingId);
    if (!booking) {
      const err = new Error("Booking not found");
      err.code = "BOOKING_NOT_FOUND";
      throw err;
    }

    const existing = this.repository.findByBookingId(bookingId);
    const paid = existing.find((p) => p.status === PaymentStatus.PAID);
    if (paid) return { payment: paid, checkout: this._publicCheckout(paid), alreadyPaid: true };
    const active = existing.find((p) =>
      [PaymentStatus.CREATED, PaymentStatus.PENDING, PaymentStatus.AUTHORIZED].includes(p.status)
    );
    if (active) return { payment: active, checkout: this._publicCheckout(active), reused: true };

    // Authoritative amount: the server-side booking fare ONLY — never a client
    // value (anti price-tampering, C2).
    const amt = Number(booking.fare);
    const order = await this.gateway.createOrder({
      amount: toMinor(amt),
      currency: config.currency,
      receipt: generateReceiptNumber(),
      notes: { bookingId, customerId: customerId || booking.phone || null },
    });

    // Atomic dedupe on a stable per-booking "open order" key so two concurrent
    // requests can't create two live orders (double charge, H2). The key is
    // freed when the payment fails/refunds so a legitimate retry can re-open.
    const { record: payment, created } = await this.repository.createIfAbsent({
      bookingId,
      customerId: customerId || booking.phone || null,
      gateway: this.gateway.name,
      gatewayOrderId: order.orderId,
      receiptNumber: order.raw?.receipt || generateReceiptNumber(),
      invoiceNumber: generateInvoiceNumber(bookingId),
      currency: config.currency,
      amount: amt,
      tax: 0,
      discount: 0,
      paymentMethod: booking.paymentMethod || null,
      status: PaymentStatus.CREATED,
      idempotencyKey: `order:open:${bookingId}`,
    });
    if (!created) {
      return { payment, checkout: this._publicCheckout(payment), reused: true };
    }

    await this.repository.addTransaction({
      paymentId: payment.paymentId,
      type: "order_created",
      gatewayOrderId: order.orderId,
      amount: amt,
    });
    await this.repository.recordAudit({
      action: "order_created",
      actor,
      paymentId: payment.paymentId,
      bookingId,
      result: "ok",
    });
    this.emit(PaymentEvents.PAYMENT_CREATED, { payment });
    notif.emitPaymentPending(booking, { amount: amt, invoiceNumber: payment.invoiceNumber });

    return { payment, checkout: this._publicCheckout(payment) };
  }

  /**
   * Verify a checkout signature and capture. The trust anchor for the
   * browser-driven success path. Idempotent: a payment already PAID short-circuits.
   */
  async verifyAndCapture({ orderId, paymentId: gatewayPaymentId, signature, actor = "system" }) {
    const payment = this.repository.findByOrderId(orderId);
    if (!payment) {
      const err = new Error("Payment/order not found");
      err.code = "NOT_FOUND";
      throw err;
    }
    if (payment.status === PaymentStatus.PAID) {
      return { verified: true, alreadyPaid: true, payment };
    }

    const ok = this.gateway.verifyPayment({ orderId, paymentId: gatewayPaymentId, signature });
    if (!ok) {
      await this._fail(payment, "signature_verification_failed", actor);
      const err = new Error("Signature verification failed");
      err.code = "INVALID_SIGNATURE";
      throw err;
    }

    // Capture (idempotent at gateway for auto-capture providers).
    let captureStatus = "captured";
    try {
      const cap = await this.gateway.capturePayment({
        paymentId: gatewayPaymentId,
        amount: toMinor(payment.amount),
        currency: payment.currency,
      });
      captureStatus = cap.status || "captured";
    } catch (e) {
      // Capture failure is transient/recoverable — keep AUTHORIZED, audit, surface.
      await this.repository.update(payment.paymentId, {
        status: PaymentStatus.AUTHORIZED,
        gatewayPaymentId,
        gatewaySignature: signature,
      });
      await this.repository.recordAudit({
        action: "capture_failed",
        actor,
        paymentId: payment.paymentId,
        result: "error",
        detail: e.message,
      });
      throw e;
    }

    return this._markPaid(payment, { gatewayPaymentId, signature, captureStatus, actor, via: "checkout" });
  }

  /** Internal: transition a payment to PAID + confirm booking + emit notifications.
   * Uses an atomic compare-and-set so concurrent verify + webhook capture (and
   * terminal/failed payments) can never double-confirm, double-notify, or
   * resurrect a failed/refunded payment (H4/M4). */
  async _markPaid(payment, { gatewayPaymentId, signature, captureStatus, actor, via }) {
    const cas = await this.repository.transitionToPaid(payment.paymentId, {
      gatewayPaymentId: gatewayPaymentId || payment.gatewayPaymentId,
      gatewaySignature: signature || payment.gatewaySignature,
      capturedAt: new Date().toISOString(),
    });
    if (!cas.changed) {
      // Already paid (idempotent) or terminal (refused) — no side effects.
      return { verified: true, alreadyPaid: cas.record?.status === PaymentStatus.PAID, terminal: !!cas.terminal, payment: cas.record };
    }
    const updated = cas.record;

    const booking = bookingBridge.getBooking(payment.bookingId);
    if (booking) bookingBridge.confirmBooking(payment.bookingId);

    // Build documents (invoice + receipt) for audit/attachment.
    const invoice = generateInvoice(updated, booking || {});
    const receipt = generateReceipt(updated, booking || {});

    await this.repository.addTransaction({
      paymentId: updated.paymentId,
      type: "captured",
      gatewayPaymentId,
      amount: updated.amount,
      via,
      captureStatus,
    });
    await this.repository.recordAudit({
      action: "payment_captured",
      actor,
      paymentId: updated.paymentId,
      bookingId: updated.bookingId,
      result: "ok",
      detail: { via, invoiceNumber: updated.invoiceNumber, receiptNumber: updated.receiptNumber },
    });

    this.emit(PaymentEvents.PAYMENT_SUCCEEDED, { payment: updated, invoice, receipt });
    this.emit(PaymentEvents.INVOICE_GENERATED, { payment: updated, invoice });
    this.emit(PaymentEvents.BOOKING_CONFIRMED, { payment: updated, booking });

    if (booking) {
      notif.emitPaymentSucceeded(booking, {
        amount: updated.amount,
        invoiceNumber: updated.invoiceNumber,
        receiptNumber: updated.receiptNumber,
      });
    }
    return { verified: true, payment: updated, invoice, receipt };
  }

  async _fail(payment, reason, actor = "system") {
    const updated = await this.repository.update(payment.paymentId, {
      status: PaymentStatus.FAILED,
      failureReason: reason,
      // free the stable open-order key so a retry can open a fresh order
      idempotencyKey: `failed:${payment.paymentId}`,
    });
    await this.repository.recordAudit({
      action: "payment_failed",
      actor,
      paymentId: payment.paymentId,
      bookingId: payment.bookingId,
      result: "failed",
      detail: reason,
    });
    this.emit(PaymentEvents.PAYMENT_FAILED, { payment: updated, reason });
    const booking = bookingBridge.getBooking(payment.bookingId);
    if (booking) notif.emitPaymentFailed(booking, { amount: payment.amount, failureReason: reason });
    return updated;
  }

  /**
   * Process a verified webhook. The CALLER must pass the RAW body + signature;
   * this method verifies, dedupes (idempotent/replay-safe), and routes the event.
   * @returns {Promise<{ok, duplicate?, reason?, handled?}>}
   */
  async handleWebhook({ rawBody, signature, eventId, actor = "razorpay-webhook" }) {
    if (!config.webhookEnabled) return { ok: true, ignored: true };

    if (!this.gateway.verifyWebhook(rawBody, signature)) {
      await this.repository.recordAudit({ action: "webhook_rejected", actor, result: "invalid_signature" });
      return { ok: false, reason: "invalid_signature" };
    }

    let body;
    try {
      body = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : rawBody);
    } catch {
      return { ok: false, reason: "invalid_json" };
    }

    // A verifiable event id is REQUIRED for replay protection. Razorpay always
    // sends x-razorpay-event-id; refuse anything we cannot dedupe (H3).
    const id =
      eventId ||
      body?.id ||
      (body?.event && body?.payload?.payment?.entity?.id
        ? `${body.event}:${body.payload.payment.entity.id}`
        : null) ||
      (body?.event && body?.payload?.refund?.entity?.id
        ? `${body.event}:${body.payload.refund.entity.id}`
        : null);
    if (!id) {
      await this.repository.recordAudit({ action: "webhook_rejected", actor, result: "missing_event_id" });
      return { ok: false, reason: "missing_event_id" };
    }

    // Idempotency / replay protection: claim the event id atomically.
    const first = await this.repository.claimWebhook(id);
    if (!first) return { ok: true, duplicate: true };

    const event = body.event;
    await this.repository.recordAudit({
      action: "webhook_received",
      actor,
      result: "ok",
      detail: { event, id },
    });

    try {
      await this._routeWebhook(event, body, actor);
      return { ok: true, handled: event };
    } catch (e) {
      // Release the claim so the gateway's retry can re-process a transient
      // failure (otherwise the dedupe would permanently drop the event, M3).
      await this.repository.releaseWebhook(id);
      await this.repository.recordAudit({
        action: "webhook_error",
        actor,
        result: "error",
        detail: { event, error: e.message },
      });
      return { ok: false, reason: e.message };
    }
  }

  async _routeWebhook(event, body, actor) {
    const paymentEntity = body?.payload?.payment?.entity || {};
    const refundEntity = body?.payload?.refund?.entity || {};
    const orderId = paymentEntity.order_id;
    const payment = orderId ? this.repository.findByOrderId(orderId) : null;

    switch (event) {
      case WebhookEvents.PAYMENT_AUTHORIZED:
        if (payment && payment.status !== PaymentStatus.PAID) {
          await this.repository.update(payment.paymentId, {
            status: PaymentStatus.AUTHORIZED,
            gatewayPaymentId: paymentEntity.id,
          });
          this.emit(PaymentEvents.PAYMENT_AUTHORIZED, { payment });
        }
        break;

      case WebhookEvents.PAYMENT_CAPTURED:
      case WebhookEvents.ORDER_PAID:
        if (payment) {
          await this._markPaid(payment, {
            gatewayPaymentId: paymentEntity.id,
            signature: payment.gatewaySignature,
            captureStatus: "captured",
            actor,
            via: "webhook",
          });
        }
        break;

      case WebhookEvents.PAYMENT_FAILED:
        if (payment && payment.status !== PaymentStatus.PAID) {
          await this._fail(payment, paymentEntity.error_description || "payment_failed", actor);
        }
        break;

      case WebhookEvents.REFUND_CREATED:
        if (payment) {
          await this.repository.update(payment.paymentId, { status: PaymentStatus.REFUND_INITIATED });
          this.emit(PaymentEvents.REFUND_INITIATED, { payment });
          const b = bookingBridge.getBooking(payment.bookingId);
          if (b) notif.emitRefundInitiated(b, { amount: fromMinor(refundEntity.amount || 0) || payment.amount });
        }
        break;

      case WebhookEvents.REFUND_PROCESSED: {
        const refPayment =
          payment ||
          (refundEntity.payment_id ? this.repository.findByGatewayPaymentId(refundEntity.payment_id) : null);
        if (refPayment) await this._completeRefund(refPayment, fromMinor(refundEntity.amount || 0), actor);
        break;
      }

      default:
        // Unhandled event types are acknowledged (audited above) but not actioned.
        break;
    }
  }

  /**
   * Admin/manual refund. Must be PAID. Supports partial refunds.
   */
  async refund({ paymentId, amount, notes, actor = "admin" }) {
    const payment = this.repository.findById(paymentId);
    if (!payment) {
      const err = new Error("Payment not found");
      err.code = "NOT_FOUND";
      throw err;
    }
    if (payment.status !== PaymentStatus.PAID && payment.status !== PaymentStatus.PARTIALLY_REFUNDED) {
      const err = new Error(`Cannot refund a payment in status "${payment.status}"`);
      err.code = "INVALID_STATE";
      throw err;
    }

    // Cap the refund at the remaining (amount − already refunded) so repeated
    // partial refunds can never exceed the captured amount (C3, over-refund).
    const alreadyRefunded = (payment.refunds || []).reduce((s, r) => s + Number(r.amount || 0), 0);
    const remaining = Number(payment.amount) - alreadyRefunded;
    const refundAmount = Number(amount ?? remaining);
    if (!(refundAmount > 0) || refundAmount > remaining) {
      const err = new Error(
        `Refund amount ${refundAmount} exceeds remaining refundable ${remaining}`
      );
      err.code = "INVALID_STATE";
      throw err;
    }

    const res = await this.gateway.refund({
      paymentId: payment.gatewayPaymentId,
      amount: toMinor(refundAmount),
      notes,
    });

    await this.repository.update(payment.paymentId, { status: PaymentStatus.REFUND_INITIATED });
    await this.repository.addTransaction({
      paymentId: payment.paymentId,
      type: "refund_initiated",
      refundId: res.refundId,
      amount: refundAmount,
    });
    await this.repository.recordAudit({
      action: "refund_initiated",
      actor,
      paymentId: payment.paymentId,
      result: "ok",
      detail: { refundId: res.refundId, amount: refundAmount },
    });
    this.emit(PaymentEvents.REFUND_INITIATED, { payment, refundId: res.refundId });
    const booking = bookingBridge.getBooking(payment.bookingId);
    if (booking) notif.emitRefundInitiated(booking, { amount: refundAmount, invoiceNumber: payment.invoiceNumber });

    // Mock/auto-processed gateways complete immediately; real refunds complete via webhook.
    if (res.status === "processed") {
      await this._completeRefund(payment, refundAmount, actor, res.refundId);
    }
    return this.repository.findById(payment.paymentId);
  }

  async _completeRefund(payment, amount, actor = "system", refundId = null) {
    const fresh = this.repository.findById(payment.paymentId);
    const totalRefunded =
      (fresh.refunds || []).reduce((s, r) => s + Number(r.amount || 0), 0) + Number(amount || 0);
    const status =
      totalRefunded >= Number(fresh.amount) ? PaymentStatus.REFUNDED : PaymentStatus.PARTIALLY_REFUNDED;

    const updated = await this.repository.update(payment.paymentId, {
      status,
      refundedAt: new Date().toISOString(),
      refunds: [...(fresh.refunds || []), { refundId, amount, at: new Date().toISOString() }],
      // On full refund, free the open-order key so the booking could be re-ordered.
      ...(status === PaymentStatus.REFUNDED ? { idempotencyKey: `refunded:${payment.paymentId}` } : {}),
    });
    await this.repository.recordAudit({
      action: "refund_completed",
      actor,
      paymentId: payment.paymentId,
      result: "ok",
      detail: { amount, status },
    });
    this.emit(PaymentEvents.REFUND_COMPLETED, { payment: updated });
    const booking = bookingBridge.getBooking(payment.bookingId);
    if (booking) notif.emitRefundCompleted(booking, { amount, invoiceNumber: updated.invoiceNumber });
    return updated;
  }
}

let instance = null;
export function getPaymentService() {
  if (!instance) instance = new PaymentService();
  return instance;
}

export default getPaymentService;
