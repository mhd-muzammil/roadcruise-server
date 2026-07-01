/**
 * PaymentGateway contract. Business code (and PaymentService) depends ONLY on
 * this interface — never on Razorpay directly. Adding Stripe/Cashfree/PhonePe/
 * PayPal means implementing this interface and registering it in gateways/index.js;
 * no booking or service code changes.
 *
 * Money convention: `amount` passed to/from gateway methods is in the smallest
 * currency unit (paise for INR). Helpers toMinor/fromMinor handle conversion;
 * PaymentService stores major units (rupees) in records and converts at the edge.
 */
export class PaymentGateway {
  get name() {
    return "base";
  }

  /** Create a gateway order. @returns {Promise<{orderId, amount, currency, status, raw}>} */
  // eslint-disable-next-line no-unused-vars
  async createOrder({ amount, currency, receipt, notes }) {
    throw new Error("createOrder not implemented");
  }

  /** Verify a checkout signature synchronously. @returns {boolean} */
  // eslint-disable-next-line no-unused-vars
  verifyPayment({ orderId, paymentId, signature }) {
    throw new Error("verifyPayment not implemented");
  }

  /** Capture an authorized payment. @returns {Promise<{status, raw}>} */
  // eslint-disable-next-line no-unused-vars
  async capturePayment({ paymentId, amount, currency }) {
    throw new Error("capturePayment not implemented");
  }

  /** Fetch payment details from the gateway. @returns {Promise<object>} */
  // eslint-disable-next-line no-unused-vars
  async fetchPayment(paymentId) {
    throw new Error("fetchPayment not implemented");
  }

  /** Initiate a (partial or full) refund. @returns {Promise<{refundId, status, amount, raw}>} */
  // eslint-disable-next-line no-unused-vars
  async refund({ paymentId, amount, notes }) {
    throw new Error("refund not implemented");
  }

  /** Verify a webhook signature against the raw body. @returns {boolean} */
  // eslint-disable-next-line no-unused-vars
  verifyWebhook(rawBody, signature) {
    throw new Error("verifyWebhook not implemented");
  }
}

export const toMinor = (major) => Math.round(Number(major) * 100);
export const fromMinor = (minor) => Number(minor) / 100;

export default PaymentGateway;
