import config from "../config/notification.config.js";
import { DeliveryStatus, Channels } from "../config/events.js";
import { render } from "../templates/engine.js";
import { resolveTemplate } from "../templates/registry.js";
import { getProvider } from "../providers/index.js";
import { buildVars } from "../config/dlt.js";
import { metrics } from "../observability/metrics.js";
import { auditLog } from "../audit/AuditLog.js";

/**
 * Terminal-success statuses a provider may declare for itself. Anything else it
 * returns falls back to SENT, preserving the behaviour of every adapter that
 * predates this (all of which return "sent").
 */
const ACCEPTED_STATUSES = new Set([
  DeliveryStatus.SENT,
  DeliveryStatus.SUBMITTED,
  DeliveryStatus.DELIVERED,
]);

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

      // India/DLT: SMS providers must send the approved Template ID for THIS
      // event plus its variable values in registered order. Computed here (not
      // in the provider) because the Dispatcher is the only place that holds
      // the resolved template def and the rendered context together. Providers
      // that don't need them simply ignore the extra fields.
      const dltVars =
        record.channel === Channels.SMS
          ? buildVars(typeof def === "function" ? def(record.payload)?.text : def.text, record.payload)
          : undefined;

      const result = await provider.send({
        to: record.recipient,
        subject: rendered.subject,
        body: rendered.body,
        event: record.event,
        vars: dltVars,
        // The rendered context itself. MSG91 renders the DLT-approved template
        // on its side from NAMED variables, so it needs the values by name
        // rather than the ordered `vars` array Airtel IQ matches positionally.
        context: record.payload,
        correlationId: record.correlationId || record.id,
        meta: { buttons: def.buttons, mediaUrl: def.mediaUrl, attachments: record.attachments },
      });

      await this.repository.update(record.id, {
        // Honour a provider-declared outcome when it is one the engine models,
        // so a gateway that can only confirm ACCEPTANCE (MSG91) records
        // SUBMITTED rather than overclaiming SENT. Providers that return
        // anything else — every other adapter, all of which return "sent" —
        // keep the previous behaviour exactly.
        status: ACCEPTED_STATUSES.has(result.status) ? result.status : DeliveryStatus.SENT,
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
      // Record failure latency too, so per-channel latency reflects real time.
      metrics.recordSend(record.channel, false, Date.now() - startedAt);
      await this._handleFailure(record, err);
    }
  }

  async _handleFailure(record, err) {
    const attempts = record.attempts + 1;
    const message = err?.message || String(err);
    // Error classification: a provider may mark an error non-retryable (e.g. a
    // 4xx such as bad template / bad credentials, where retrying can never
    // succeed). Default (undefined) is retryable — preserving the existing
    // behavior of every current provider (mock/smtp/meta throw plain errors).
    const retryable = err?.retryable !== false;

    if (retryable && attempts < record.maxAttempts) {
      const delay = this._backoffMs(attempts);
      const nextAttemptAt = new Date(Date.now() + delay).toISOString();
      await this.repository.update(record.id, {
        status: DeliveryStatus.FAILED,
        attempts,
        error: message,
        nextAttemptAt,
      });
      metrics.recordRetry(record.channel);
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

    // Exhausted OR non-retryable (terminal) -> dead-letter + admin alert.
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
      detail: { attempts, error: message, terminal: !retryable },
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
