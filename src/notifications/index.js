import { eventBus } from "./core/EventBus.js";
import { getRepository } from "./repository/index.js";
import { createQueue } from "./queue/index.js";
import { Dispatcher } from "./core/Dispatcher.js";
import { NotificationService } from "./core/NotificationService.js";
import { setRuntime } from "./core/runtime.js";
import notificationRoutes from "./api/notification.routes.js";
import { NotificationEvents, Channels } from "./config/events.js";
import config from "./config/notification.config.js";
import { dlt } from "./config/dlt.js";
import { msg91TemplateStatus } from "./config/msg91Templates.js";

/**
 * ============================================================================
 *  ENTERPRISE NOTIFICATION & COMMUNICATION MODULE — public facade
 * ============================================================================
 *
 * Reusable across the ENTIRE ERP. Other modules interact via exactly two seams:
 *
 *   1. EMIT events:   notify(NotificationEvents.PAYMENT_SUCCESSFUL, payload)
 *   2. (admin) HTTP:  GET/POST /api/notifications/*
 *
 * They NEVER import a provider, template, or queue. Add new events/channels/
 * providers without touching any business module.
 *
 * Usage in app bootstrap:
 *   import notifications from "./notifications/index.js";
 *   notifications.init(app);   // mounts /api/notifications + starts the worker
 */
let service = null;

function buildEngine() {
  if (service) return service;
  const repository = getRepository();
  const queue = createQueue({ repository });
  const dispatcher = new Dispatcher({ repository, queue });
  service = new NotificationService({ repository, queue, dispatcher });
  setRuntime({ repository, queue, dispatcher, service });
  return service;
}

/** A value is "unset" if empty or still a «CHANGEME_...» placeholder. */
function isSet(v) {
  return !!v && !String(v).startsWith("«CHANGEME");
}

/**
 * MSG91 templates that must be configured before the provider may be selected.
 * These are the ones MSG91 already reports as "Verified by DLT"; an event whose
 * template is still pending (booking confirmation) is intentionally absent, so
 * a missing id disables that one event instead of blocking the whole service.
 */
const REQUIRED_MSG91_EVENTS = new Set([
  NotificationEvents.OTP_REQUESTED,
  NotificationEvents.TRIP_REMINDER,
]);

/**
 * Validate the config of the SELECTED providers only, so switching a channel to
 * "mock" always boots. Returns an errors[]. Guards the India/DLT SMS providers
 * (msg91, airtel); extend per provider as needed.
 */
export function validateProviderConfig(cfg = config) {
  const errors = [];
  const smsProvider = cfg.providers[Channels.SMS];

  if (smsProvider === "msg91") {
    if (!isSet(cfg.msg91.authKey))
      errors.push("MSG91_API_KEY is required when NOTIF_SMS_PROVIDER=msg91");
    if (!isSet(cfg.msg91.senderId))
      errors.push("MSG91_SENDER_ID (the approved DLT header, e.g. KVROCR) is required when NOTIF_SMS_PROVIDER=msg91");

    // Template ids are per-EVENT. The ones whose MSG91 template is already
    // "Verified by DLT" are REQUIRED — booting without them means every send of
    // that event dead-letters. The rest are optional by design: a template that
    // does not exist in MSG91 yet must not block startup, it must only stop
    // THAT event from sending (see REQUIRED_MSG91_EVENTS).
    for (const t of msg91TemplateStatus()) {
      if (REQUIRED_MSG91_EVENTS.has(t.event) && !isSet(t.templateId))
        errors.push(
          `${t.idEnv} is required when NOTIF_SMS_PROVIDER=msg91 — the MSG91 "${t.msg91Name}" template id for ${t.event}`
        );
    }
  }

  if (smsProvider === "airtel") {
    if (!isSet(cfg.airtelIq.customerId))
      errors.push("AIRTEL_IQ_CUSTOMER_ID is required when NOTIF_SMS_PROVIDER=airtel");
    if (!isSet(cfg.airtelIq.username))
      errors.push("AIRTEL_IQ_USERNAME is required when NOTIF_SMS_PROVIDER=airtel");
    if (!isSet(cfg.airtelIq.password))
      errors.push("AIRTEL_IQ_PASSWORD is required when NOTIF_SMS_PROVIDER=airtel");
    if (!isSet(cfg.airtelIq.senderId) && !isSet(dlt.headerId))
      errors.push("AIRTEL_IQ_SENDER_ID (approved DLT header) is required when NOTIF_SMS_PROVIDER=airtel");
    // Airtel IQ rejects a send whose template id is not registered, so an empty
    // registry means every SMS dead-letters. Fail at boot instead.
    if (!dlt.configured)
      errors.push(
        "no DLT template ids configured (DLT_TID_<EVENT>) — run `npm run dlt:templates` and register the templates before NOTIF_SMS_PROVIDER=airtel"
      );
  }

  // The brand name and support phone are baked into every REGISTERED DLT
  // template as fixed text, so a placeholder here means the approved template
  // literally contains "«CHANGEME…»" and the operator match will fail. Only
  // enforced once DLT is in use, so mock/dev setups still boot untouched.
  if (dlt.configured || smsProvider === "airtel") {
    if (!isSet(cfg.branding.companyName))
      errors.push("COMPANY_NAME must be set before registering DLT templates (it is fixed text inside them)");
    if (!isSet(cfg.branding.supportPhone))
      errors.push("SUPPORT_PHONE must be set before registering DLT templates (it is fixed text inside them)");
  }

  return errors;
}

/** Initialize: validate provider config, mount admin routes + start the engine. */
function init(app) {
  const errors = validateProviderConfig();
  if (errors.length) {
    // FAIL CLOSED in production (mirrors the auth/payment modules); WARN in dev
    // so local work isn't blocked. Only triggers for a selected+misconfigured
    // provider — mock/other selections boot normally.
    if (config.isProduction) {
      throw new Error(`[notifications] refusing to start: ${errors.join("; ")}`);
    }
    errors.forEach((e) => console.warn(`[notifications] ${e}`));
  }

  // Surface, once at boot, which approved templates are still missing an MSG91
  // id. Those events fail safe (nothing unapproved is ever sent) but the reason
  // must be visible in the logs rather than only in a dead-letter record.
  if (config.providers[Channels.SMS] === "msg91") {
    for (const t of msg91TemplateStatus()) {
      if (!t.configured) {
        console.error(
          `[notifications] MSG91 template NOT configured: ${t.idEnv} (${t.msg91Name}, DLT ${t.dltTemplateId}) — ` +
            `SMS for "${t.event}" will fail safe instead of sending.`
        );
      } else if (t.blocked) {
        // Configured but knowingly mis-mapped: louder, because this one looks
        // ready at a glance and is not.
        console.error(
          `[notifications] MSG91 template BLOCKED: ${t.msg91Name} — SMS for "${t.event}" will fail safe. ` +
            `Reason: ${t.blockedReason}`
        );
      }
    }
  }

  const svc = buildEngine();
  if (app) app.use("/api/notifications", notificationRoutes);
  svc.start();
  return svc;
}

/**
 * Emit a domain event into the notification engine. Fire-and-forget; returns
 * the event envelope. This is THE function business modules call.
 */
function notify(event, payload = {}, meta = {}) {
  return eventBus.emitEvent(event, payload, meta);
}

export {
  init,
  notify,
  eventBus,
  NotificationEvents,
  Channels,
  config as notificationConfig,
  buildEngine,
};

export default { init, notify, eventBus, NotificationEvents, Channels };
