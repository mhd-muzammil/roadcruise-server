import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { PaymentService } from "../core/PaymentService.js";
import { PaymentRepository } from "../repository/PaymentRepository.js";
import { MockGateway } from "../gateways/MockGateway.js";
import { PaymentStatus, WebhookEvents } from "../config/paymentEvents.js";

// PaymentService.verifyAndCapture / handleWebhook -> _markPaid -> confirmBooking
// WRITES to src/config/db.json. We snapshot the exact bytes before the suite and
// restore them after, so the dev DB is left byte-identical.
//
// createOrderForBooking is idempotent PER bookingId (it reuses an existing
// active/PAID payment), so each test needs its OWN unique booking. We inject a
// throwaway booking into db.json per test; the snapshot/restore guarantees the
// file is byte-identical at the end regardless.
const __filename = fileURLToPath(import.meta.url);
const DB_PATH = path.resolve(path.dirname(__filename), "../../config/db.json");

let dbSnapshot;

before(() => {
  dbSnapshot = fs.readFileSync(DB_PATH);
});

after(() => {
  // Restore exact original bytes.
  fs.writeFileSync(DB_PATH, dbSnapshot);
});

// Insert a unique throwaway booking and return its id. Safe because the whole
// file is restored to its original bytes in `after`.
function addBooking(fare = 2400) {
  const bookingId = `RC-BK-TEST-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const db = JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
  db.bookings.push({
    id: bookingId,
    name: "Test Customer",
    phone: "+91 90000 00000",
    fromDate: "2026-06-20",
    toDate: "2026-06-25",
    item: "Test Vehicle",
    fare,
    status: "Pending",
    paymentMethod: "Card",
  });
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf-8");
  return bookingId;
}

// Each PaymentService gets its own gateway instance but shares the (singleton-
// equivalent) repository file. Unique gatewayOrderId per createOrder keeps rows
// from colliding across tests.
function makeService() {
  return new PaymentService({ repository: new PaymentRepository(), gateway: new MockGateway() });
}

test("happy path: createOrderForBooking -> simulateCheckout -> verifyAndCapture => PAID", async () => {
  const svc = makeService();
  const bookingId = addBooking(2400);
  const { payment, checkout } = await svc.createOrderForBooking({ bookingId, amount: 2400 });
  assert.equal(payment.status, PaymentStatus.CREATED);
  assert.ok(payment.invoiceNumber);
  assert.ok(checkout.orderId);

  const sim = svc.gateway.simulateCheckout(payment.gatewayOrderId);
  const res = await svc.verifyAndCapture({
    orderId: sim.razorpay_order_id,
    paymentId: sim.razorpay_payment_id,
    signature: sim.razorpay_signature,
  });
  assert.equal(res.verified, true);
  assert.equal(res.payment.status, PaymentStatus.PAID);
  assert.ok(res.payment.invoiceNumber, "invoiceNumber should be set on the paid payment");
  assert.ok(res.invoice);
  assert.ok(res.receipt);

  // Re-verify is idempotent -> alreadyPaid.
  const again = await svc.verifyAndCapture({
    orderId: sim.razorpay_order_id,
    paymentId: sim.razorpay_payment_id,
    signature: sim.razorpay_signature,
  });
  assert.equal(again.alreadyPaid, true);
  assert.equal(again.payment.status, PaymentStatus.PAID);
});

test("invalid signature throws INVALID_SIGNATURE and marks the payment FAILED", async () => {
  const svc = makeService();
  const bookingId = addBooking(1200);
  const { payment } = await svc.createOrderForBooking({ bookingId, amount: 1200 });

  await assert.rejects(
    () =>
      svc.verifyAndCapture({
        orderId: payment.gatewayOrderId,
        paymentId: "pay_mock_bad",
        signature: "deadbeefbadsig",
      }),
    (err) => {
      assert.equal(err.code, "INVALID_SIGNATURE");
      return true;
    }
  );

  const after = svc.repository.findByOrderId(payment.gatewayOrderId);
  assert.equal(after.status, PaymentStatus.FAILED);
  assert.equal(after.failureReason, "signature_verification_failed");
});

test("refund(paymentId) => status REFUNDED with a refund entry", async () => {
  const svc = makeService();
  const bookingId = addBooking(800);
  const { payment } = await svc.createOrderForBooking({ bookingId, amount: 800 });
  const sim = svc.gateway.simulateCheckout(payment.gatewayOrderId);
  await svc.verifyAndCapture({
    orderId: sim.razorpay_order_id,
    paymentId: sim.razorpay_payment_id,
    signature: sim.razorpay_signature,
  });

  const refunded = await svc.refund({ paymentId: payment.paymentId });
  assert.equal(refunded.status, PaymentStatus.REFUNDED);
  assert.ok(Array.isArray(refunded.refunds));
  assert.equal(refunded.refunds.length, 1);
  assert.equal(refunded.refunds[0].amount, 800);
});

test("handleWebhook payment.captured marks PAID; replayed eventId => duplicate", async () => {
  const svc = makeService();
  const bookingId = addBooking(1500);
  const { payment } = await svc.createOrderForBooking({ bookingId, amount: 1500 });

  const eventId = `evt_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const { body, signature } = svc.gateway.buildWebhook(WebhookEvents.PAYMENT_CAPTURED, {
    payment: { entity: { id: "pay_mock_wh", order_id: payment.gatewayOrderId } },
  });

  const first = await svc.handleWebhook({ rawBody: body, signature, eventId });
  assert.equal(first.ok, true);
  assert.equal(first.handled, WebhookEvents.PAYMENT_CAPTURED);

  const paid = svc.repository.findByOrderId(payment.gatewayOrderId);
  assert.equal(paid.status, PaymentStatus.PAID);

  // Replay the same eventId -> duplicate, no re-processing.
  const replay = await svc.handleWebhook({ rawBody: body, signature, eventId });
  assert.equal(replay.ok, true);
  assert.equal(replay.duplicate, true);
});

test("handleWebhook with bad signature => {ok:false, reason:'invalid_signature'}", async () => {
  const svc = makeService();
  const { body } = svc.gateway.buildWebhook(WebhookEvents.PAYMENT_CAPTURED, {
    payment: { entity: { id: "pay_mock_x", order_id: "order_mock_x" } },
  });
  const res = await svc.handleWebhook({ rawBody: body, signature: "not_a_valid_signature", eventId: "evt_bad" });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "invalid_signature");
});
