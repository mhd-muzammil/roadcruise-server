import {
  listCoupons, getCouponByCode, insertCoupon, updateCoupon, deleteCoupon,
  customerHasRedeemed, normalizeCode, COUPON_TYPES,
} from "../db/coupons.db.js";
import { couponDiscount } from "../services/pricing.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Validity dates are calendar days in India.
const todayIST = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
const inr = (n) => `₹${Number(n || 0).toLocaleString("en-IN")}`;

/**
 * Can `email` use this coupon on a booking whose pre-GST subtotal is `gross`?
 * Returns { coupon, discount } or { error }. Used for the checkout preview AND
 * again by createBooking, so a coupon is always re-checked on the server.
 */
export function checkCoupon(code, { gross, email }) {
  const clean = normalizeCode(code);
  if (!clean) return { error: "Enter a coupon code" };
  const coupon = getCouponByCode(clean);
  if (!coupon || !coupon.active) return { error: "This coupon code is not valid" };
  const today = todayIST();
  if (coupon.validFrom && today < coupon.validFrom) return { error: "This coupon is not active yet" };
  if (coupon.validUntil && today > coupon.validUntil) return { error: "This coupon has expired" };
  if (coupon.usageLimit && coupon.usedCount >= coupon.usageLimit) {
    return { error: "This coupon has reached its usage limit" };
  }
  if (coupon.onePerCustomer && email && customerHasRedeemed(coupon.id, email)) {
    return { error: "You have already used this coupon" };
  }
  if (coupon.minAmount && Number(gross) < coupon.minAmount) {
    return { error: `This coupon needs a minimum fare of ${inr(coupon.minAmount)} (before GST)` };
  }
  const discount = couponDiscount(gross, coupon);
  if (discount <= 0) return { error: "This coupon gives no discount on this booking" };
  return { coupon, discount };
}

/** Validate an admin coupon form. Returns { coupon } or { error }. */
function cleanCoupon(body, { partial = false } = {}) {
  const out = {};
  const has = (k) => body[k] !== undefined;
  const num = (v) => (v === "" || v === null || v === undefined ? null : Number(v));

  if (!partial || has("code")) {
    out.code = normalizeCode(body.code);
    if (!/^[A-Z0-9_-]{3,20}$/.test(out.code)) {
      return { error: "Code must be 3–20 letters/numbers (e.g. WELCOME10)" };
    }
  }
  if (!partial || has("type")) {
    out.type = String(body.type || "");
    if (!COUPON_TYPES.includes(out.type)) return { error: "Choose percent (%) or flat (₹) discount" };
  }
  if (!partial || has("value")) {
    out.value = num(body.value);
    if (!(out.value > 0)) return { error: "Enter the discount value" };
  }
  if ((out.type || body.type) === "percent" && out.value > 100) return { error: "A percentage can't exceed 100" };
  for (const k of ["maxDiscount", "minAmount", "usageLimit"]) {
    if (!partial || has(k)) {
      out[k] = num(body[k]);
      if (out[k] !== null && !(out[k] >= 0)) return { error: "Limits must be positive numbers" };
      if (out[k] === 0) out[k] = null;
    }
  }
  if (out.usageLimit) out.usageLimit = Math.round(out.usageLimit);
  for (const k of ["validFrom", "validUntil"]) {
    if (!partial || has(k)) {
      out[k] = String(body[k] || "");
      if (out[k] && !DATE_RE.test(out[k])) return { error: "Dates must be valid dates" };
    }
  }
  if (out.validFrom && out.validUntil && out.validUntil < out.validFrom) {
    return { error: "The end date can't be before the start date" };
  }
  if (!partial || has("description")) out.description = String(body.description || "").trim().slice(0, 140);
  if (!partial || has("onePerCustomer")) out.onePerCustomer = body.onePerCustomer !== false;
  if (!partial || has("active")) out.active = body.active !== false;
  return { coupon: out };
}

// GET /api/coupons (admin)
export const getCoupons = (_req, res) => res.json(listCoupons());

// POST /api/coupons (admin)
export const createCoupon = (req, res) => {
  const { coupon, error } = cleanCoupon(req.body || {});
  if (error) return res.status(400).json({ error });
  if (getCouponByCode(coupon.code)) return res.status(409).json({ error: `Coupon ${coupon.code} already exists` });
  res.status(201).json(insertCoupon(coupon));
};

// PATCH /api/coupons/:id (admin)
export const patchCoupon = (req, res) => {
  const { coupon, error } = cleanCoupon(req.body || {}, { partial: true });
  if (error) return res.status(400).json({ error });
  if (coupon.code) {
    const clash = getCouponByCode(coupon.code);
    if (clash && clash.id !== req.params.id) return res.status(409).json({ error: `Coupon ${coupon.code} already exists` });
  }
  const updated = updateCoupon(req.params.id, coupon);
  if (!updated) return res.status(404).json({ error: "Coupon not found" });
  res.json(updated);
};

// DELETE /api/coupons/:id (admin)
export const removeCoupon = (req, res) => {
  const removed = deleteCoupon(req.params.id);
  if (!removed) return res.status(404).json({ error: "Coupon not found" });
  res.json({ ok: true, id: removed.id });
};

/**
 * POST /api/coupons/apply (signed in) { code, amount }
 * Checkout preview: the discount this code gives on a pre-GST subtotal. The
 * booking itself re-checks the code against the server's own price.
 */
export const applyCouponPreview = (req, res) => {
  const { code, amount } = req.body || {};
  const gross = Number(amount);
  if (!(gross > 0)) return res.status(400).json({ error: "Missing booking amount" });
  const { coupon, discount, error } = checkCoupon(code, { gross, email: req.auth.email });
  if (error) return res.status(400).json({ error });
  res.json({ code: coupon.code, type: coupon.type, value: coupon.value, description: coupon.description, discount });
};
