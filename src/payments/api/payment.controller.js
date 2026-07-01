import { getPaymentService } from "../core/PaymentService.js";
import { getPaymentRepository } from "../repository/PaymentRepository.js";
import { config } from "../config/payment.config.js";
import { PaymentStatus } from "../config/paymentEvents.js";
import { generateInvoice, generateReceipt } from "../receipts/ReceiptService.js";
import * as bookingBridge from "../integration/bookingBridge.js";

const service = () => getPaymentService();
const repo = () => getPaymentRepository();

// GET /api/payments/config  — public checkout config for the frontend (no secrets)
export const getConfig = (_req, res) => {
  res.json({
    enabled: config.enabled,
    provider: config.provider,
    keyId: config.provider === "razorpay" ? config.razorpay.keyId : "mock_key_id",
    currency: config.currency,
    webhookEnabled: config.webhookEnabled,
  });
};

// POST /api/payments/orders  — create (or reuse) an order for a booking.
// SECURITY: the charge amount is ALWAYS the authoritative server-side booking
// fare. A client-supplied amount is intentionally ignored (anti price-tampering).
export const createOrder = async (req, res) => {
  try {
    const { bookingId, customerId } = req.body || {};
    if (!bookingId) return res.status(400).json({ error: "bookingId is required" });
    const result = await service().createOrderForBooking({
      bookingId,
      customerId,
      actor: "customer",
    });
    res.status(201).json(result);
  } catch (e) {
    const status = e.code === "BOOKING_NOT_FOUND" ? 404 : 400;
    res.status(status).json({ error: e.message });
  }
};

// POST /api/payments/verify  — verify checkout signature + capture
// body: { razorpay_order_id, razorpay_payment_id, razorpay_signature }
export const verify = async (req, res) => {
  try {
    const b = req.body || {};
    const orderId = b.razorpay_order_id || b.orderId;
    const paymentId = b.razorpay_payment_id || b.paymentId;
    const signature = b.razorpay_signature || b.signature;
    if (!orderId || !paymentId || !signature) {
      return res.status(400).json({ error: "order id, payment id and signature are required" });
    }
    const result = await service().verifyAndCapture({ orderId, paymentId, signature });
    res.json({ success: true, status: result.payment.status, paymentId: result.payment.paymentId });
  } catch (e) {
    if (e.code === "INVALID_SIGNATURE") return res.status(400).json({ success: false, error: e.message });
    if (e.code === "NOT_FOUND") return res.status(404).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
};

// POST /api/payments/webhook  — gateway -> us. Uses RAW body for signature.
export const webhook = async (req, res) => {
  const signature = req.get("x-razorpay-signature");
  const eventId = req.get("x-razorpay-event-id");
  // req.rawBody is captured by the express.json verify hook in app.js. We must
  // NEVER fall back to re-stringifying req.body — re-serialized JSON will not
  // byte-match the gateway's payload and would defeat/forge HMAC verification.
  const rawBody = req.rawBody;
  if (!rawBody) return res.status(400).json({ ok: false, reason: "no_raw_body" });
  const result = await service().handleWebhook({ rawBody, signature, eventId });
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
};

// ---- admin (guarded) ----

// GET /api/payments
export const list = (req, res) => {
  res.json(
    repo().query({
      status: req.query.status,
      bookingId: req.query.bookingId,
      customerId: req.query.customerId,
      gateway: req.query.gateway,
      search: req.query.search,
      limit: req.query.limit,
      offset: req.query.offset,
    })
  );
};

// GET /api/payments/:paymentId  — detail + ledger + audit
export const getOne = async (req, res) => {
  const payment = repo().findById(req.params.paymentId);
  if (!payment) return res.status(404).json({ error: "Payment not found" });
  const transactions = await repo().listTransactions(payment.paymentId);
  const audit = await repo().listAudit({ paymentId: payment.paymentId });
  res.json({ ...payment, transactions, audit: audit.items });
};

// POST /api/payments/:paymentId/refund   body: { amount?, notes? }
export const refund = async (req, res) => {
  try {
    const updated = await service().refund({
      paymentId: req.params.paymentId,
      amount: req.body?.amount,
      notes: req.body?.notes,
      actor: req.get("x-admin-actor") || "admin",
    });
    res.json(updated);
  } catch (e) {
    const status = e.code === "NOT_FOUND" ? 404 : e.code === "INVALID_STATE" ? 409 : 500;
    res.status(status).json({ error: e.message });
  }
};

// POST /api/payments/:paymentId/retry  — re-create an order for a failed payment
export const retry = async (req, res) => {
  const payment = repo().findById(req.params.paymentId);
  if (!payment) return res.status(404).json({ error: "Payment not found" });
  if (![PaymentStatus.FAILED, PaymentStatus.CANCELLED, PaymentStatus.EXPIRED].includes(payment.status)) {
    return res.status(409).json({ error: `Cannot retry a payment in status "${payment.status}"` });
  }
  try {
    const result = await service().createOrderForBooking({
      bookingId: payment.bookingId,
      customerId: payment.customerId,
      actor: req.get("x-admin-actor") || "admin",
    });
    res.status(201).json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
};

// GET /api/payments/:paymentId/receipt?type=invoice|receipt
export const receipt = (req, res) => {
  const payment = repo().findById(req.params.paymentId);
  if (!payment) return res.status(404).json({ error: "Payment not found" });
  const booking = bookingBridge.getBooking(payment.bookingId) || {};
  const doc = req.query.type === "invoice" ? generateInvoice(payment, booking) : generateReceipt(payment, booking);
  res.json(doc);
};

export default { getConfig, createOrder, verify, webhook, list, getOne, refund, retry, receipt };
