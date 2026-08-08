import { Channels } from "./events.js";

/**
 * Central configuration. EVERYTHING comes from environment variables — no
 * secrets or provider keys are ever hardcoded. Sensible zero-infra defaults so
 * the module boots and runs with no external services configured.
 */
const bool = (v, def = false) =>
  v === undefined ? def : ["1", "true", "yes", "on"].includes(String(v).toLowerCase());

const int = (v, def) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
};

export const config = {
  // Master + per-channel feature flags
  enabled: bool(process.env.NOTIF_ENABLED, true),
  channels: {
    [Channels.EMAIL]: bool(process.env.NOTIF_EMAIL_ENABLED, true),
    [Channels.SMS]: bool(process.env.NOTIF_SMS_ENABLED, true),
    [Channels.WHATSAPP]: bool(process.env.NOTIF_WHATSAPP_ENABLED, true),
  },

  // Provider selection per channel (mock = safe default, no creds needed)
  providers: {
    [Channels.EMAIL]: (process.env.NOTIF_EMAIL_PROVIDER || "mock").toLowerCase(),
    [Channels.SMS]: (process.env.NOTIF_SMS_PROVIDER || "mock").toLowerCase(),
    [Channels.WHATSAPP]: (process.env.NOTIF_WHATSAPP_PROVIDER || "mock").toLowerCase(),
  },

  // Substrate selection. Falsy => zero-infra in-process/JSON defaults.
  redisUrl: process.env.REDIS_URL || null,
  databaseUrl: process.env.DATABASE_URL || null,

  // Retry policy (exponential backoff -> dead-letter)
  retry: {
    maxAttempts: int(process.env.NOTIF_MAX_ATTEMPTS, 3),
    baseBackoffMs: int(process.env.NOTIF_BACKOFF_MS, 2000),
    factor: int(process.env.NOTIF_BACKOFF_FACTOR, 3),
    maxBackoffMs: int(process.env.NOTIF_MAX_BACKOFF_MS, 60000),
    jitterMs: int(process.env.NOTIF_BACKOFF_JITTER_MS, 500),
  },

  // Worker concurrency for the in-process queue
  concurrency: int(process.env.NOTIF_CONCURRENCY, 4),

  // Branding / template defaults (overridable per-event payload).
  // Defaults are RoadCruise's real, client-supplied, NON-SECRET business details
  // (from the client onboarding checklist). Anything here can still be overridden
  // per-environment via the COMPANY_*/SUPPORT_* env vars without a code change.
  branding: {
    companyName: process.env.COMPANY_NAME || "RoadCruise Car Rentals & Tours",
    supportPhone: process.env.SUPPORT_PHONE || "+91 73388 99062",
    supportEmail: process.env.SUPPORT_EMAIL || "info@roadcruise.in",
    websiteUrl: process.env.COMPANY_URL || "https://roadcruise.in",
    logoUrl: process.env.COMPANY_LOGO_URL || "",
  },

  // Admin API protection. In production a token is REQUIRED.
  adminToken: process.env.NOTIF_ADMIN_TOKEN || null,
  isProduction: process.env.NODE_ENV === "production",

  // Admin alert recipient — receives an Email + WhatsApp ping for EVERY booking
  // (paid or unpaid) with the customer's details, so staff can act. Set
  // ADMIN_WHATSAPP to the admin's WhatsApp number in E.164 form (e.g.
  // +919876543210) and ADMIN_EMAIL to the staff inbox. They fall back to
  // SUPPORT_PHONE / SUPPORT_EMAIL respectively. A channel whose address is unset
  // is silently SKIPPED by the engine (never a failure).
  admin: {
    name: process.env.ADMIN_NAME || "Karthik",
    email: process.env.ADMIN_EMAIL || process.env.SUPPORT_EMAIL || null,
    whatsapp: process.env.ADMIN_WHATSAPP || process.env.SUPPORT_PHONE || null,
  },

  // Dead-letter alerting target (admin email/phone for ops alerts)
  dlqAlert: {
    enabled: bool(process.env.NOTIF_DLQ_ALERT_ENABLED, true),
    email: process.env.NOTIF_DLQ_ALERT_EMAIL || process.env.SUPPORT_EMAIL || null,
  },

  // Provider credentials (read lazily by real adapters; never logged)
  //
  // SMTP works with any relay (Brevo, SES, Postmark, Gmail, ...). For Brevo:
  //   SMTP_HOST=smtp-relay.brevo.com  SMTP_PORT=587  SMTP_SECURE=false
  //   SMTP_USER=<login>  SMTP_PASS=<smtp-key>  SMTP_FROM="Road Cruise <no-reply@yourdomain>"
  smtp: {
    host: process.env.SMTP_HOST,
    port: int(process.env.SMTP_PORT, 587),
    secure: bool(process.env.SMTP_SECURE, false), // true => implicit TLS (port 465)
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.SMTP_FROM || process.env.SUPPORT_EMAIL || "no-reply@roadcruise.com",
    // Connection pooling + rate limiting (nodemailer transport tunables)
    pool: bool(process.env.SMTP_POOL, true),
    maxConnections: int(process.env.SMTP_MAX_CONNECTIONS, 5),
    maxMessages: int(process.env.SMTP_MAX_MESSAGES, 100),
    // Outbound cap: messages per rateDelta window (0 => unlimited)
    rateLimit: int(process.env.SMTP_RATE_LIMIT, 0),
    rateDeltaMs: int(process.env.SMTP_RATE_DELTA_MS, 1000),
    // Timeouts (fail fast instead of hanging a worker slot)
    connectionTimeoutMs: int(process.env.SMTP_CONNECTION_TIMEOUT_MS, 10000),
    greetingTimeoutMs: int(process.env.SMTP_GREETING_TIMEOUT_MS, 10000),
    socketTimeoutMs: int(process.env.SMTP_SOCKET_TIMEOUT_MS, 20000),
    // TLS posture: require STARTTLS on non-secure ports; verify the cert chain.
    requireTLS: bool(process.env.SMTP_REQUIRE_TLS, true),
    rejectUnauthorized: bool(process.env.SMTP_TLS_REJECT_UNAUTHORIZED, true),
  },
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
    smsFrom: process.env.TWILIO_SMS_FROM,
    whatsappFrom: process.env.TWILIO_WHATSAPP_FROM,
  },
  // MSG91 (India DLT-compliant SMS). Uses the v5 Flow API. The per-event MSG91
  // template ids and their variable mappings live in config/msg91Templates.js
  // (read lazily from MSG91_*_TEMPLATE_ID / MSG91_*_VARS), because which
  // template a send uses is a per-EVENT decision, not a global credential.
  msg91: {
    authKey: process.env.MSG91_API_KEY,
    // Approved 6-char DLT header (e.g. KVROCR); falls back to DLT_HEADER_ID's
    // sender configured on the MSG91 template itself when unset.
    senderId: process.env.MSG91_SENDER_ID,
    baseUrl: process.env.MSG91_BASE_URL || "https://control.msg91.com",
    // Default country code prepended to bare 10-digit numbers (India = 91).
    defaultCountryCode: process.env.MSG91_DEFAULT_COUNTRY_CODE || "91",
    timeoutMs: int(process.env.MSG91_TIMEOUT_MS, 15000),
  },
  // Airtel IQ (Airtel's own CPaaS). India DLT-compliant: takes the rendered
  // body plus the approved Entity ID + per-event Template ID (see config/dlt.js).
  // Credentials come from the Airtel IQ console, NOT from the DLT portal.
  airtelIq: {
    customerId: process.env.AIRTEL_IQ_CUSTOMER_ID,
    username: process.env.AIRTEL_IQ_USERNAME,
    password: process.env.AIRTEL_IQ_PASSWORD,
    // Approved 6-char DLT Header; falls back to DLT_HEADER_ID at send time.
    senderId: process.env.AIRTEL_IQ_SENDER_ID,
    baseUrl: process.env.AIRTEL_IQ_BASE_URL || "https://iqsms.airtel.in",
    // SERVICE_IMPLICIT = transactional/service messages to your own customers
    // (no DND scrubbing). Use PROMOTIONAL only for marketing blasts.
    messageType: process.env.AIRTEL_IQ_MESSAGE_TYPE || "SERVICE_IMPLICIT",
    defaultCountryCode: process.env.AIRTEL_IQ_DEFAULT_COUNTRY_CODE || "91",
    timeoutMs: int(process.env.AIRTEL_IQ_TIMEOUT_MS, 15000),
  },
  metaWhatsApp: {
    // Mission env names take precedence; META_WHATSAPP_* kept for back-compat.
    phoneNumberId:
      process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.META_WHATSAPP_PHONE_NUMBER_ID,
    accessToken:
      process.env.WHATSAPP_ACCESS_TOKEN || process.env.META_WHATSAPP_ACCESS_TOKEN,
    apiVersion:
      process.env.WHATSAPP_API_VERSION || process.env.META_WHATSAPP_API_VERSION || "v21.0",
    timeoutMs: int(process.env.WHATSAPP_TIMEOUT_MS, 15000),
  },
};

/** True if a channel is globally enabled (master flag + channel flag). */
export const channelEnabled = (channel) =>
  config.enabled && !!config.channels[channel];

export default config;
