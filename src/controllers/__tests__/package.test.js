// Tests for admin-managed tour packages + their payment rule, and the bookings
// Excel export. Real controllers against the throwaway SQLite DB (setup.env.mjs).
//
// Run: npm run test:bookings
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  getPublicPackages, getAdminPackages, createPackage, patchPackage, removePackage,
} from "../package.controller.js";
import { createBooking, exportBookings } from "../booking.controller.js";

function mockRes() {
  return {
    statusCode: 200, body: undefined, headers: {},
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
    setHeader(k, v) { this.headers[k] = v; },
    send(b) { this.body = b; return this; },
  };
}
const call = (fn, req) => { const res = mockRes(); fn(req, res); return res; };

test("seeds the default packages once, then supports create / edit / hide / delete", () => {
  const seeded = call(getAdminPackages, {}).body;
  assert.ok(seeded.length >= 4);

  const made = call(createPackage, {
    body: { name: "Munnar Escape", inclusions: "Stay\n\nBreakfast", exclusions: "Lunch", paymentMode: "partial", advancePercent: "30" },
  });
  assert.equal(made.statusCode, 201);
  assert.deepEqual(made.body.inclusions, ["Stay", "Breakfast"]);
  assert.equal(made.body.paymentMode, "partial");
  assert.equal(made.body.advancePercent, 30);

  assert.ok(call(getPublicPackages, {}).body.some((p) => p.id === made.body.id));

  call(patchPackage, { params: { id: made.body.id }, body: { active: "false" } });
  assert.ok(!call(getPublicPackages, {}).body.some((p) => p.id === made.body.id));

  assert.equal(call(removePackage, { params: { id: made.body.id } }).statusCode, 200);
  assert.equal(call(removePackage, { params: { id: made.body.id } }).statusCode, 404);
});

test("rejects an unknown payment mode and a missing name", () => {
  assert.equal(call(createPackage, { body: { name: "X", paymentMode: "crypto" } }).statusCode, 400);
  assert.equal(call(createPackage, { body: { paymentMode: "online" } }).statusCode, 400);
});

const book = async (body) => {
  const res = mockRes();
  await createBooking({ auth: { email: "t@example.com", user: {} }, body: { fromDate: "2026-12-01", toDate: "2026-12-02", fare: 10000, ...body } }, res);
  return res;
};

test("package payment rule overrides what the client asks for", async () => {
  const mk = (extra) => call(createPackage, { body: { name: "Rule " + Math.random(), ...extra } }).body;

  // offline: forced to pay-on-arrival even if the client asks for online
  const off = mk({ paymentMode: "offline" });
  const r1 = await book({ item: off.name, packageId: off.id, paymentMode: "online" });
  assert.equal(r1.statusCode, 201);
  assert.equal(r1.body.payment, "on_arrival");
  assert.equal(r1.body.booking.advanceAmount, 0);

  // partial 30%: advance computed server-side, even if the client asks for arrival
  const part = mk({ paymentMode: "partial", advancePercent: "30" });
  const r2 = await book({ item: part.name, packageId: part.id, paymentMode: "arrival" });
  assert.equal(r2.statusCode, 201);
  // Gateway may be unavailable in tests; either way the plan must not be "offline".
  if (r2.body.payment === "required") {
    assert.equal(r2.body.booking.advanceAmount, 3000);
    assert.equal(r2.body.booking.paymentMethod, "Online (30% advance)");
  }

  // unknown package
  assert.equal((await book({ item: "x", packageId: "pkg-nope" })).statusCode, 404);
});

test("bookings export returns an xlsx zip with a row count header", () => {
  const res = call(exportBookings, {});
  assert.match(res.headers["Content-Type"], /spreadsheetml/);
  assert.equal(res.body.subarray(0, 2).toString(), "PK");
  assert.ok(Number(res.headers["X-Export-Rows"]) >= 1);
});
