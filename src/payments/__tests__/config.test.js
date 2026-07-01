import { test } from "node:test";
import assert from "node:assert/strict";

// The exported `config` object is built at import time from process.env. Since
// the test suite runs with no PAYMENT_PROVIDER set, the default provider is
// "mock". We test validateEnv against that default, then exercise the
// razorpay branch via a fresh, isolated module import with env set/cleared so
// we never pollute the shared singleton config used by the other tests.

test("validateEnv returns ok for the default mock provider", async () => {
  const { validateEnv, config } = await import("../config/payment.config.js");
  assert.equal(config.provider, "mock");
  const res = validateEnv();
  assert.equal(res.ok, true);
  assert.deepEqual(res.errors, []);
});

test("validateEnv reports missing RAZORPAY_KEY_ID/SECRET when provider=razorpay with no env", async () => {
  // Set env then load a FRESH copy of the module (cache-busted query string) so
  // its module-level `config` is computed from this env without touching the
  // already-imported singleton other tests rely on.
  const prevProvider = process.env.PAYMENT_PROVIDER;
  const prevKeyId = process.env.RAZORPAY_KEY_ID;
  const prevKeySecret = process.env.RAZORPAY_KEY_SECRET;
  const prevWebhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const prevWebhookEnabled = process.env.PAYMENT_WEBHOOK_ENABLED;

  process.env.PAYMENT_PROVIDER = "razorpay";
  delete process.env.RAZORPAY_KEY_ID;
  delete process.env.RAZORPAY_KEY_SECRET;
  delete process.env.RAZORPAY_WEBHOOK_SECRET;
  process.env.PAYMENT_WEBHOOK_ENABLED = "true";

  try {
    const mod = await import(`../config/payment.config.js?razorpay=${Date.now()}`);
    const res = mod.validateEnv();
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.includes("RAZORPAY_KEY_ID")), "should list RAZORPAY_KEY_ID");
    assert.ok(res.errors.some((e) => e.includes("RAZORPAY_KEY_SECRET")), "should list RAZORPAY_KEY_SECRET");
    assert.ok(
      res.errors.some((e) => e.includes("RAZORPAY_WEBHOOK_SECRET")),
      "should list RAZORPAY_WEBHOOK_SECRET when webhooks enabled"
    );
  } finally {
    // Restore env exactly as it was so nothing leaks to other test processes/cases.
    const restore = (k, v) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
    restore("PAYMENT_PROVIDER", prevProvider);
    restore("RAZORPAY_KEY_ID", prevKeyId);
    restore("RAZORPAY_KEY_SECRET", prevKeySecret);
    restore("RAZORPAY_WEBHOOK_SECRET", prevWebhookSecret);
    restore("PAYMENT_WEBHOOK_ENABLED", prevWebhookEnabled);
  }
});
