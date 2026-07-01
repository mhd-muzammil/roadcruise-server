import { DeliveryStatus, Channels } from "../config/events.js";

/**
 * In-memory metrics counters + a snapshot derived from the repository.
 * Exposed via GET /api/notifications/metrics for dashboards / health checks.
 * Swap for Prometheus by emitting these counters to a registry.
 */
const counters = {
  enqueued: 0,
  processed: 0,
  sent: 0,
  failed: 0,
  deadLettered: 0,
  retries: 0,
  byChannel: Object.fromEntries(
    Object.values(Channels).map((c) => [c, { sent: 0, failed: 0 }])
  ),
  totalDeliveryMs: 0,
  deliveredCount: 0,
};

export const metrics = {
  incr(name, by = 1) {
    if (typeof counters[name] === "number") counters[name] += by;
  },
  recordSend(channel, ok, deliveryMs = 0) {
    counters.processed += 1;
    if (ok) {
      counters.sent += 1;
      counters.byChannel[channel] && (counters.byChannel[channel].sent += 1);
      if (deliveryMs) {
        counters.totalDeliveryMs += deliveryMs;
        counters.deliveredCount += 1;
      }
    } else {
      counters.failed += 1;
      counters.byChannel[channel] && (counters.byChannel[channel].failed += 1);
    }
  },

  /** Live snapshot combining counters + repository state. */
  async snapshot(repository) {
    const { items, total } = await repository.query({ limit: 100000, offset: 0 });
    const byStatus = {};
    for (const s of Object.values(DeliveryStatus)) byStatus[s] = 0;
    for (const n of items) byStatus[n.status] = (byStatus[n.status] || 0) + 1;

    const attempted = counters.sent + counters.failed;
    return {
      counters: { ...counters },
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
