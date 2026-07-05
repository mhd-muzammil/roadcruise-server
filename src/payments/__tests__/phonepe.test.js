import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { config } from "../config/payment.config.js";
import { PhonePeGateway } from "../gateways/PhonePeGateway.js";

// The PhonePe adapter reads config.phonepe lazily at call time, so we populate
// the (unfrozen) config for the suite and restore it after. globalThis.fetch is
// stubbed per-test so no real HTTP is made and the salt key never leaves memory.
const origFetch = globalThis.fetch;
const origPhonePe = { ...config.phonepe };

const SALT = "test-salt-key";
const MID = "MERCHANTUAT";

before(() => {
  Object.assign(config.phonepe, {
    merchantId: MID,
    saltKey: SALT,
    saltIndex: "1",
    baseUrl: "https://phonepe.test/apis",
    redirectUrl: "https://app.test/return?orderId={orderId}",
    callbackUrl: "https://api.test/phonepe/callback",
    resultUrl: null,
    timeoutMs: 60,
  });
});
after(() => {
  globalThis.fetch = origFetch;
  Object.assign(config.phonepe, origPhonePe);
});
beforeEach(() => {
  globalThis.fetch = origFetch;
});

function stubFetch({ status = 200, json = {}, calls } = {}) {
  globalThis.fetch = async (url, opts) => {
    calls?.push({ url, opts });
    return { ok: status >= 200 && status < 300, status, json: async () => json };
  };
}

const xverify = (stringToSign) => `${createHash("sha256").update(stringToSign + SALT).digest("hex")}###1`;

const gw = new PhonePeGateway();

test("gateway name is phonepe", () => {
  assert.equal(gw.name, "phonepe");
});

test("createOrder signs X-VERIFY, posts base64 payload to /pg/v1/pay, returns redirectUrl", async () => {
  const calls = [];
  stubFetch({
    json: {
      success: true,
      code: "PAYMENT_INITIATED",
      data: { instrumentResponse: { redirectInfo: { url: "https://phonepe.test/checkout/abc" } } },
    },
    calls,
  });

  const order = await gw.createOrder({ amount: 942800, currency: "INR", receipt: "RCX123", notes: { bookingId: "RDZ001" } });

  assert.equal(order.orderId, "RCX123");
  assert.equal(order.status, "created");
  assert.equal(order.raw.redirectUrl, "https://phonepe.test/checkout/abc");
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/pg\/v1\/pay$/);

  const body = JSON.parse(calls[0].opts.body);
  const payload = JSON.parse(Buffer.from(body.request, "base64").toString("utf8"));
  assert.equal(payload.merchantId, MID);
  assert.equal(payload.merchantTransactionId, "RCX123");
  assert.equal(payload.amount, 942800);
  assert.equal(payload.redirectUrl, "https://app.test/return?orderId=RCX123");
  assert.equal(payload.paymentInstrument.type, "PAY_PAGE");
  // X-VERIFY = SHA256(base64Payload + apiPath + saltKey) + ###index
  assert.equal(calls[0].opts.headers["X-VERIFY"], xverify(body.request + "/pg/v1/pay"));
});

test("createOrder throws when PhonePe rejects the init", async () => {
  stubFetch({ json: { success: false, code: "BAD_REQUEST", message: "nope" } });
  await assert.rejects(() => gw.createOrder({ amount: 100, currency: "INR", receipt: "RCX9", notes: {} }), /rejected/);
});

test("verifyPayment throws (PhonePe uses the Status API, not a browser signature)", () => {
  assert.throws(() => gw.verifyPayment({ orderId: "x", paymentId: "y", signature: "z" }), /Status API/);
});

test("fetchPayment calls the status endpoint with X-VERIFY + X-MERCHANT-ID", async () => {
  const calls = [];
  stubFetch({
    json: { success: true, code: "PAYMENT_SUCCESS", data: { merchantTransactionId: "RCX123", state: "COMPLETED", transactionId: "T1", amount: 942800 } },
    calls,
  });

  const data = await gw.fetchPayment("RCX123");
  assert.equal(data.data.state, "COMPLETED");
  assert.match(calls[0].url, /\/pg\/v1\/status\/MERCHANTUAT\/RCX123$/);
  assert.equal(calls[0].opts.headers["X-MERCHANT-ID"], MID);
  assert.equal(calls[0].opts.headers["X-VERIFY"], xverify("/pg/v1/status/MERCHANTUAT/RCX123"));
});

test("parseStatus maps COMPLETED->paid, FAILED->failed, PENDING->pending", () => {
  const paid = gw.parseStatus({ success: true, code: "PAYMENT_SUCCESS", data: { state: "COMPLETED", transactionId: "T1", amount: 100 } });
  assert.equal(paid.paid, true);
  assert.equal(paid.providerReferenceId, "T1");

  const failed = gw.parseStatus({ success: true, code: "PAYMENT_ERROR", data: { state: "FAILED" } });
  assert.equal(failed.failed, true);
  assert.equal(failed.paid, false);

  const pending = gw.parseStatus({ success: true, code: "PAYMENT_PENDING", data: { state: "PENDING" } });
  assert.equal(pending.pending, true);
});

test("refund posts to /pg/v1/refund and reports processed on success", async () => {
  const calls = [];
  stubFetch({ json: { success: true, code: "PAYMENT_SUCCESS", data: { state: "COMPLETED" } }, calls });

  const res = await gw.refund({ paymentId: "RCX123", amount: 5000, notes: "customer request" });
  assert.equal(res.status, "processed");
  assert.equal(res.amount, 5000);
  assert.match(calls[0].url, /\/pg\/v1\/refund$/);

  const payload = JSON.parse(Buffer.from(JSON.parse(calls[0].opts.body).request, "base64").toString("utf8"));
  assert.equal(payload.originalTransactionId, "RCX123");
  assert.equal(payload.amount, 5000);
});

test("verifyWebhook accepts a correctly signed callback and rejects tampering", () => {
  const resultJson = { success: true, code: "PAYMENT_SUCCESS", data: { merchantTransactionId: "RCX123", state: "COMPLETED" } };
  const responseB64 = Buffer.from(JSON.stringify(resultJson), "utf8").toString("base64");
  const rawBody = JSON.stringify({ response: responseB64 });
  const sig = xverify(responseB64); // PhonePe signs the base64 response body only

  assert.equal(gw.verifyWebhook(rawBody, sig), true);
  assert.equal(gw.verifyWebhook(rawBody, sig + "0"), false); // tampered signature
  const tampered = JSON.stringify({ response: responseB64.slice(0, -2) + "AA" });
  assert.equal(gw.verifyWebhook(tampered, sig), false); // tampered body
  assert.equal(gw.verifyWebhook("not json", sig), false);
});

test("decodeCallback returns the decoded PhonePe result JSON", () => {
  const resultJson = { success: true, code: "PAYMENT_SUCCESS", data: { merchantTransactionId: "RCX123", state: "COMPLETED" } };
  const responseB64 = Buffer.from(JSON.stringify(resultJson), "utf8").toString("base64");
  const decoded = gw.decodeCallback(JSON.stringify({ response: responseB64 }));
  assert.equal(decoded.data.merchantTransactionId, "RCX123");
  assert.equal(decoded.data.state, "COMPLETED");
});

test("network error is classified retryable", async () => {
  globalThis.fetch = async () => { throw new Error("ECONNRESET"); };
  await assert.rejects(
    () => gw.fetchPayment("RCX123"),
    (err) => { assert.equal(err.retryable, true); return true; }
  );
});
