// Real tests for the post-booking flows: admin cab/driver assignment, customer
// stop edits, admin trip closure (extra km) and the pre/post invoice split.
// Exercises the actual controllers against a real (throwaway) SQLite DB — no
// mocks of our own code, only stand-in req/res objects.
//
// Run: npm run test:bookings   (SQLITE_PATH/DATA_DIR isolated by setup.env.mjs)
import { test } from "node:test";
import assert from "node:assert/strict";

import { updateBooking, closeTrip, modifyBooking, getBookingInvoice } from "../booking.controller.js";
import { insertBooking, getBookingById } from "../../utils/db.js";
import { Roles } from "../../auth/rbac/roles.js";
import { quoteTripClosure } from "../../services/pricing.js";

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

const OWNER = "closure.owner@example.com";
const ownerAuth = { email: OWNER, role: Roles.CUSTOMER };
const adminAuth = { email: "admin@example.com", role: Roles.ADMIN };

const req = (id, auth, body = {}, query = {}) => ({ params: { id }, auth, body, query });

let seq = 0;
const seed = (over = {}) => {
  const id = `TST-CLS-${++seq}`;
  insertBooking({
    id,
    customerEmail: OWNER,
    name: "Closure Customer",
    phone: "9000000000",
    fromDate: "2026-09-01",
    toDate: "2026-09-01",
    tripType: "Outstation One-Way",
    tripKind: "oneway",
    item: "Innova Crysta",
    vehicle: "Innova Crysta",
    fare: 2730,
    pricing: {
      source: "trip",
      lines: [{ key: "distance", label: "Vehicle charges", detail: "130 km × ₹20/km", amount: 2600 }],
      subtotal: 2600, gstRate: 5, gstAmount: 130, total: 2730, billKm: 130, perKm: 20, days: 1,
    },
    stops: [{ label: "Kanchipuram", lat: 12.8, lon: 79.7 }],
    status: "Approved",
    paymentMethod: "Pay on arrival",
    driver: "None",
    category: "vehicle",
    pickup: "Chennai",
    drop: "Vellore",
    createdAt: "2026-08-01T00:00:00.000Z",
    ...over,
  });
  return id;
};

test("quoteTripClosure bills only the km beyond what was included, GST on extras, tolls at actuals", () => {
  const c = quoteTripClosure({ includedKm: 130, actualKm: 150, extraKmRate: 20, tolls: 100 });
  assert.equal(c.extraKm, 20);
  assert.equal(c.subtotal, 400);
  assert.equal(c.gstAmount, 20);
  assert.equal(c.total, 520); // 400 + 20 GST + 100 tolls
  const none = quoteTripClosure({ includedKm: 130, actualKm: 120, extraKmRate: 20 });
  assert.equal(none.extraKm, 0);
  assert.equal(none.total, 0);
});

test("admin assigns cab + driver; customer sees it on the booking", () => {
  const id = seed();
  const res = mockRes();
  updateBooking(req(id, adminAuth, {
    assignment: { cabNumber: "tn 01 ab 1234", vehicleType: "Innova Crysta", driverName: "Ramesh", driverPhone: "9876543210", paymentMode: "UPI" },
  }), res);
  assert.equal(res.statusCode, 200);
  const b = getBookingById(id);
  assert.equal(b.assignment.cabNumber, "TN 01 AB 1234");
  assert.equal(b.assignment.driverPhone, "9876543210");
  assert.equal(b.assignment.paymentMode, "UPI");
  assert.equal(b.driver, "Ramesh");
});

test("assignment without a driver name or with a bad phone is rejected", () => {
  const id = seed();
  const r1 = mockRes();
  updateBooking(req(id, adminAuth, { assignment: { cabNumber: "TN01", driverName: "" } }), r1);
  assert.equal(r1.statusCode, 400);
  const r2 = mockRes();
  updateBooking(req(id, adminAuth, { assignment: { cabNumber: "TN01", driverName: "A", driverPhone: "12" } }), r2);
  assert.equal(r2.statusCode, 400);
});

test("customer can edit stops; unchanged stops keep their coordinates", () => {
  const id = seed();
  const res = mockRes();
  modifyBooking(req(id, ownerAuth, { stops: ["Kanchipuram", "Arcot"] }), res);
  assert.equal(res.statusCode, 200);
  const b = getBookingById(id);
  assert.deepEqual(b.stops.map((s) => s.label), ["Kanchipuram", "Arcot"]);
  assert.equal(b.stops[0].lat, 12.8);
  // Fare is never touched by an edit.
  assert.equal(b.fare, 2730);
});

test("stops can't be added to an airport transfer, and are capped", () => {
  const airport = seed({ tripKind: "airport", stops: [] });
  const r1 = mockRes();
  modifyBooking(req(airport, ownerAuth, { stops: ["Somewhere"] }), r1);
  assert.equal(r1.statusCode, 400);

  const id = seed();
  const r2 = mockRes();
  modifyBooking(req(id, ownerAuth, { stops: ["a", "b", "c", "d", "e", "f"] }), r2);
  assert.equal(r2.statusCode, 400);
});

test("closing a trip records extra km and completes it; invoices split pre/post", () => {
  const id = seed();
  const res = mockRes();
  closeTrip(req(id, adminAuth, { actualKm: 160, tolls: 120 }), res);
  assert.equal(res.statusCode, 200);
  const b = getBookingById(id);
  assert.equal(b.status, "Completed");
  assert.equal(b.tripClosure.includedKm, 130); // from pricing.billKm
  assert.equal(b.tripClosure.extraKmRate, 20); // from pricing.perKm
  assert.equal(b.tripClosure.extraKm, 30);
  assert.equal(b.tripClosure.total, 750); // 600 + 30 GST + 120 tolls

  const pre = mockRes();
  getBookingInvoice(req(id, ownerAuth, {}, { type: "pre" }), pre);
  assert.match(pre.body, /PRE-INVOICE/);
  assert.match(pre.body, /2,730/);

  const post = mockRes();
  getBookingInvoice(req(id, ownerAuth), post); // defaults to the final invoice once closed
  assert.match(post.body, /FINAL INVOICE/);
  assert.match(post.body, /3,480/); // 2730 + 750
  assert.match(post.headers["Content-Disposition"], /Final-Invoice/);
});

test("final invoice is unavailable before the trip is closed", () => {
  const id = seed();
  const res = mockRes();
  getBookingInvoice(req(id, ownerAuth, {}, { type: "post" }), res);
  assert.equal(res.statusCode, 409);
});
