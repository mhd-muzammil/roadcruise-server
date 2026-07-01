import paymentRoutes from "./api/payment.routes.js";
import { config, validateEnv } from "./config/payment.config.js";
import { getPaymentService } from "./core/PaymentService.js";
import { PaymentEvents, PaymentStatus } from "./config/paymentEvents.js";

/**
 * ============================================================================
 *  ENTERPRISE PAYMENT MODULE (Razorpay) — public facade
 * ============================================================================
 *
 * Provider-agnostic, additive, non-breaking. Business modules interact via:
 *   1. HTTP:  /api/payments/* (checkout, verify, webhook, admin)
 *   2. Code:  getPaymentService() — createOrderForBooking / verifyAndCapture /
 *             handleWebhook / refund  (over the Gateway interface; never Razorpay
 *             directly). Payment success emits into the existing notification
 *             engine, which sends Email/SMS/WhatsApp.
 *
 * Usage in app bootstrap (after notifications.init):
 *   import payments from "./payments/index.js";
 *   payments.init(app);
 */
function init(app) {
  if (!config.enabled) {
    console.log("[payments] DISABLED via PAYMENTS_ENABLED=false");
    return null;
  }
  const { ok, errors } = validateEnv();
  if (!ok) {
    // Fail loud but never crash the host app — payments simply won't process
    // until the env is fixed.
    console.warn(`[payments] env validation failed: ${errors.join("; ")}`);
  }
  const service = getPaymentService();
  if (app) app.use("/api/payments", paymentRoutes);
  console.log(
    `[payments] module ready — provider=${config.provider}, webhooks=${config.webhookEnabled ? "on" : "off"}`
  );
  return service;
}

export { init, getPaymentService, PaymentEvents, PaymentStatus };
export default { init, getPaymentService, PaymentEvents, PaymentStatus };
