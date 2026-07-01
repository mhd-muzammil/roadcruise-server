import { createHmac, timingSafeEqual } from "crypto";

/**
 * All signature verification is HMAC-SHA256 with a TIMING-SAFE comparison.
 * Backend NEVER trusts the frontend's "success" — these are the trust anchors.
 */
export function hmacSha256Hex(payload, secret) {
  return createHmac("sha256", String(secret)).update(payload).digest("hex");
}

/** Constant-time hex-string comparison (length-safe). */
export function timingSafeEqualHex(a, b) {
  if (!a || !b) return false;
  const ba = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Razorpay checkout signature: HMAC_SHA256(order_id + "|" + payment_id, KEY_SECRET).
 * @returns {boolean}
 */
export function verifyCheckoutSignature({ orderId, paymentId, signature }, secret) {
  if (!orderId || !paymentId || !signature || !secret) return false;
  const expected = hmacSha256Hex(`${orderId}|${paymentId}`, secret);
  return timingSafeEqualHex(expected, signature);
}

/**
 * Razorpay webhook signature: HMAC_SHA256(rawBody, WEBHOOK_SECRET). The RAW
 * request body MUST be used (not the re-serialized parsed JSON), or the HMAC
 * will not match.
 * @param {Buffer|string} rawBody
 * @returns {boolean}
 */
export function verifyWebhookSignature(rawBody, signature, secret) {
  if (!rawBody || !signature || !secret) return false;
  const payload = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody);
  const expected = hmacSha256Hex(payload, secret);
  return timingSafeEqualHex(expected, signature);
}

/** Produce a checkout signature (used by the MOCK gateway + tests). */
export function signCheckout(orderId, paymentId, secret) {
  return hmacSha256Hex(`${orderId}|${paymentId}`, secret);
}

/** Produce a webhook signature (used by the MOCK gateway + tests). */
export function signWebhook(rawBody, secret) {
  const payload = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody);
  return hmacSha256Hex(payload, secret);
}
