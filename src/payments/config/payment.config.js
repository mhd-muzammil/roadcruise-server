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

  // Provider selection: "mock" (default) | "razorpay" | "phonepe"
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

  // PhonePe credentials + endpoints (read by the PhonePe adapter only; never
  // logged). Uses the salt-based PG API: every request/callback is signed with
  //   X-VERIFY = SHA256(payload + saltKey) + "###" + saltIndex
  // so no SDK and no OAuth token lifecycle is required. The customer is
  // redirected to PhonePe's hosted page; the authoritative capture is the Status
  // API result (state === COMPLETED), confirmed on the S2S callback and/or the
  // browser redirect-return. See docs/CLIENT_SETUP_GUIDE.md for onboarding.
  phonepe: {
    merchantId: process.env.PHONEPE_MERCHANT_ID || null,
    saltKey: process.env.PHONEPE_SALT_KEY || null,
    saltIndex: process.env.PHONEPE_SALT_INDEX || "1",
    // Prod: https://api.phonepe.com/apis/hermes  |  UAT: https://api-preprod.phonepe.com/apis/pg-sandbox
    baseUrl: process.env.PHONEPE_BASE_URL || "https://api.phonepe.com/apis/hermes",
    // Where PhonePe sends the customer's browser back after payment (our return
    // handler then confirms via the Status API). {orderId} is substituted.
    redirectUrl: process.env.PHONEPE_REDIRECT_URL || null,
    // Server-to-server callback URL PhonePe POSTs the signed result to.
    callbackUrl: process.env.PHONEPE_CALLBACK_URL || null,
    // Frontend page the browser is finally sent to after we confirm the status
    // (a "?status=paid|failed|pending" query is appended). If unset, the return
    // endpoint responds with JSON instead of redirecting.
    resultUrl: process.env.PHONEPE_RESULT_URL || null,
    timeoutMs: int(process.env.PHONEPE_TIMEOUT_MS, 15000),
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
export const webhookSecret = () => {
  if (config.provider === "razorpay") return config.razorpay.webhookSecret;
  if (config.provider === "phonepe") return config.phonepe.saltKey;
  return config.mockSecret;
};

/** The active key secret used for checkout signature verification. */
export const keySecret = () => {
  if (config.provider === "razorpay") return config.razorpay.keySecret;
  if (config.provider === "phonepe") return config.phonepe.saltKey;
  return config.mockSecret;
};

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
  if (config.provider === "phonepe") {
    if (!config.phonepe.merchantId) errors.push("PHONEPE_MERCHANT_ID is required");
    if (!config.phonepe.saltKey) errors.push("PHONEPE_SALT_KEY is required");
    // The salt key doubles as the checkout + callback signing secret, so a
    // missing key already fails above; the redirect URL is what returns the
    // customer to us to trigger the authoritative Status check.
    if (!config.phonepe.redirectUrl)
      errors.push("PHONEPE_REDIRECT_URL is required (where PhonePe returns the customer after payment)");
  }
  return { ok: errors.length === 0, errors };
}

export default config;
