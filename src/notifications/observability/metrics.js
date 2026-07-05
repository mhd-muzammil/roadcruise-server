import { DeliveryStatus, Channels } from "../config/events.js";

/**
 * In-memory metrics counters + a snapshot derived from the repository.
 * Exposed via GET /api/notifications/metrics for dashboards / health checks.
 * Swap for Prometheus by emitting these counters to a registry.
 */
// Per-channel counter shape. `retries` and the latency accumulators are additive
// (previously only sent/failed existed) so per-channel metrics — e.g. the SMS
// sms_retry_total / sms_latency_ms — can be derived without a separate registry.
const channelCounter = () => ({ sent: 0, failed: 0, retries: 0, latencyMsTotal: 0, latencyCount: 0 });

const counters = {
  enqueued: 0,
  processed: 0,
  sent: 0,
  failed: 0,
  deadLettered: 0,
  retries: 0,
  byChannel: Object.fromEntries(Object.values(Channels).map((c) => [c, channelCounter()])),
  totalDeliveryMs: 0,
  deliveredCount: 0,
};

export const metrics = {
  incr(name, by = 1) {
    if (typeof counters[name] === "number") counters[name] += by;
  },
  recordSend(channel, ok, deliveryMs = 0) {
    counters.processed += 1;
    const ch = counters.byChannel[channel];
    // Latency is tracked for BOTH success and failure so per-channel latency
    // reflects real end-to-end provider time, not just the happy path.
    if (deliveryMs && ch) {
      ch.latencyMsTotal += deliveryMs;
      ch.latencyCount += 1;
    }
    if (ok) {
      counters.sent += 1;
      ch && (ch.sent += 1);
      if (deliveryMs) {
        counters.totalDeliveryMs += deliveryMs;
        counters.deliveredCount += 1;
      }
    } else {
      counters.failed += 1;
      ch && (ch.failed += 1);
    }
  },
  /** Record a scheduled retry, globally and per-channel (feeds sms_retry_total). */
  recordRetry(channel) {
    counters.retries += 1;
    const ch = counters.byChannel[channel];
    ch && (ch.retries += 1);
  },

  /** Live snapshot combining counters + repository state. */
  async snapshot(repository) {
    const { items, total } = await repository.query({ limit: 100000, offset: 0 });
    const byStatus = {};
    for (const s of Object.values(DeliveryStatus)) byStatus[s] = 0;
    for (const n of items) byStatus[n.status] = (byStatus[n.status] || 0) + 1;

    const attempted = counters.sent + counters.failed;
    // Per-channel view: exposes sms_sent_total / sms_failed_total /
    // sms_retry_total / sms_latency_ms (and the same for every channel).
    const byChannel = {};
    for (const [ch, c] of Object.entries(counters.byChannel)) {
      byChannel[ch] = {
        sent: c.sent,
        failed: c.failed,
        retries: c.retries,
        avgLatencyMs: c.latencyCount ? Math.round(c.latencyMsTotal / c.latencyCount) : 0,
      };
    }
    return {
      counters: { ...counters },
      byChannel,
      totals: { records: total, byStatus },
      rates: {
        deliveryPct: attempted ? +((counters.sent / attempted) * 100).toFixed(2) : 0,
        failurePct: attempted ? +((counters.failed / attempted) * 100).toFixed(2) : 0,
        avgDeliveryMs: counters.deliveredCount
          ? Math.round(counters.totalDeliveryMs / counters.deliveredCount)
          : 0,
      },
      queueSize:
        (byStatus[DeliveryStatus.QUEUED] || 0) + (byStatus[DeliveryStatus.PROCESSING] || 0),
      generatedAt: new Date().toISOString(),
    };
  },
};

export default metrics;
