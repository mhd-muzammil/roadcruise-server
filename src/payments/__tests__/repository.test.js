import { test } from "node:test";
import assert from "node:assert/strict";

import { PaymentRepository } from "../repository/PaymentRepository.js";
import { PaymentStatus } from "../config/paymentEvents.js";

// The repository writes to src/payments/data/payments.json. Tests stay
// independent by namespacing every id/key/bookingId with the test name + a
// random suffix, so they never collide with each other or pre-existing rows.
const repo = new PaymentRepository();
const uid = (name) => `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

test("create assigns defaults and findById returns the row", async () => {
  const bookingId = uid("create-bk");
  const created = await repo.create({
    bookingId,
    gateway: "mock",
    gatewayOrderId: uid("create-ord"),
    amount: 2400,
    status: PaymentStatus.CREATED,
  });
  assert.ok(created.paymentId);
  assert.equal(created.status, PaymentStatus.CREATED);
  assert.equal(created.currency, "INR");
  assert.equal(created.tax, 0);
  assert.deepEqual(created.refunds, []);
  assert.ok(created.createdAt);

  const found = repo.findById(created.paymentId);
  assert.ok(found);
  assert.equal(found.paymentId, created.paymentId);
});

test("update merges patch and bumps updatedAt; returns null for unknown id", async () => {
  const created = await repo.create({ bookingId: uid("upd-bk"), gateway: "mock", amount: 100 });
  const updated = await repo.update(created.paymentId, { status: PaymentStatus.PAID, capturedAt: "x" });
  assert.equal(updated.status, PaymentStatus.PAID);
  assert.equal(updated.capturedAt, "x");
  assert.notEqual(updated.updatedAt, undefined);

  const missing = await repo.update("RC-PAY-DOES-NOT-EXIST", { status: PaymentStatus.PAID });
  assert.equal(missing, null);
});

test("findByOrderId and findByBookingId locate rows", async () => {
  const bookingId = uid("find-bk");
  const orderId = uid("find-ord");
  const created = await repo.create({ bookingId, gatewayOrderId: orderId, gateway: "mock", amount: 500 });

  const byOrder = repo.findByOrderId(orderId);
  assert.ok(byOrder);
  assert.equal(byOrder.paymentId, created.paymentId);

  const byBooking = repo.findByBookingId(bookingId);
  assert.equal(byBooking.length, 1);
  assert.equal(byBooking[0].paymentId, created.paymentId);

  assert.equal(repo.findByOrderId("no-such-order"), null);
});

test("query filters by status and bookingId", async () => {
  const bookingId = uid("query-bk");
  await repo.create({ bookingId, gatewayOrderId: uid("q1"), gateway: "mock", amount: 1, status: PaymentStatus.PAID });
  await repo.create({ bookingId, gatewayOrderId: uid("q2"), gateway: "mock", amount: 2, status: PaymentStatus.FAILED });

  const all = repo.query({ bookingId });
  assert.equal(all.total, 2);

  const paidOnly = repo.query({ bookingId, status: PaymentStatus.PAID });
  assert.equal(paidOnly.total, 1);
  assert.equal(paidOnly.items[0].status, PaymentStatus.PAID);
});

test("createIfAbsent dedupes on idempotencyKey", async () => {
  const key = uid("idem-key");
  const bookingId = uid("idem-bk");
  const first = await repo.createIfAbsent({ idempotencyKey: key, bookingId, gateway: "mock", amount: 10 });
  assert.equal(first.created, true);

  const second = await repo.createIfAbsent({ idempotencyKey: key, bookingId, gateway: "mock", amount: 10 });
  assert.equal(second.created, false);
  assert.equal(second.record.paymentId, first.record.paymentId);
});

test("claimWebhook returns true first time then false (replay protection)", async () => {
  const eventId = uid("evt");
  assert.equal(await repo.claimWebhook(eventId), true);
  assert.equal(await repo.claimWebhook(eventId), false);
  // null eventId -> always processable
  assert.equal(await repo.claimWebhook(null), true);
});

test("addTransaction and recordAudit append entries", async () => {
  const paymentId = uid("txn-pay");
  const txn = await repo.addTransaction({ paymentId, type: "order_created", amount: 99 });
  assert.equal(txn.type, "order_created");
  assert.ok(txn.at);
  const txns = await repo.listTransactions(paymentId);
  assert.equal(txns.length, 1);
  assert.equal(txns[0].amount, 99);

  const audit = await repo.recordAudit({ paymentId, action: "test_action", result: "ok" });
  assert.equal(audit.action, "test_action");
  assert.ok(audit.at);
  const list = await repo.listAudit({ paymentId });
  assert.equal(list.total, 1);
  assert.equal(list.items[0].action, "test_action");
});
