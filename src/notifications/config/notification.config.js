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

  // Branding / template defaults (overridable per-event payload)
  branding: {
    companyName: process.env.COMPANY_NAME || "Road Cruise",
    supportPhone: process.env.SUPPORT_PHONE || "+91 99999 99999",
    supportEmail: process.env.SUPPORT_EMAIL || "support@roadcruise.com",
    websiteUrl: process.env.COMPANY_URL || "https://roadcruise.example",
    logoUrl: process.env.COMPANY_LOGO_URL || "",
  },

  // Admin API protection. In production a token is REQUIRED.
  adminToken: process.env.NOTIF_ADMIN_TOKEN || null,
  isProduction: process.env.NODE_ENV === "production",

  // Dead-letter alerting target (admin email/phone for ops alerts)
  dlqAlert: {
    enabled: bool(process.env.NOTIF_DLQ_ALERT_ENABLED, true),
    email: process.env.NOTIF_DLQ_ALERT_EMAIL || process.env.SUPPORT_EMAIL || null,
  },

  // Provider credentials (read lazily by real adapters; never logged)
  smtp: {
    host: process.env.SMTP_HOST,
    port: int(process.env.SMTP_PORT, 587),
    secure: bool(process.env.SMTP_SECURE, false),
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.SMTP_FROM || process.env.SUPPORT_EMAIL || "no-reply@roadcruise.com",
  },
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
    smsFrom: process.env.TWILIO_SMS_FROM,
    whatsappFrom: process.env.TWILIO_WHATSAPP_FROM,
  },
  metaWhatsApp: {
    phoneNumberId: process.env.META_WHATSAPP_PHONE_NUMBER_ID,
    accessToken: process.env.META_WHATSAPP_ACCESS_TOKEN,
    apiVersion: process.env.META_WHATSAPP_API_VERSION || "v21.0",
  },
};

/** True if a channel is globally enabled (master flag + channel flag). */
export const channelEnabled = (channel) =>
  config.enabled && !!config.channels[channel];

export default config;
