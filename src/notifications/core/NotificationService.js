import { eventBus } from "./EventBus.js";
import { idempotencyKey } from "./idempotency.js";
import { validateRecipient } from "./validate.js";
import { getWorkflow } from "../workflows/registry.js";
import { channelEnabled, default as config } from "../config/notification.config.js";
import { DeliveryStatus, ALL_EVENTS } from "../config/events.js";
import { metrics } from "../observability/metrics.js";
import { auditLog } from "../audit/AuditLog.js";

/**
 * NotificationService — the engine front door.
 *
 *   - Subscribes to every domain event on the EventBus.
 *   - For each event: resolves the workflow, fans out to each enabled channel
 *     that has a recipient, dedupes via idempotency key, persists a QUEUED
 *     record, and enqueues it. Returns immediately — never blocks the emitter.
 *   - The Dispatcher (driven by the queue) does the actual send + retry.
 */
export class NotificationService {
  constructor({ repository, queue, dispatcher }) {
    this.repository = repository;
    this.queue = queue;
    this.dispatcher = dispatcher;
  }

  /** Wire the engine to the bus + start the worker. Idempotent. */
  start() {
    if (this._started) return;
    this._started = true;
    if (!config.enabled) {
      console.log("[notifications] engine DISABLED via NOTIF_ENABLED=false");
      return;
    }
    // Recover records orphaned in PROCESSING by a prior crash/restart, so their
    // messages (e.g. a password-reset email) actually get sent instead of being
    // stuck forever. Fire-and-forget; the worker below then picks them up.
    if (typeof this.repository.recoverStale === "function") {
      this.repository
        .recoverStale()
        .then((n) => n && console.log(`[notifications] recovered ${n} stale record(s) from PROCESSING`))
        .catch((e) => console.error("[notifications] stale recovery failed:", e.message));
    }
    this.queue.start((id) => this.dispatcher.process(id));
    for (const event of ALL_EVENTS) {
      eventBus.on(event, (envelope) => this.handleEvent(envelope).catch((e) =>
        console.error(`[notifications] handleEvent error (${event}):`, e.message)
      ));
    }
    console.log(`[notifications] engine started — listening on ${ALL_EVENTS.length} events`);
  }

  /**
   * Process one domain event envelope into per-channel notification records.
   * Also directly callable (e.g. from the admin "resend" action / tests).
   */
  async handleEvent(envelope) {
    const { event, payload, eventId, actor } = envelope;
    const workflow = getWorkflow(event);
    const recipients = workflow.resolveRecipients(payload);
    const context = workflow.buildContext(payload);
    const created = [];

    for (const channel of workflow.channels) {
      if (!channelEnabled(channel)) continue;
      const recipient = recipients[channel];

      // No address for this channel -> record as SKIPPED (auditable), don't fail.
      if (!recipient) {
        await auditLog.record({
          action: "skipped",
          event,
          channel,
          actor,
          result: "no_recipient",
          detail: { eventId },
        });
        continue;
      }

      // Validate/normalize the recipient; skip (auditable) if malformed.
      const valid = validateRecipient(channel, recipient);
      if (!valid.ok) {
        await auditLog.record({
          action: "skipped",
          event,
          channel,
          actor,
          result: `invalid_recipient:${valid.reason}`,
          detail: { eventId },
        });
        continue;
      }
      const address = valid.normalized;

      // Business key from the RAW payload (domain truth), never the template
      // context: defaultContext() fills bookingId with a "—" placeholder for
      // non-booking events, which made the key CONSTANT per (event, recipient)
      // and permanently deduped every later password-reset / verification /
      // OTP email for that user. eventId (unique per emission) is the fallback,
      // so replays of the SAME envelope still dedupe.
      const idk = idempotencyKey({
        event,
        channel,
        recipient: address,
        businessKey: payload.bookingId || payload.id || eventId,
      });

      // Atomic dedupe-and-insert: never send the same thing twice, even under
      // the concurrent worker (closes the check-then-create race).
      const { record, deduped } = await this.repository.createIfAbsent({
        eventId,
        event,
        correlationId: envelope.correlationId,
        customerId: recipients.customerId,
        bookingId: context.bookingId,
        channel,
        provider: config.providers[channel],
        templateKey: event,
        recipient: address,
        idempotencyKey: idk,
        maxAttempts: config.retry.maxAttempts,
        payload: context,
        attachments: payload.attachments || [],
        status: DeliveryStatus.QUEUED,
      });

      if (deduped) {
        await auditLog.record({
          action: "deduped",
          event,
          channel,
          notificationId: record.id,
          actor,
          result: "duplicate",
        });
        continue;
      }

      metrics.incr("enqueued");
      await auditLog.record({
        action: "enqueued",
        event,
        notificationId: record.id,
        channel,
        actor,
        result: "queued",
      });
      await this.queue.enqueue(record.id);
      created.push(record);
    }
    return created;
  }
}

export default NotificationService;
