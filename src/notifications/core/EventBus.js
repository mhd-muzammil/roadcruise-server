import { EventEmitter } from "events";
import { randomUUID } from "crypto";

/**
 * Domain EventBus — the single seam between business modules and the
 * notification engine. Business code NEVER calls a provider; it only emits a
 * domain event here. Decoupled, so future modules reuse it with zero changes.
 *
 * emit() is fire-and-forget and fully isolated: a listener throwing can never
 * bubble back into the caller (booking creation must never fail because a
 * notification failed). Listeners are invoked on the next tick.
 */
class DomainEventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100);
    // Swallow listener errors so emitters are never impacted.
    this.on("error", (err) => {
      // eslint-disable-next-line no-console
      console.error("[notifications] EventBus listener error:", err?.message || err);
    });
  }

  /**
   * Emit a domain event. Returns the envelope (with generated eventId) so the
   * caller can correlate logs if it wants — but is not required to.
   * @param {string} event  one of NotificationEvents
   * @param {object} payload domain data (booking, payment, user, ...)
   * @param {object} [meta]  { actor, correlationId }
   */
  emitEvent(event, payload = {}, meta = {}) {
    const envelope = {
      eventId: randomUUID(),
      event,
      payload,
      actor: meta.actor || "system",
      correlationId: meta.correlationId || payload?.id || null,
      occurredAt: new Date().toISOString(),
    };
    // defer so the HTTP response returns before any notification work begins
    setImmediate(() => {
      try {
        this.emit(event, envelope);
        this.emit("*", envelope); // wildcard for observers/metrics
      } catch (err) {
        this.emit("error", err);
      }
    });
    return envelope;
  }
}

// Singleton shared across the whole ERP process.
export const eventBus = new DomainEventBus();
export default eventBus;
