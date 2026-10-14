// Corporate GST details, coupon codes, closure payment mode and admin invoice
// edits — exercised through the real controllers on a throwaway SQLite DB.
//
// Run: npm run test:bookings   (SQLITE_PATH/DATA_DIR isolated by setup.env.mjs)
import { test } from "node:test";
import assert from "node:assert/strict";

import { closeTrip, editInvoice, getBookingInvoice, cancelBooking } from "../booking.controller.js";
import { createCoupon, patchCoupon, applyCouponPreview, checkCoupon } from "../coupon.controller.js";
import { insertBooking, getBookingById } from "../../utils/db.js";
import { recordRedemption } from "../../db/coupons.db.js";
import { Roles } from "../../auth/rbac/roles.js";
import { applyCoupon, couponDiscount } from "../../services/pricing.js";
import { cleanBilling, gstSplit } from "../../services/billing.js";

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    send(payload) { this.body = payload; return this; },
  };
}

const OWNER = "billing.owner@example.com";
const ownerAuth = { email: OWNER, role: Roles.CUSTOMER };
const adminAuth = { email: "admin@example.com", role: Roles.ADMIN };
const req = (id, auth, body = {}, query = {}) => ({ params: { id }, auth, body, query });

const PRICING = {
  source: "trip",
  lines: [{ key: "distance", label: "Vehicle charges", detail: "130 km × ₹20/km", amount: 2600 }],
  subtotal: 2600, gstRate: 5, gstAmount: 130, total: 2730, billKm: 130, perKm: 20, days: 1,
};
let seq = 0;
const seed = (over = {}) => {
  const id = `TST-BIL-${++seq}`;
  insertBooking({
    id, customerEmail: OWNER, name: "Billing Customer", phone: "9000000000",
    fromDate: "2026-09-01", toDate: "2026-09-01", tripType: "Outstation One-Way", tripKind: "oneway",
    item: "Innova Crysta", vehicle: "Innova Crysta", fare: 2730, pricing: PRICING,
    exclusions: ["Road tolls, parking & interstate permits, if any", "Travel beyond 130 km @ ₹20/km"],
    status: "Approved", paymentMethod: "Pay on arrival", driver: "None", category: "vehicle",
    pickup: "Chennai", drop: "Vellore", createdAt: "2026-08-01T00:00:00.000Z",
    ...over,
  });
  return id;
};

// ---------------------------------------------------------------- GST details
test("GSTIN validation and CGST/SGST vs IGST split", () => {
  assert.equal(cleanBilling(null).billing, null);
  assert.equal(cleanBilling({ companyName: "", gstin: "", address: "" }).billing, null);
  assert.match(cleanBilling({ companyName: "Acme", gstin: "BAD" }).error, /valid 15-character GSTIN/);
  assert.match(cleanBilling({ gstin: "33AALCK3303L1ZL" }).error, /company name/);
  const ok = cleanBilling({ companyName: "Acme Pvt Ltd", gstin: " 33aalck3303l1zl ", address: "Chennai" });
  assert.equal(ok.billing.gstin, "33AALCK3303L1ZL");
  assert.equal(gstSplit("33AALCK3303L1ZL"), "intra"); // Tamil Nadu, same as us
  assert.equal(gstSplit("29AALCK3303L1ZL"), "inter"); // Karnataka
  assert.equal(gstSplit(""), null);
});

test("invoice prints the company, GSTIN and a CGST + SGST split for a Tamil Nadu GSTIN", () => {
  const id = seed({ billing: { companyName: "Acme Travels Pvt Ltd", gstin: "33AALCK3303L1ZL", address: "Anna Salai, Chennai" } });
  const res = mockRes();
  getBookingInvoice(req(id, ownerAuth, {}, { type: "pre" }), res);
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Acme Travels Pvt Ltd/);
  assert.match(res.body, /33AALCK3303L1ZL/);
  assert.match(res.body, /CGST @ 2.5%/);
  assert.match(res.body, /SGST @ 2.5%/);
  assert.doesNotMatch(res.body, /IGST/);
});

test("an out-of-state GSTIN is billed IGST", () => {
  const id = seed({ billing: { companyName: "Blr Co", gstin: "29AALCK3303L1ZL", address: "" } });
  const res = mockRes();
  getBookingInvoice(req(id, ownerAuth, {}, { type: "pre" }), res);
  assert.match(res.body, /IGST @ 5%/);
  assert.doesNotMatch(res.body, /CGST/);
});

// -------------------------------------------------------------------- coupons
test("coupon maths: percent with cap, flat, never more than the subtotal", () => {
  assert.equal(couponDiscount(2600, { type: "percent", value: 10 }), 260);
  assert.equal(couponDiscount(2600, { type: "percent", value: 10, maxDiscount: 200 }), 200);
  assert.equal(couponDiscount(2600, { type: "flat", value: 300 }), 300);
  assert.equal(couponDiscount(200, { type: "flat", value: 300 }), 200);
  const p = applyCoupon(PRICING, { code: "SAVE10", type: "percent", value: 10 });
  assert.equal(p.discount, 260);
  assert.equal(p.subtotal, 2340); // GST is charged on the discounted value
  assert.equal(p.gstAmount, 117);
  assert.equal(p.total, 2457);
});

test("admin creates a coupon; validation rejects bad input and duplicates", () => {
  let res = mockRes();
  createCoupon({ body: { code: "x", type: "percent", value: 10 } }, res);
  assert.equal(res.statusCode, 400);
  res = mockRes();
  createCoupon({ body: { code: "big", type: "percent", value: 150 } }, res);
  assert.equal(res.statusCode, 400);

  res = mockRes();
  createCoupon({ body: { code: "welcome10", type: "percent", value: 10, maxDiscount: 500, minAmount: 1000 } }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.code, "WELCOME10");
  assert.equal(res.body.onePerCustomer, true);

  res = mockRes();
  createCoupon({ body: { code: "WELCOME10", type: "flat", value: 100 } }, res);
  assert.equal(res.statusCode, 409);
});

test("checkout preview applies a valid code and explains why others fail", () => {
  let res = mockRes();
  applyCouponPreview({ auth: ownerAuth, body: { code: "welcome10", amount: 2600 } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.discount, 260);

  res = mockRes();
  applyCouponPreview({ auth: ownerAuth, body: { code: "welcome10", amount: 800 } }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /minimum fare/);

  res = mockRes();
  applyCouponPreview({ auth: ownerAuth, body: { code: "NOPE", amount: 2600 } }, res);
  assert.match(res.body.error, /not valid/);
});

test("expired, inactive and used-up coupons are refused; cancelling gives the use back", () => {
  let res = mockRes();
  createCoupon({ body: { code: "OLD", type: "flat", value: 100, validUntil: "2020-01-01" } }, res);
  assert.match(checkCoupon("OLD", { gross: 2600, email: OWNER }).error, /expired/);

  res = mockRes();
  createCoupon({ body: { code: "ONCE", type: "flat", value: 100 } }, res);
  const once = res.body;
  const id = seed();
  recordRedemption({ couponId: once.id, bookingId: id, email: OWNER, discount: 100 });
  assert.match(checkCoupon("ONCE", { gross: 2600, email: OWNER }).error, /already used/);
  assert.ok(checkCoupon("ONCE", { gross: 2600, email: "someone.else@example.com" }).coupon);

  cancelBooking(req(id, ownerAuth), mockRes());
  assert.ok(checkCoupon("ONCE", { gross: 2600, email: OWNER }).coupon, "cancel releases the redemption");

  patchCoupon({ params: { id: once.id }, body: { active: false } }, mockRes());
  assert.match(checkCoupon("ONCE", { gross: 2600, email: OWNER }).error, /not valid/);
});

test("invoice shows the coupon discount and GST on the discounted value", () => {
  const id = seed({ pricing: applyCoupon(PRICING, { code: "SAVE10", type: "percent", value: 10 }), fare: 2457 });
  const res = mockRes();
  getBookingInvoice(req(id, ownerAuth, {}, { type: "pre" }), res);
  assert.match(res.body, /Coupon discount/);
  assert.match(res.body, /SAVE10/);
  assert.match(res.body, /Taxable value \(after discount\)/);
  assert.match(res.body, /2,457/);
});

// ------------------------------------------------------ closure payment mode
test("trip closure records how the final bill was paid; final invoice prints it", () => {
  const id = seed();
  const res = mockRes();
  closeTrip(req(id, adminAuth, { actualKm: 150, paymentMode: "UPI" }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(getBookingById(id).tripClosure.paymentMode, "UPI");

  const inv = mockRes();
  getBookingInvoice(req(id, ownerAuth, {}, { type: "post" }), inv);
  assert.match(inv.body, /Final bill paid via/);
  assert.match(inv.body, /UPI/);
  // Extra km is charged on the final invoice, so it is no longer "not included".
  assert.doesNotMatch(inv.body, /Travel beyond 130 km/);
  assert.match(inv.body, /Road tolls, parking/);
});

// -------------------------------------------------------- admin invoice edits
test("admin edits invoice number, date and billed-to GSTIN; blank restores the default", () => {
  const id = seed();
  let res = mockRes();
  editInvoice(req(id, adminAuth, { gstin: "not-a-gstin" }), res);
  assert.equal(res.statusCode, 400);

  res = mockRes();
  editInvoice(req(id, adminAuth, {
    invoiceNumber: "RC/2026-27/0042", invoiceDate: "2026-09-02",
    companyName: "Edited Co", gstin: "29aalck3303l1zl", note: "PO #7781",
  }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.invoiceEdits.gstin, "29AALCK3303L1ZL");

  let inv = mockRes();
  getBookingInvoice(req(id, ownerAuth, {}, { type: "pre" }), inv);
  assert.match(inv.body, /RC\/2026-27\/0042/);
  assert.match(inv.body, /02 Sept? 2026/);
  assert.match(inv.body, /Edited Co/);
  assert.match(inv.body, /IGST @ 5%/);
  assert.match(inv.body, /PO #7781/);

  res = mockRes();
  editInvoice(req(id, adminAuth, { invoiceNumber: "" }), res);
  inv = mockRes();
  getBookingInvoice(req(id, ownerAuth, {}, { type: "pre" }), inv);
  assert.match(inv.body, new RegExp(`RC-INV-${id}`));
  assert.match(inv.body, /Edited Co/, "other edits are kept");
});
