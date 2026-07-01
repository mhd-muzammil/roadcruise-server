/**
 * Payment module configuration. Everything from environment variables — no
 * secrets in source. Zero-infra defaults: the MOCK gateway is active so the
 * full flow runs with no Razorpay account. Set RAZORPAY_* + PAYMENT_PROVIDER=
 * razorpay to go live.
 */
const bool = (v, def = false) =>
  v === undefined ? def : ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
const int = (v, def) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
};

export const config = {
  // Feature flags
  enabled: bool(process.env.PAYMENTS_ENABLED, true),
  webhookEnabled: bool(process.env.PAYMENT_WEBHOOK_ENABLED, true),

  // Provider selection: "mock" (default) | "razorpay"
  provider: (process.env.PAYMENT_PROVIDER || "mock").toLowerCase(),

  currency: process.env.PAYMENT_CURRENCY || "INR",
  // Tax/discount defaults (paise-safe percentages applied in receipts)
  taxPercent: int(process.env.PAYMENT_TAX_PERCENT, 0),

  // Order/payment expiry window (minutes) for the PENDING -> EXPIRED sweep.
  orderExpiryMinutes: int(process.env.PAYMENT_ORDER_EXPIRY_MIN, 30),

  // Razorpay credentials (read by the real adapter only; never logged).
  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID || null,
    keySecret: process.env.RAZORPAY_KEY_SECRET || null,
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || null,
  },

  // Mock gateway secret — used to produce/verify deterministic signatures so the
  // end-to-end flow (and tests) work without a real account.
  mockSecret: process.env.PAYMENT_MOCK_SECRET || "mock_secret_key",

  // Admin API protection (reuses the notification module's guard semantics).
  adminToken: process.env.NOTIF_ADMIN_TOKEN || process.env.PAYMENT_ADMIN_TOKEN || null,
  isProduction: process.env.NODE_ENV === "production",

  // Retry policy for transient gateway errors.
  retry: {
    maxAttempts: int(process.env.PAYMENT_MAX_ATTEMPTS, 3),
    baseBackoffMs: int(process.env.PAYMENT_BACKOFF_MS, 1000),
  },
};

/** The active webhook secret depends on provider (real vs mock). */
export const webhookSecret = () =>
  config.provider === "razorpay" ? config.razorpay.webhookSecret : config.mockSecret;

/** The active key secret used for checkout signature verification. */
export const keySecret = () =>
  config.provider === "razorpay" ? config.razorpay.keySecret : config.mockSecret;

/**
 * Validate environment for the selected provider. Returns {ok, errors}. Called
 * at init so misconfiguration fails loud (but never crashes the host app).
 */
export function validateEnv() {
  const errors = [];
  // The mock gateway uses a publicly-known signing secret — forbid it in prod
  // (otherwise signatures are forgeable and bookings confirm for free).
  if (config.provider === "mock" && config.isProduction) {
    errors.push("PAYMENT_PROVIDER=mock is not permitted in production — set PAYMENT_PROVIDER=razorpay");
  }
  if (config.provider === "razorpay") {
    if (!config.razorpay.keyId) errors.push("RAZORPAY_KEY_ID is required");
    if (!config.razorpay.keySecret) errors.push("RAZORPAY_KEY_SECRET is required");
    if (config.webhookEnabled && !config.razorpay.webhookSecret)
      errors.push("RAZORPAY_WEBHOOK_SECRET is required when PAYMENT_WEBHOOK_ENABLED=true");
  }
  return { ok: errors.length === 0, errors };
}

export default config;
