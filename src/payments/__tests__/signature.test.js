import { test } from "node:test";
import assert from "node:assert/strict";

import {
  hmacSha256Hex,
  timingSafeEqualHex,
  verifyCheckoutSignature,
  verifyWebhookSignature,
  signCheckout,
  signWebhook,
} from "../core/signature.js";

const SECRET = "test_secret_signature";

test("hmacSha256Hex is deterministic for the same input", () => {
  const a = hmacSha256Hex("hello|world", SECRET);
  const b = hmacSha256Hex("hello|world", SECRET);
  assert.equal(a, b);
  // 64 hex chars for sha256
  assert.match(a, /^[0-9a-f]{64}$/);
});

test("hmacSha256Hex differs for different payload or secret", () => {
  assert.notEqual(hmacSha256Hex("a", SECRET), hmacSha256Hex("b", SECRET));
  assert.notEqual(hmacSha256Hex("a", SECRET), hmacSha256Hex("a", "other_secret"));
});

test("timingSafeEqualHex true for equal strings, false for different", () => {
  const h = hmacSha256Hex("payload", SECRET);
  assert.equal(timingSafeEqualHex(h, h), true);
  assert.equal(timingSafeEqualHex(h, h.replace(/.$/, (c) => (c === "0" ? "1" : "0"))), false);
});

test("timingSafeEqualHex handles unequal lengths without throwing", () => {
  assert.equal(timingSafeEqualHex("abcd", "abcdef"), false);
  assert.equal(timingSafeEqualHex("", "abc"), false);
  assert.equal(timingSafeEqualHex(null, "abc"), false);
  assert.equal(timingSafeEqualHex("abc", undefined), false);
});

test("verifyCheckoutSignature accepts a signCheckout-produced signature", () => {
  const orderId = "order_sig_1";
  const paymentId = "pay_sig_1";
  const signature = signCheckout(orderId, paymentId, SECRET);
  assert.equal(verifyCheckoutSignature({ orderId, paymentId, signature }, SECRET), true);
});

test("verifyCheckoutSignature rejects a tampered signature", () => {
  const orderId = "order_sig_2";
  const paymentId = "pay_sig_2";
  const signature = signCheckout(orderId, paymentId, SECRET);
  const tampered = signature.slice(0, -1) + (signature.endsWith("a") ? "b" : "a");
  assert.equal(verifyCheckoutSignature({ orderId, paymentId, signature: tampered }, SECRET), false);
  // wrong secret also rejected
  assert.equal(verifyCheckoutSignature({ orderId, paymentId, signature }, "wrong_secret"), false);
  // wrong paymentId also rejected
  assert.equal(
    verifyCheckoutSignature({ orderId, paymentId: "pay_other", signature }, SECRET),
    false
  );
});

test("verifyCheckoutSignature rejects when fields missing", () => {
  assert.equal(verifyCheckoutSignature({ orderId: "", paymentId: "p", signature: "s" }, SECRET), false);
  assert.equal(verifyCheckoutSignature({ orderId: "o", paymentId: "p", signature: "s" }, ""), false);
});

test("verifyWebhookSignature accepts a signWebhook-produced signature (string and Buffer)", () => {
  const body = JSON.stringify({ event: "payment.captured", payload: { x: 1 } });
  const sig = signWebhook(body, SECRET);
  assert.equal(verifyWebhookSignature(body, sig, SECRET), true);
  assert.equal(verifyWebhookSignature(Buffer.from(body, "utf8"), sig, SECRET), true);
});

test("verifyWebhookSignature rejects tampered body / signature / secret", () => {
  const body = JSON.stringify({ event: "payment.captured", payload: { x: 1 } });
  const sig = signWebhook(body, SECRET);
  assert.equal(verifyWebhookSignature(body + " ", sig, SECRET), false);
  assert.equal(verifyWebhookSignature(body, sig.slice(0, -1) + "0", SECRET), false);
  assert.equal(verifyWebhookSignature(body, sig, "wrong_secret"), false);
  assert.equal(verifyWebhookSignature("", sig, SECRET), false);
});
