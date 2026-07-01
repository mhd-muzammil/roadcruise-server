import { test } from "node:test";
import assert from "node:assert/strict";

import { MockGateway } from "../gateways/MockGateway.js";
import { toMinor, fromMinor } from "../gateways/Gateway.js";
import { WebhookEvents } from "../config/paymentEvents.js";

const gw = new MockGateway();

test("gateway name is mock", () => {
  assert.equal(gw.name, "mock");
});

test("createOrder returns an orderId, amount and currency", async () => {
  const order = await gw.createOrder({ amount: 240000, currency: "INR", receipt: "RC-RCPT-X", notes: {} });
  assert.match(order.orderId, /^order_mock_/);
  assert.equal(order.amount, 240000);
  assert.equal(order.currency, "INR");
  assert.equal(order.status, "created");
  assert.equal(order.raw.id, order.orderId);
});

test("verifyPayment true for simulateCheckout output", () => {
  const order = "order_mock_verify";
  const checkout = gw.simulateCheckout(order);
  assert.equal(checkout.razorpay_order_id, order);
  assert.match(checkout.razorpay_payment_id, /^pay_mock_/);
  const ok = gw.verifyPayment({
    orderId: checkout.razorpay_order_id,
    paymentId: checkout.razorpay_payment_id,
    signature: checkout.razorpay_signature,
  });
  assert.equal(ok, true);
});

test("verifyPayment false for garbage signature", () => {
  const ok = gw.verifyPayment({
    orderId: "order_mock_x",
    paymentId: "pay_mock_x",
    signature: "deadbeef",
  });
  assert.equal(ok, false);
});

test("capturePayment reports captured", async () => {
  const cap = await gw.capturePayment({ paymentId: "pay_mock_cap", amount: 100, currency: "INR" });
  assert.equal(cap.status, "captured");
  assert.equal(cap.raw.captured, true);
});

test("refund returns a processed refund with an id", async () => {
  const res = await gw.refund({ paymentId: "pay_mock_ref", amount: 5000, notes: {} });
  assert.match(res.refundId, /^rfnd_mock_/);
  assert.equal(res.status, "processed");
  assert.equal(res.amount, 5000);
});

test("buildWebhook + verifyWebhook round-trip", () => {
  const { body, signature } = gw.buildWebhook(WebhookEvents.PAYMENT_CAPTURED, {
    payment: { entity: { id: "pay_mock_wh", order_id: "order_mock_wh" } },
  });
  assert.equal(gw.verifyWebhook(body, signature), true);
  // tampered body fails
  assert.equal(gw.verifyWebhook(body + "x", signature), false);
  const parsed = JSON.parse(body);
  assert.equal(parsed.event, WebhookEvents.PAYMENT_CAPTURED);
});

test("toMinor / fromMinor convert rupees <-> paise", () => {
  assert.equal(toMinor(2400), 240000);
  assert.equal(toMinor(99.99), 9999);
  assert.equal(toMinor(0.1), 10);
  assert.equal(fromMinor(240000), 2400);
  assert.equal(fromMinor(9999), 99.99);
  // round-trip
  assert.equal(fromMinor(toMinor(1234.56)), 1234.56);
});
