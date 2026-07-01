import { randomUUID } from "crypto";
import { JsonStore } from "./store.js";
import { DeliveryStatus } from "../config/events.js";

/**
 * NotificationRepository — persistence contract for notification + audit + DLQ
 * records. The engine depends only on this shape; swapping JSON for Postgres
 * means implementing the same methods and returning it from repository/index.js.
 *
 * Record shape (one row per channel, per recipient):
 * {
 *   id, eventId, event, correlationId,
 *   customerId, bookingId,
 *   channel, provider, templateKey,
 *   recipient,                // resolved address for the channel
 *   status,                   // DeliveryStatus
 *   attempts, maxAttempts,
 *   idempotencyKey,
 *   payload,                  // rendering context (sanitized, no secrets)
 *   rendered,                 // { subject?, body } actually sent
 *   providerResponse,         // raw provider ack/id
 *   error,                    // last error message
 *   nextAttemptAt,
 *   createdAt, updatedAt, sentAt, completedAt
 * }
 */
export class JsonNotificationRepository {
  constructor() {
    this.store = new JsonStore("notifications.json", { notifications: [], deadLetters: [] });
  }

  async create(record) {
    const now = new Date().toISOString();
    const row = {
      id: record.id || `RC-NTF-${randomUUID()}`,
      status: DeliveryStatus.QUEUED,
      attempts: 0,
      providerResponse: null,
      error: null,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
      sentAt: null,
      completedAt: null,
      ...record,
    };
    await this.store.update((db) => {
      db.notifications.push(row);
    });
    return row;
  }

  /**
   * Atomic dedupe-and-insert. Checks idempotencyKey and inserts the record only
   * if absent — all inside a single serialized read-modify-write — closing the
   * TOCTOU race that a separate findByIdempotencyKey + create would leave open
   * under the concurrent worker. Returns { record, deduped }.
   */
  async createIfAbsent(record) {
    const now = new Date().toISOString();
    const row = {
      id: record.id || `RC-NTF-${randomUUID()}`,
      status: DeliveryStatus.QUEUED,
      attempts: 0,
      providerResponse: null,
      error: null,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
      sentAt: null,
      completedAt: null,
      ...record,
    };
    return this.store.update((db) => {
      if (row.idempotencyKey) {
        const existing = db.notifications.find((n) => n.idempotencyKey === row.idempotencyKey);
        if (existing) return { record: existing, deduped: true };
      }
      db.notifications.push(row);
      return { record: row, deduped: false };
    });
  }

  async update(id, patch) {
    return this.store.update((db) => {
      const idx = db.notifications.findIndex((n) => n.id === id);
      if (idx === -1) return null;
      db.notifications[idx] = {
        ...db.notifications[idx],
        ...patch,
        updatedAt: new Date().toISOString(),
      };
      return db.notifications[idx];
    });
  }

  async findById(id) {
    return this.store.read().notifications.find((n) => n.id === id) || null;
  }

  async findByIdempotencyKey(key) {
    if (!key) return null;
    return this.store.read().notifications.find((n) => n.idempotencyKey === key) || null;
  }

  /**
   * Filtered + paginated query for the admin ERP view.
   * @param {object} q { status, channel, event, customerId, bookingId, search, limit, offset }
   */
  async query(q = {}) {
    let rows = this.store.read().notifications;
    const { status, channel, event, customerId, bookingId, search } = q;
    if (status) rows = rows.filter((n) => n.status === status);
    if (channel) rows = rows.filter((n) => n.channel === channel);
    if (event) rows = rows.filter((n) => n.event === event);
    if (customerId) rows = rows.filter((n) => String(n.customerId) === String(customerId));
    if (bookingId) rows = rows.filter((n) => String(n.bookingId) === String(bookingId));
    if (search) {
      const s = String(search).toLowerCase();
      rows = rows.filter(
        (n) =>
          (n.recipient && String(n.recipient).toLowerCase().includes(s)) ||
          (n.id && n.id.toLowerCase().includes(s)) ||
          (n.event && n.event.toLowerCase().includes(s))
      );
    }
    rows = [...rows].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const total = rows.length;
    const offset = Number(q.offset) || 0;
    const limit = Number(q.limit) || 50;
    return { total, limit, offset, items: rows.slice(offset, offset + limit) };
  }

  /** Records currently due for processing (used by the in-process worker). */
  async findDue(now = Date.now()) {
    return this.store
      .read()
      .notifications.filter(
        (n) =>
          (n.status === DeliveryStatus.QUEUED || n.status === DeliveryStatus.FAILED) &&
          new Date(n.nextAttemptAt).getTime() <= now
      );
  }

  async pushDeadLetter(record) {
    await this.store.update((db) => {
      db.deadLetters.push({ ...record, movedAt: new Date().toISOString() });
    });
  }

  async listDeadLetters() {
    return this.store.read().deadLetters;
  }
}

export default JsonNotificationRepository;
