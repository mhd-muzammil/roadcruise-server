import config from "../config/notification.config.js";
import { DeliveryStatus } from "../config/events.js";
import { render } from "../templates/engine.js";
import { resolveTemplate } from "../templates/registry.js";
import { getProvider } from "../providers/index.js";
import { metrics } from "../observability/metrics.js";
import { auditLog } from "../audit/AuditLog.js";

/**
 * Dispatcher — processes a single notification record:
 *   render template -> send via provider -> record result.
 * Owns the retry/backoff/dead-letter state machine. Pure with respect to the
 * queue: the queue just hands it a record id.
 */
export class Dispatcher {
  constructor({ repository, queue }) {
    this.repository = repository;
    this.queue = queue;
  }

  _backoffMs(attempt) {
    const { baseBackoffMs, factor, maxBackoffMs, jitterMs } = config.retry;
    const raw = baseBackoffMs * Math.pow(factor, Math.max(0, attempt - 1));
    const jitter = jitterMs ? Math.floor(Math.random() * jitterMs) : 0;
    return Math.min(maxBackoffMs, raw) + jitter;
  }

  /** Entry point invoked by the queue worker. */
  async process(notificationId) {
    const record = await this.repository.findById(notificationId);
    if (!record) return;
    if (![DeliveryStatus.QUEUED, DeliveryStatus.FAILED].includes(record.status)) return;

    await this.repository.update(record.id, { status: DeliveryStatus.PROCESSING });
    const startedAt = Date.now();

    try {
      const { def } = resolveTemplate(record.channel, record.event);
      const rendered = render(def, record.channel, record.payload);
      const provider = getProvider(record.channel);

      const result = await provider.send({
        to: record.recipient,
        subject: rendered.subject,
        body: rendered.body,
        meta: { buttons: def.buttons, mediaUrl: def.mediaUrl, attachments: record.attachments },
      });

      await this.repository.update(record.id, {
        status: DeliveryStatus.SENT,
        provider: provider.name,
        attempts: record.attempts + 1,
        rendered,
        // Persist only a minimal normalized ack — never the raw provider SDK
        // object (it can carry envelope/PII/auth context). See security review.
        providerResponse: { providerMessageId: result.providerMessageId, status: result.status },
        error: null,
        sentAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      });
      metrics.recordSend(record.channel, true, Date.now() - startedAt);
      await auditLog.record({
        action: "sent",
        event: record.event,
        notificationId: record.id,
        channel: record.channel,
        result: "ok",
        detail: { providerMessageId: result.providerMessageId, provider: provider.name },
      });
    } catch (err) {
      await this._handleFailure(record, err);
      metrics.recordSend(record.channel, false);
    }
  }

  async _handleFailure(record, err) {
    const attempts = record.attempts + 1;
    const message = err?.message || String(err);

    if (attempts < record.maxAttempts) {
      const delay = this._backoffMs(attempts);
      const nextAttemptAt = new Date(Date.now() + delay).toISOString();
      await this.repository.update(record.id, {
        status: DeliveryStatus.FAILED,
        attempts,
        error: message,
        nextAttemptAt,
      });
      metrics.incr("retries");
      await auditLog.record({
        action: "retry",
        event: record.event,
        notificationId: record.id,
        channel: record.channel,
        result: "scheduled",
        detail: { attempt: attempts, nextAttemptAt, error: message },
      });
      return;
    }

    // Exhausted -> dead-letter + admin alert.
    await this.repository.update(record.id, {
      status: DeliveryStatus.DEAD_LETTER,
      attempts,
      error: message,
      completedAt: new Date().toISOString(),
    });
    await this.repository.pushDeadLetter({
      notificationId: record.id,
      event: record.event,
      channel: record.channel,
      recipient: record.recipient,
      error: message,
      attempts,
    });
    metrics.incr("deadLettered");
    await auditLog.record({
      action: "dead_letter",
      event: record.event,
      notificationId: record.id,
      channel: record.channel,
      result: "failed",
      detail: { attempts, error: message },
    });
    await this._alertAdmin(record, message);
  }

  async _alertAdmin(record, message) {
    if (!config.dlqAlert.enabled || !config.dlqAlert.email) return;
    try {
      const provider = getProvider("email");
      await provider.send({
        to: config.dlqAlert.email,
        subject: `[ALERT] Notification dead-lettered: ${record.event}`,
        body: `Notification ${record.id} (${record.channel} -> ${record.recipient}) failed permanently after ${record.maxAttempts} attempts.\nLast error: ${message}`,
      });
    } catch (e) {
      console.error("[notifications] failed to send DLQ admin alert:", e.message);
    }
  }
}

export default Dispatcher;
