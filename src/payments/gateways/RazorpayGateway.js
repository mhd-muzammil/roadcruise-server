import { PaymentGateway } from "./Gateway.js";
import { config } from "../config/payment.config.js";
import { verifyCheckoutSignature, verifyWebhookSignature } from "../core/signature.js";

/**
 * Real Razorpay adapter. DORMANT unless PAYMENT_PROVIDER=razorpay. The razorpay
 * SDK is lazy-imported so it is never a hard dependency of the mock path.
 * Signature verification reuses the shared timing-safe HMAC utils (the same math
 * Razorpay documents), so verification does not depend on the SDK.
 */

// The razorpay SDK rejects API failures with a PLAIN OBJECT
// ({ statusCode, error: { code, description } }), not an Error — so e.message
// is undefined and callers that do `res.json({ error: e.message })` emit an
// empty body, hiding the real cause (e.g. 401 "Authentication failed" on a bad
// key secret). Normalize every SDK rejection into a real Error here.
const asError = (e) => {
  if (e instanceof Error) return e;
  const err = new Error(
    e?.error?.description || e?.message || `Razorpay request failed (HTTP ${e?.statusCode ?? "unknown"})`
  );
  err.code = e?.error?.code || "GATEWAY_ERROR";
  err.statusCode = e?.statusCode;
  err.raw = e;
  return err;
};

export class RazorpayGateway extends PaymentGateway {
  constructor() {
    super();
    this._client = null;
  }
  get name() {
    return "razorpay";
  }

  async _c() {
    if (this._client) return this._client;
    let Razorpay;
    try {
      Razorpay = (await import("razorpay")).default;
    } catch {
      throw new Error("PAYMENT_PROVIDER=razorpay but 'razorpay' is not installed. Run: npm i razorpay");
    }
    if (!config.razorpay.keyId || !config.razorpay.keySecret) {
      throw new Error("RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are required");
    }
    this._client = new Razorpay({ key_id: config.razorpay.keyId, key_secret: config.razorpay.keySecret });
    return this._client;
  }

  async createOrder({ amount, currency, receipt, notes }) {
    const client = await this._c();
    try {
      const order = await client.orders.create({ amount, currency, receipt, notes, payment_capture: 1 });
      return { orderId: order.id, amount: order.amount, currency: order.currency, status: order.status, raw: order };
    } catch (e) {
      throw asError(e);
    }
  }

  verifyPayment({ orderId, paymentId, signature }) {
    return verifyCheckoutSignature({ orderId, paymentId, signature }, config.razorpay.keySecret);
  }

  async capturePayment({ paymentId, amount, currency }) {
    const client = await this._c();
    try {
      const res = await client.payments.capture(paymentId, amount, currency);
      return { status: res.status, raw: res };
    } catch (e) {
      throw asError(e);
    }
  }

  async fetchPayment(paymentId) {
    const client = await this._c();
    try {
      return await client.payments.fetch(paymentId);
    } catch (e) {
      throw asError(e);
    }
  }

  async refund({ paymentId, amount, notes }) {
    const client = await this._c();
    try {
      const res = await client.payments.refund(paymentId, { amount, notes });
      return { refundId: res.id, status: res.status, amount: res.amount, raw: res };
    } catch (e) {
      throw asError(e);
    }
  }

  verifyWebhook(rawBody, signature) {
    return verifyWebhookSignature(rawBody, signature, config.razorpay.webhookSecret);
  }
}

export default RazorpayGateway;
