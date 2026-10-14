// Coupon codes data layer. Same local-schema pattern as promos.db.js.
// Admin-created discount codes customers enter at checkout. Each use is
// recorded in coupon_redemptions (one row per booking), which is what usage
// limits and "once per customer" are counted from; cancelling a booking
// releases its redemption.
import { randomUUID } from "crypto";
import { getDb } from "./sqlite.js";

export const COUPON_TYPES = ["percent", "flat"];

function ensure() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS coupons (
      id               TEXT PRIMARY KEY,
      code             TEXT NOT NULL UNIQUE,
      description      TEXT,
      type             TEXT NOT NULL,
      value            REAL NOT NULL,
      max_discount     REAL,
      min_amount       REAL,
      valid_from       TEXT,
      valid_until      TEXT,
      usage_limit      INTEGER,
      one_per_customer INTEGER NOT NULL DEFAULT 1,
      active           INTEGER NOT NULL DEFAULT 1,
      created_at       TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS coupon_redemptions (
      coupon_id      TEXT NOT NULL,
      booking_id     TEXT NOT NULL UNIQUE,
      customer_email TEXT NOT NULL,
      discount       REAL NOT NULL,
      created_at     TEXT NOT NULL
    );
  `);
  return db;
}

const usedCount = (db, id) =>
  db.prepare("SELECT COUNT(*) AS n FROM coupon_redemptions WHERE coupon_id = ?").get(id).n;

const toPublic = (db, row) => ({
  id: row.id,
  code: row.code,
  description: row.description || "",
  type: row.type,
  value: row.value,
  maxDiscount: row.max_discount ?? null,
  minAmount: row.min_amount ?? null,
  validFrom: row.valid_from || "",
  validUntil: row.valid_until || "",
  usageLimit: row.usage_limit ?? null,
  onePerCustomer: row.one_per_customer === 1,
  active: row.active === 1,
  usedCount: usedCount(db, row.id),
  createdAt: row.created_at,
});

export const normalizeCode = (c) => String(c || "").trim().toUpperCase();

export function listCoupons() {
  const db = ensure();
  return db.prepare("SELECT * FROM coupons ORDER BY rowid DESC").all().map((r) => toPublic(db, r));
}

export function getCouponByCode(code) {
  const db = ensure();
  const row = db.prepare("SELECT * FROM coupons WHERE code = ?").get(normalizeCode(code));
  return row ? toPublic(db, row) : null;
}

const COLUMNS = {
  code: "code", description: "description", type: "type", value: "value", maxDiscount: "max_discount",
  minAmount: "min_amount", validFrom: "valid_from", validUntil: "valid_until", usageLimit: "usage_limit",
  onePerCustomer: "one_per_customer", active: "active",
};
const toColumn = (key, v) => (key === "onePerCustomer" || key === "active" ? (v ? 1 : 0) : v);

/** Insert a validated coupon. Throws on a duplicate code. */
export function insertCoupon(c) {
  const db = ensure();
  const id = `cpn-${randomUUID().slice(0, 8)}`;
  const keys = Object.keys(COLUMNS);
  db.prepare(
    `INSERT INTO coupons (id, ${keys.map((k) => COLUMNS[k]).join(", ")}, created_at)
     VALUES (?, ${keys.map(() => "?").join(", ")}, ?)`
  ).run(id, ...keys.map((k) => toColumn(k, c[k] ?? null)), new Date().toISOString());
  return toPublic(db, db.prepare("SELECT * FROM coupons WHERE id = ?").get(id));
}

/** Partial update with validated fields. Returns the coupon or null. */
export function updateCoupon(id, patch) {
  const db = ensure();
  const row = db.prepare("SELECT * FROM coupons WHERE id = ?").get(String(id));
  if (!row) return null;
  const keys = Object.keys(patch).filter((k) => COLUMNS[k]);
  if (keys.length) {
    db.prepare(`UPDATE coupons SET ${keys.map((k) => `${COLUMNS[k]} = ?`).join(", ")} WHERE id = ?`)
      .run(...keys.map((k) => toColumn(k, patch[k] ?? null)), String(id));
  }
  return toPublic(db, db.prepare("SELECT * FROM coupons WHERE id = ?").get(String(id)));
}

export function deleteCoupon(id) {
  const db = ensure();
  const row = db.prepare("SELECT * FROM coupons WHERE id = ?").get(String(id));
  if (!row) return null;
  db.prepare("DELETE FROM coupons WHERE id = ?").run(String(id));
  return toPublic(db, row);
}

export function customerHasRedeemed(couponId, email) {
  const db = ensure();
  return db.prepare(
    "SELECT COUNT(*) AS n FROM coupon_redemptions WHERE coupon_id = ? AND customer_email = ?"
  ).get(couponId, String(email || "").toLowerCase()).n > 0;
}

export function recordRedemption({ couponId, bookingId, email, discount }) {
  const db = ensure();
  db.prepare(
    `INSERT OR REPLACE INTO coupon_redemptions (coupon_id, booking_id, customer_email, discount, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(couponId, bookingId, String(email || "").toLowerCase(), discount, new Date().toISOString());
}

/** A cancelled booking gives its coupon use back. */
export function releaseRedemption(bookingId) {
  const db = ensure();
  db.prepare("DELETE FROM coupon_redemptions WHERE booking_id = ?").run(String(bookingId));
}

export default {
  listCoupons, getCouponByCode, insertCoupon, updateCoupon, deleteCoupon,
  customerHasRedeemed, recordRedemption, releaseRedemption, normalizeCode,
};
