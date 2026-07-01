import { randomUUID } from "crypto";
import { JsonStore } from "../repository/store.js";

/**
 * Immutable, append-only audit trail. Every notification action is recorded:
 * who triggered it, what event, when, the delivery result, and retry history.
 * Append-only by design — entries are never updated or deleted.
 */
class AuditLog {
  constructor() {
    this.store = new JsonStore("audit.json", { entries: [] });
  }

  /**
   * @param {object} e { action, actor, event, notificationId, channel,
   *                      result, detail }
   */
  async record(e) {
    const entry = {
      auditId: `RC-AUD-${randomUUID()}`,
      at: new Date().toISOString(),
      actor: e.actor || "system",
      action: e.action, // e.g. "enqueued", "sent", "failed", "retry", "dead_letter", "resend", "manual_retry"
      event: e.event || null,
      notificationId: e.notificationId || null,
      channel: e.channel || null,
      result: e.result || null,
      detail: e.detail || null,
    };
    await this.store.update((db) => db.entries.push(entry));
    return entry;
  }

  async forNotification(notificationId) {
    return this.store.read().entries.filter((x) => x.notificationId === notificationId);
  }

  async query({ limit = 100, offset = 0 } = {}) {
    const all = [...this.store.read().entries].sort((a, b) => (a.at < b.at ? 1 : -1));
    return { total: all.length, items: all.slice(offset, offset + limit) };
  }
}

export const auditLog = new AuditLog();
export default auditLog;
