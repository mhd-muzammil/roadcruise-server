import { randomUUID } from "crypto";
import { PaymentGateway } from "./Gateway.js";
import { config } from "../config/payment.config.js";
import {
  verifyCheckoutSignature,
  verifyWebhookSignature,
  signCheckout,
  signWebhook,
} from "../core/signature.js";

/**
 * Default gateway. Emulates Razorpay's order/verify/capture/refund/webhook
 * surface using deterministic HMAC signatures (with config.mockSecret) so the
 * ENTIRE payment flow — including signature verification and webhooks — works
 * end-to-end with no Razorpay account. Real-money calls are never made.
 *
 * Test/dev helpers (simulateCheckout / buildWebhook) let callers produce a
 * VALID signed checkout result and webhook payload, exactly as the real gateway
 * + a real customer browser would.
 */
export class MockGateway extends PaymentGateway {
  get name() {
    return "mock";
  }

  async createOrder({ amount, currency, receipt, notes }) {
    const orderId = `order_mock_${randomUUID().replace(/-/g, "").slice(0, 14)}`;
    return {
      orderId,
      amount,
      currency,
      status: "created",
      raw: { id: orderId, amount, currency, receipt, notes, mock: true },
    };
  }

  verifyPayment({ orderId, paymentId, signature }) {
    return verifyCheckoutSignature({ orderId, paymentId, signature }, config.mockSecret);
  }

  async capturePayment({ paymentId, amount, currency }) {
    return { status: "captured", raw: { id: paymentId, amount, currency, captured: true, mock: true } };
  }

  async fetchPayment(paymentId) {
    return { id: paymentId, status: "captured", mock: true };
  }

  async refund({ paymentId, amount, notes }) {
    const refundId = `rfnd_mock_${randomUUID().replace(/-/g, "").slice(0, 14)}`;
    return { refundId, status: "processed", amount, raw: { id: refundId, paymentId, notes, mock: true } };
  }

  verifyWebhook(rawBody, signature) {
    return verifyWebhookSignature(rawBody, signature, config.mockSecret);
  }

  // ---- dev/test helpers (simulate the browser + gateway) ----

  /** Produce a valid signed checkout result for an order (as the browser returns). */
  simulateCheckout(orderId) {
    const paymentId = `pay_mock_${randomUUID().replace(/-/g, "").slice(0, 14)}`;
    return {
      razorpay_order_id: orderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: signCheckout(orderId, paymentId, config.mockSecret),
    };
  }

  /** Produce a webhook { body, signature } pair for an event. */
  buildWebhook(event, payloadObj) {
    const body = JSON.stringify({ event, payload: payloadObj });
    return { body, signature: signWebhook(body, config.mockSecret) };
  }
}

export default MockGateway;
