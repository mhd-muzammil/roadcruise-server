import { eventBus } from "./core/EventBus.js";
import { getRepository } from "./repository/index.js";
import { createQueue } from "./queue/index.js";
import { Dispatcher } from "./core/Dispatcher.js";
import { NotificationService } from "./core/NotificationService.js";
import { setRuntime } from "./core/runtime.js";
import notificationRoutes from "./api/notification.routes.js";
import { NotificationEvents, Channels } from "./config/events.js";
import config from "./config/notification.config.js";

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
 * Validate the config of the SELECTED providers only, so switching a channel to
 * "mock" always boots. Returns an errors[]. Currently guards the msg91 SMS
 * provider; extend per provider as needed.
 */
export function validateProviderConfig(cfg = config) {
  const errors = [];
  if (cfg.providers[Channels.SMS] === "msg91") {
    if (!isSet(cfg.msg91.authKey)) errors.push("MSG91_API_KEY is required when NOTIF_SMS_PROVIDER=msg91");
    if (!isSet(cfg.msg91.templateId)) errors.push("MSG91_TEMPLATE_ID is required when NOTIF_SMS_PROVIDER=msg91");
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
