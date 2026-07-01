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

/** Initialize: mount admin routes + start the engine. Call once at startup. */
function init(app) {
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
