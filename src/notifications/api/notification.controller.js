import { getRuntime } from "../core/runtime.js";
import { eventBus } from "../core/EventBus.js";
import { auditLog } from "../audit/AuditLog.js";
import { metrics } from "../observability/metrics.js";
import { DeliveryStatus, ALL_EVENTS, NotificationEvents } from "../config/events.js";

// Security-sensitive events that must NOT be triggerable via free-form resend
// (they carry one-time codes / reset links). Only re-send from an existing record.
const SENSITIVE_EVENTS = new Set([
  NotificationEvents.OTP_REQUESTED,
  NotificationEvents.PASSWORD_RESET,
]);

/**
 * Admin/ERP controller for notification operations. All routes are mounted
 * behind adminGuard. Response shapes are intentionally simple JSON envelopes.
 */

// GET /api/notifications  — list + search + paginate
export const list = async (req, res) => {
  const { repository } = getRuntime();
  const result = await repository.query({
    status: req.query.status,
    channel: req.query.channel,
    event: req.query.event,
    customerId: req.query.customerId,
    bookingId: req.query.bookingId,
    search: req.query.search,
    limit: req.query.limit,
    offset: req.query.offset,
  });
  res.json(result);
};

// GET /api/notifications/metrics
export const getMetrics = async (_req, res) => {
  const { repository } = getRuntime();
  res.json(await metrics.snapshot(repository));
};

// GET /api/notifications/dead-letters
export const deadLetters = async (_req, res) => {
  const { repository } = getRuntime();
  res.json({ items: await repository.listDeadLetters() });
};

// GET /api/notifications/audit
export const audit = async (req, res) => {
  res.json(await auditLog.query({ limit: Number(req.query.limit) || 100, offset: Number(req.query.offset) || 0 }));
};

// GET /api/notifications/export  — download full logs
export const exportLogs = async (_req, res) => {
  const { repository } = getRuntime();
  const data = await repository.query({ limit: 1000000, offset: 0 });
  res.setHeader("Content-Disposition", 'attachment; filename="notification-logs.json"');
  res.setHeader("Content-Type", "application/json");
  res.send(JSON.stringify(data.items, null, 2));
};

// GET /api/notifications/:id  — record + its audit trail
export const getOne = async (req, res) => {
  const { repository } = getRuntime();
  const record = await repository.findById(req.params.id);
  if (!record) return res.status(404).json({ error: "Notification not found" });
  const trail = await auditLog.forNotification(record.id);
  res.json({ ...record, auditTrail: trail });
};

// POST /api/notifications/:id/retry  — manually re-queue a failed/dead record
export const retry = async (req, res) => {
  const { repository, queue } = getRuntime();
  const record = await repository.findById(req.params.id);
  if (!record) return res.status(404).json({ error: "Notification not found" });

  // Clamp the extra attempt budget to a small bound (admin-only, but unbounded
  // retries against a live paid provider are a footgun).
  const extra = Math.min(Math.max(Number(req.body?.extraAttempts) || 1, 1), 5);
  const updated = await repository.update(record.id, {
    status: DeliveryStatus.QUEUED,
    nextAttemptAt: new Date().toISOString(),
    maxAttempts: record.attempts + extra + 1,
    error: null,
  });
  await auditLog.record({
    action: "manual_retry",
    event: record.event,
    notificationId: record.id,
    channel: record.channel,
    actor: req.get("x-admin-actor") || "admin",
    result: "requeued",
  });
  await queue.enqueue(record.id);
  res.json(updated);
};

// POST /api/notifications/resend  — re-emit a domain event (fresh notifications)
// body: { event, payload }  OR  { fromNotificationId }
export const resend = async (req, res) => {
  const { repository } = getRuntime();
  let event = req.body?.event;
  let payload = req.body?.payload;
  const fromRecord = !!req.body?.fromNotificationId;

  if (fromRecord) {
    const src = await repository.findById(req.body.fromNotificationId);
    if (!src) return res.status(404).json({ error: "Source notification not found" });
    event = src.event;
    // Re-resolve the recipient server-side from the stored record — never trust
    // a client-supplied recipient on resend. Map back to the channel's field.
    const addrField = src.channel === "email" ? "email" : "phone";
    payload = { ...src.payload, [addrField]: src.recipient };
  }

  if (!event) return res.status(400).json({ error: "event (or fromNotificationId) is required" });
  if (!ALL_EVENTS.includes(event)) {
    return res.status(400).json({ error: `Unknown event: ${event}` });
  }
  // Block free-form triggering of OTP/password-reset (anti-phishing/abuse).
  if (!fromRecord && SENSITIVE_EVENTS.has(event)) {
    return res
      .status(403)
      .json({ error: `Event ${event} cannot be triggered via free-form resend` });
  }

  const envelope = eventBus.emitEvent(event, payload || {}, {
    actor: req.get("x-admin-actor") || "admin",
  });
  res.status(202).json({ accepted: true, eventId: envelope.eventId, event });
};

export default { list, getMetrics, deadLetters, audit, exportLogs, getOne, retry, resend };
