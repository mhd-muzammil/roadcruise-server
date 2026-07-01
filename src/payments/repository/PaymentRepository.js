import path from "path";
import { fileURLToPath } from "url";
import { JsonStore } from "../../notifications/repository/store.js";
import { PaymentStatus, TERMINAL_STATES } from "../config/paymentEvents.js";
import { generatePaymentId } from "../core/receiptNumber.js";

/**
 * PaymentRepository — persistence for payments, a transaction ledger, an
 * append-only audit trail, and processed-webhook ids (for idempotency).
 *
 * Reuses the notification module's atomic JsonStore (temp-file + rename, with a
 * serialized per-file write chain) but with its OWN data directory. The whole
 * engine depends only on this contract, so a Postgres adapter can replace it.
 *
 * Payment record shape (mirrors the required STORE spec):
 *   { paymentId, bookingId, customerId, gateway, gatewayOrderId,
 *     gatewayPaymentId, gatewaySignature, receiptNumber, invoiceNumber,
 *     currency, amount, tax, discount, paymentMethod, status, failureReason,
 *     idempotencyKey, refunds[], capturedAt, refundedAt, createdAt, updatedAt }
 */
const __filename = fileURLToPath(import.meta.url);
const PAYMENTS_DATA_DIR = path.resolve(path.dirname(__filename), "../data");

export class PaymentRepository {
  constructor() {
    this.store = new JsonStore(
      "payments.json",
      { payments: [], transactions: [], audit: [], webhooks: [] },
      PAYMENTS_DATA_DIR
    );
  }

  async create(record) {
    const now = new Date().toISOString();
    const row = {
      paymentId: record.paymentId || generatePaymentId(),
      status: PaymentStatus.PENDING,
      currency: "INR",
      tax: 0,
      discount: 0,
      refunds: [],
      failureReason: null,
      capturedAt: null,
      refundedAt: null,
      createdAt: now,
      updatedAt: now,
      ...record,
    };
    await this.store.update((db) => db.payments.push(row));
    return row;
  }

  /** Atomic dedupe-and-insert keyed by idempotencyKey (prevents duplicate orders). */
  async createIfAbsent(record) {
    const now = new Date().toISOString();
    const row = {
      paymentId: record.paymentId || generatePaymentId(),
      status: PaymentStatus.PENDING,
      currency: "INR",
      tax: 0,
      discount: 0,
      refunds: [],
      failureReason: null,
      capturedAt: null,
      refundedAt: null,
      createdAt: now,
      updatedAt: now,
      ...record,
    };
    return this.store.update((db) => {
      if (row.idempotencyKey) {
        const existing = db.payments.find((p) => p.idempotencyKey === row.idempotencyKey);
        if (existing) return { record: existing, created: false };
      }
      db.payments.push(row);
      return { record: row, created: true };
    });
  }

  async update(paymentId, patch) {
    return this.store.update((db) => {
      const idx = db.payments.findIndex((p) => p.paymentId === paymentId);
      if (idx === -1) return null;
      db.payments[idx] = { ...db.payments[idx], ...patch, updatedAt: new Date().toISOString() };
      return db.payments[idx];
    });
  }

  /**
   * Atomic compare-and-set to PAID. Inside a single serialized write:
   *   - already PAID  -> { changed:false }           (idempotent)
   *   - terminal      -> { changed:false, terminal } (never resurrect a failed/refunded/cancelled payment)
   *   - otherwise     -> set PAID + patch, { changed:true }
   * Closes the verify/webhook double-capture race and illegal transitions.
   */
  async transitionToPaid(paymentId, patch = {}) {
    return this.store.update((db) => {
      const idx = db.payments.findIndex((p) => p.paymentId === paymentId);
      if (idx === -1) return { changed: false, record: null };
      const cur = db.payments[idx];
      if (cur.status === PaymentStatus.PAID) return { changed: false, record: cur };
      if (TERMINAL_STATES.has(cur.status)) return { changed: false, terminal: true, record: cur };
      db.payments[idx] = { ...cur, status: PaymentStatus.PAID, ...patch, updatedAt: new Date().toISOString() };
      return { changed: true, record: db.payments[idx] };
    });
  }

  findById(paymentId) {
    return this.store.read().payments.find((p) => p.paymentId === paymentId) || null;
  }
  findByOrderId(orderId) {
    return this.store.read().payments.find((p) => p.gatewayOrderId === orderId) || null;
  }
  findByGatewayPaymentId(gpid) {
    return this.store.read().payments.find((p) => p.gatewayPaymentId === gpid) || null;
  }
  findByBookingId(bookingId) {
    return this.store.read().payments.filter((p) => String(p.bookingId) === String(bookingId));
  }
  findByIdempotencyKey(key) {
    if (!key) return null;
    return this.store.read().payments.find((p) => p.idempotencyKey === key) || null;
  }

  query(q = {}) {
    let rows = this.store.read().payments;
    if (q.status) rows = rows.filter((p) => p.status === q.status);
    if (q.bookingId) rows = rows.filter((p) => String(p.bookingId) === String(q.bookingId));
    if (q.customerId) rows = rows.filter((p) => String(p.customerId) === String(q.customerId));
    if (q.gateway) rows = rows.filter((p) => p.gateway === q.gateway);
    if (q.search) {
      const s = String(q.search).toLowerCase();
      rows = rows.filter(
        (p) =>
          p.paymentId.toLowerCase().includes(s) ||
          String(p.bookingId).toLowerCase().includes(s) ||
          (p.gatewayOrderId && p.gatewayOrderId.toLowerCase().includes(s)) ||
          (p.receiptNumber && p.receiptNumber.toLowerCase().includes(s))
      );
    }
    rows = [...rows].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const total = rows.length;
    const offset = Number(q.offset) || 0;
    const limit = Number(q.limit) || 50;
    return { total, limit, offset, items: rows.slice(offset, offset + limit) };
  }

  /** Append an immutable line to the transaction ledger. */
  async addTransaction(txn) {
    const entry = { ...txn, at: new Date().toISOString() };
    await this.store.update((db) => db.transactions.push(entry));
    return entry;
  }

  async listTransactions(paymentId) {
    return this.store.read().transactions.filter((t) => t.paymentId === paymentId);
  }

  /** Append an audit entry (who/what/when/result). */
  async recordAudit(entry) {
    const row = { at: new Date().toISOString(), actor: "system", ...entry };
    await this.store.update((db) => db.audit.push(row));
    return row;
  }

  async listAudit({ paymentId, limit = 200, offset = 0 } = {}) {
    let rows = this.store.read().audit;
    if (paymentId) rows = rows.filter((a) => a.paymentId === paymentId);
    rows = [...rows].sort((a, b) => (a.at < b.at ? 1 : -1));
    return { total: rows.length, items: rows.slice(offset, offset + limit) };
  }

  /**
   * Atomically mark a webhook event id as processed. Returns true if this is the
   * FIRST time (caller should process), false if already seen (replay/dup -> skip).
   */
  async claimWebhook(eventId) {
    if (!eventId) return true; // nothing to dedupe on; process
    return this.store.update((db) => {
      if (db.webhooks.includes(eventId)) return false;
      db.webhooks.push(eventId);
      return true;
    });
  }

  /** Release a previously-claimed webhook id so a retry can re-process it (used on transient error). */
  async releaseWebhook(eventId) {
    if (!eventId) return;
    await this.store.update((db) => {
      db.webhooks = db.webhooks.filter((w) => w !== eventId);
    });
  }
}

let instance = null;
export function getPaymentRepository() {
  if (!instance) instance = new PaymentRepository();
  return instance;
}

export default getPaymentRepository;
