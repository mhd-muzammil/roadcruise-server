// Tests for the trip-planner booking extras: the 20%-advance payment plan and
// the persisted route (distanceKm/durationMin). Exercises the REAL controller +
// payment service against the throwaway SQLite DB and the mock gateway
// (PAYMENT_PROVIDER=mock via setup.env.mjs; payments enabled default).
//
// Run: npm run test:bookings
import { test } from "node:test";
import assert from "node:assert/strict";

import { createBooking } from "../booking.controller.js";
import { getBookingById } from "../../utils/db.js";
import { setRouteResolver } from "../../services/routing.js";

// Every trip in this file routes 19 km / 26 min — no network.
setRouteResolver(async () => ({ distanceKm: 19, durationMin: 26, estimated: false }));

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

let seq = 0;
const reqFor = (body) => ({
  body,
  auth: { email: `advance-${++seq}@test.local`, role: "customer", user: { name: "Adv Tester", phone: "9111111111" } },
});

// A trip-planner airport transfer in the seeded Sedan (₹14/km): 19 km bills
// the 30 km minimum = ₹420, + 5% GST ₹21 = ₹441 total. The client `fare` is
// deliberately wrong — the server prices the trip itself.
const baseBody = (over = {}) => ({
  name: "Adv Tester",
  phone: "9111111111",
  trip: {
    type: "airport",
    pickup: { label: "Vandalur Zoo, Chennai", lat: 12.8792, lon: 80.0819 },
    drop: { label: "Chennai International Airport", lat: 12.9941, lon: 80.1709 },
    date: "2026-09-01",
    time: "09:30",
  },
  vehicleId: "sedan",
  fare: 684,
  paymentMode: "online",
  ...over,
});

test("advance plan: server computes a 20% deposit and charges ONLY the deposit", async () => {
  const res = mockRes();
  await createBooking(reqFor(baseBody({ paymentPlan: "advance", distanceKm: 999, durationMin: 999 })), res);

  assert.equal(res.statusCode, 201);
  const { booking, payment, checkout } = res.body;
  assert.equal(payment, "required");

  // Deposit computed server-side on the GST-inclusive total: round(441 * 0.2) = 88.
  assert.equal(booking.paymentPlan, "advance");
  assert.equal(booking.fare, 441);
  assert.equal(booking.advanceAmount, 88);

  // The gateway order is for the DEPOSIT, in minor units.
  assert.equal(checkout.amount, 88 * 100);

  // The server-computed route is persisted, never the client's numbers.
  const stored = getBookingById(booking.id);
  assert.equal(stored.distanceKm, 19);
  assert.equal(stored.durationMin, 26);
  assert.equal(stored.paymentMethod, "Online (20% advance)");
});

test("full plan (default): no deposit, the order charges the full fare", async () => {
  const res = mockRes();
  await createBooking(reqFor(baseBody()), res);

  assert.equal(res.statusCode, 201);
  const { booking, checkout } = res.body;
  assert.equal(booking.paymentPlan, "full");
  assert.equal(booking.advanceAmount, 0);
  assert.equal(checkout.amount, 441 * 100);
});

test("pay-on-arrival ignores an advance plan — nothing is charged online", async () => {
  const res = mockRes();
  await createBooking(reqFor(baseBody({ paymentMode: "arrival", paymentPlan: "advance" })), res);

  assert.equal(res.statusCode, 201);
  const { booking, payment } = res.body;
  assert.equal(payment, "on_arrival");
  assert.equal(booking.paymentPlan, "full");
  assert.equal(booking.advanceAmount, 0);
  assert.equal(booking.status, "Pending");
});

test("a tampered advance amount in the request body is ignored", async () => {
  const res = mockRes();
  // advanceAmount is NOT an accepted field — only paymentPlan is; the server
  // recomputes the deposit from its own fare.
  await createBooking(reqFor(baseBody({ paymentPlan: "advance", advanceAmount: 1 })), res);

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.booking.advanceAmount, 88);
  assert.equal(res.body.checkout.amount, 88 * 100);
});

test("classic-form junk distance/duration values are stored as null, not NaN", async () => {
  const res = mockRes();
  await createBooking(reqFor({
    fromDate: "2026-09-01", toDate: "2026-09-01", item: "General Query", category: "general",
    fare: 2500, paymentMode: "arrival", distanceKm: "abc", durationMin: -5,
  }), res);

  assert.equal(res.statusCode, 201);
  const stored = getBookingById(res.body.booking.id);
  assert.equal(stored.distanceKm, null);
  assert.equal(stored.durationMin, null);
});
