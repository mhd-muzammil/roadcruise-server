import { test } from "node:test";
import assert from "node:assert/strict";

import { MockGateway } from "../gateways/MockGateway.js";
import { RazorpayGateway } from "../gateways/RazorpayGateway.js";
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

test("RazorpayGateway surfaces SDK plain-object rejections as real Errors", async () => {
  const rzp = new RazorpayGateway();
  // The razorpay SDK rejects with { statusCode, error } (not an Error); inject a
  // fake client so no network/credentials are needed.
  rzp._client = {
    orders: {
      create: () =>
        Promise.reject({ statusCode: 401, error: { code: "BAD_REQUEST_ERROR", description: "Authentication failed" } }),
    },
  };
  await assert.rejects(
    () => rzp.createOrder({ amount: 100, currency: "INR", receipt: "r", notes: {} }),
    (e) => {
      assert.ok(e instanceof Error);
      assert.equal(e.message, "Authentication failed");
      assert.equal(e.code, "BAD_REQUEST_ERROR");
      assert.equal(e.statusCode, 401);
      return true;
    }
  );
});

test("RazorpayGateway.capturePayment treats 'already captured' as success (auto-capture)", async () => {
  const rzp = new RazorpayGateway();
  // payment_capture:1 means Razorpay already captured at pay time; a 2nd capture
  // is rejected. The gateway must read back the payment and report it captured,
  // NOT throw (else the booking never confirms and no notifications are sent).
  let fetchCalled = false;
  rzp._client = {
    payments: {
      capture: () =>
        Promise.reject({
          statusCode: 400,
          error: { code: "BAD_REQUEST_ERROR", description: "This payment has already been captured" },
        }),
      fetch: () => {
        fetchCalled = true;
        return Promise.resolve({ id: "pay_x", status: "captured", amount: 100 });
      },
    },
  };
  const res = await rzp.capturePayment({ paymentId: "pay_x", amount: 100, currency: "INR" });
  assert.equal(res.status, "captured");
  assert.equal(fetchCalled, true);
});

test("RazorpayGateway.capturePayment still throws on a genuine capture failure", async () => {
  const rzp = new RazorpayGateway();
  rzp._client = {
    payments: {
      capture: () =>
        Promise.reject({ statusCode: 400, error: { code: "BAD_REQUEST_ERROR", description: "The amount is invalid" } }),
    },
  };
  await assert.rejects(() => rzp.capturePayment({ paymentId: "pay_y", amount: 100, currency: "INR" }), /amount is invalid/i);
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
