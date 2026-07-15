import { test, before } from "node:test";
import assert from "node:assert/strict";

import { PaymentService } from "../core/PaymentService.js";
import { PaymentRepository } from "../repository/PaymentRepository.js";
import { MockGateway } from "../gateways/MockGateway.js";
import { PaymentStatus, WebhookEvents } from "../config/paymentEvents.js";
import { useTempDb, seedBooking } from "../../db/testSupport.js";
import { getBookingById } from "../../utils/db.js";

// PaymentService.verifyAndCapture / handleWebhook -> _markPaid -> confirmBooking
// writes booking state. Bookings live in an isolated, empty temp SQLite DB per
// run (never the real one). createOrderForBooking is idempotent PER bookingId,
// so each test needs its OWN unique booking.
before(() => useTempDb());

// Insert a unique throwaway booking and return its id.
let bkCounter = 0;
function addBooking(fare = 2400) {
  const bookingId = `RC-BK-TEST-${process.pid}-${bkCounter++}`;
  seedBooking({
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

test("a verified payment CONFIRMS the booking (status -> Approved)", async () => {
  // Directly guards the reported bug: after a successful payment the booking must
  // transition to the confirmed state (so the UI shows "Confirmed" and the paid
  // notifications fire), not stay Pending.
  const svc = makeService();
  const bookingId = addBooking(1000);
  assert.equal(getBookingById(bookingId).status, "Pending");

  const { payment } = await svc.createOrderForBooking({ bookingId, amount: 1000 });
  const sim = svc.gateway.simulateCheckout(payment.gatewayOrderId);
  await svc.verifyAndCapture({
    orderId: sim.razorpay_order_id,
    paymentId: sim.razorpay_payment_id,
    signature: sim.razorpay_signature,
  });

  assert.equal(getBookingById(bookingId).status, "Approved");
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
