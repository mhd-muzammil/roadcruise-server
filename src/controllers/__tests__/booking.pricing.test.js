// Server-authoritative pricing: GST, every trip type's fare rules, multi-stop
// routes, hourly durations, the quote endpoint agreeing with the booking, the
// removed availability block, and that the invoice/notifications render the
// same stored breakdown. Real controllers against the throwaway SQLite DB
// (setup.env.mjs); routing is stubbed so nothing touches the network.
//
// Run: npm run test:bookings
import { test } from "node:test";
import assert from "node:assert/strict";

import { createBooking, quoteTrip, getBookingInvoice } from "../booking.controller.js";
import { createPackage } from "../package.controller.js";
import { getBookingById, insertBooking } from "../../utils/db.js";
import { getVehicle, insertVehicle } from "../../db/vehicles.db.js";
import { setRouteResolver } from "../../services/routing.js";
import { applyGst, quoteVehicleTrip } from "../../services/pricing.js";
import { defaultContext } from "../../notifications/workflows/registry.js";
import { emailTemplates } from "../../notifications/templates/email/index.js";
import { render } from "../../notifications/templates/engine.js";
import { NotificationEvents } from "../../notifications/config/events.js";

// 100 km per leg, so a route through N points is (N-1) × 100 km.
let lastPoints = null;
setRouteResolver(async (pts) => {
  lastPoints = pts;
  return { distanceKm: (pts.length - 1) * 100, durationMin: (pts.length - 1) * 120, estimated: false };
});

function mockRes() {
  return {
    statusCode: 200, body: undefined, headers: {},
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
    setHeader(k, v) { this.headers[k] = v; },
    send(b) { this.body = b; return this; },
  };
}

let seq = 0;
const auth = () => ({ email: `pricing-${++seq}@test.local`, role: "customer", user: { name: "Price Tester", phone: "9222222222" } });
const book = async (body) => {
  const res = mockRes();
  await createBooking({ body: { name: "Price Tester", phone: "9222222222", ...body }, auth: auth() }, res);
  return res;
};

const CHENNAI = { label: "Chennai", lat: 13.0827, lon: 80.2707 };
const TENKASI = { label: "Tenkasi", lat: 8.9604, lon: 77.3152 };
const MADURAI = { label: "Madurai", lat: 9.9252, lon: 78.1198 };
const KANYAKUMARI = { label: "Kanyakumari", lat: 8.0883, lon: 77.5385 };

const sedan = () => getVehicle("sedan"); // ₹14/km, bata ₹500, 4h ₹1250 / 8h ₹2300 / 12h ₹3200

// ---- GST ---------------------------------------------------------------------

test("GST: 5% on the subtotal, rounded to paise", () => {
  assert.deepEqual(applyGst(10000), { subtotal: 10000, gstRate: 5, gstAmount: 500, total: 10500 });
  assert.deepEqual(applyGst(1251), { subtotal: 1251, gstRate: 5, gstAmount: 62.55, total: 1313.55 });
});

// ---- Fare rules per trip type (unchanged business rules, now server-side) ---

test("airport: minimum 30 km", () => {
  const q = quoteVehicleTrip(sedan(), { type: "airport", distanceKm: 19 });
  assert.equal(q.pricing.subtotal, 420);
  assert.equal(q.pricing.total, 441);
  assert.match(q.pricing.lines[0].detail, /30 km × ₹14\/km \(minimum 30 km\)/);
});

test("one-way: local ≤50 km has no bata; outstation has the 130 km floor + bata", () => {
  assert.equal(quoteVehicleTrip(sedan(), { type: "oneway", distanceKm: 40 }).pricing.subtotal, 560);
  assert.equal(quoteVehicleTrip(sedan(), { type: "oneway", distanceKm: 100 }).pricing.subtotal, 130 * 14 + 500);
  const far = quoteVehicleTrip(sedan(), { type: "oneway", distanceKm: 300 });
  assert.equal(far.pricing.subtotal, 300 * 14 + 500);
  assert.equal(far.pricing.gstAmount, 235);
  assert.equal(far.pricing.total, 4935);
  assert.deepEqual(far.pricing.lines.map((l) => l.key), ["distance", "bata"]);
});

test("round-trip: 250 km/day floor and per-day bata shown as ₹X × Y days", () => {
  const q = quoteVehicleTrip(sedan(), { type: "roundtrip", distanceKm: 200, days: 3 });
  // max(2 × 200, 250 × 3) = 750 km
  assert.equal(q.pricing.billKm, 750);
  const bata = q.pricing.lines.find((l) => l.key === "bata");
  assert.equal(bata.amount, 1500);
  assert.equal(bata.detail, "₹500 × 3 days");
  assert.equal(q.pricing.subtotal, 750 * 14 + 1500);
  // Same-day local up-down: both ways at actual km, min 60.
  assert.equal(quoteVehicleTrip(sedan(), { type: "roundtrip", distanceKm: 20, days: 1 }).pricing.subtotal, 60 * 14 + 500);
});

test("hourly: every configured package, duration carried as data", () => {
  for (const [pkg, hours, price] of [["4h40", 4, 1250], ["8h80", 8, 2300], ["12h120", 12, 3200]]) {
    const q = quoteVehicleTrip(sedan(), { type: "hourly", pkg });
    assert.equal(q.rental.hours, hours);
    assert.equal(q.pricing.subtotal, price);
  }
  assert.equal(quoteVehicleTrip(sedan(), { type: "hourly", pkg: "99h" }), null);
});

// ---- Bookings ------------------------------------------------------------------

test("multi-stop trip: routed through every stop, stops persisted in order", async () => {
  const res = await book({
    trip: { type: "oneway", pickup: CHENNAI, stops: [TENKASI, MADURAI], drop: KANYAKUMARI, date: "2026-12-10", time: "06:00" },
    vehicleId: "sedan",
    paymentMode: "arrival",
  });
  assert.equal(res.statusCode, 201);
  assert.equal(lastPoints.length, 4, "pickup + 2 stops + drop");

  const b = getBookingById(res.body.booking.id);
  assert.deepEqual(b.stops.map((s) => s.label), ["Tenkasi", "Madurai"]);
  assert.equal(b.pickup, "Chennai");
  assert.equal(b.drop, "Kanyakumari");
  assert.equal(b.distanceKm, 300);
  assert.equal(b.tripType, "Outstation One-Way");
  assert.equal(b.pricing.subtotal, 300 * 14 + 500);
  assert.equal(b.fare, b.pricing.total);
});

test("stops are rejected on trip types that don't support them", async () => {
  const res = await book({
    trip: { type: "airport", pickup: CHENNAI, stops: [TENKASI], drop: KANYAKUMARI, date: "2026-12-10", time: "06:00" },
    vehicleId: "sedan",
  });
  assert.equal(res.statusCode, 400);
});

test("hourly booking stores the selected duration (12 hrs is not hard-coded away)", async () => {
  const res = await book({
    trip: { type: "hourly", pickup: CHENNAI, pkg: "12h120", date: "2026-12-11", time: "10:00" },
    vehicleId: "sedan",
    paymentMode: "arrival",
  });
  assert.equal(res.statusCode, 201);
  const b = getBookingById(res.body.booking.id);
  assert.deepEqual(b.rental, { key: "12h120", label: "12 hrs 120 kms", hours: 12, kms: 120 });
  assert.equal(b.tripType, "Hourly Rental");
  assert.equal(b.fare, 3360); // 3200 + 160 GST
});

test("the quote endpoint and the booking agree to the paisa; a tampered fare is ignored", async () => {
  const trip = { type: "roundtrip", pickup: CHENNAI, stops: [TENKASI], drop: KANYAKUMARI, date: "2026-12-12", returnDate: "2026-12-14", time: "07:00" };
  const qres = mockRes();
  await quoteTrip({ body: { trip } }, qres);
  assert.equal(qres.statusCode, 200);
  assert.equal(qres.body.days, 3);
  const quoted = qres.body.quotes.find((q) => q.vehicleId === "sedan").pricing;

  const res = await book({ trip, vehicleId: "sedan", fare: 1, paymentMode: "arrival" });
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.body.booking.pricing, quoted);
  assert.equal(res.body.booking.fare, quoted.total);
});

test("a vehicle whose units are all held is still bookable (no availability block)", async () => {
  const v = insertVehicle({ name: "Single Unit Car", outstationRate: 10, driverBata: 0, totalUnits: 1, localPricing: { eightHours: 2000 } });
  insertBooking({
    id: `HOLD-${Date.now()}`, customerEmail: "other@test.local", vehicleId: v.id, status: "Approved",
    fromDate: "2099-01-01", toDate: "2099-01-05", fare: 1000, createdAt: new Date().toISOString(),
  });
  const res = await book({
    trip: { type: "oneway", pickup: CHENNAI, drop: TENKASI, date: "2099-01-02", time: "08:00" },
    vehicleId: v.id,
    paymentMode: "arrival",
  });
  assert.equal(res.statusCode, 201);
});

test("classic form: vehicle priced from its 8h rate, package from its listed price, both + GST", async () => {
  const veh = await book({ fromDate: "2026-12-01", toDate: "2026-12-01", item: "Sedan", category: "vehicle", vehicleId: "sedan", fare: 5, paymentMode: "arrival" });
  assert.equal(veh.body.booking.fare, 2415);

  const res = mockRes();
  createPackage({ body: { name: `GST Package ${Date.now()}`, price: "4,999", paymentMode: "offline" } }, res);
  const pkgRes = await book({ fromDate: "2026-12-01", toDate: "2026-12-03", item: res.body.name, category: "package", packageId: res.body.id, fare: 1 });
  assert.equal(pkgRes.body.booking.pricing.subtotal, 4999);
  assert.equal(pkgRes.body.booking.pricing.gstAmount, 249.95);
  assert.equal(pkgRes.body.booking.fare, 5248.95);
});

test("an unpriced estimate (general enquiry) is never charged online", async () => {
  const res = await book({ fromDate: "2026-12-01", toDate: "2026-12-01", item: "General Query", category: "general", fare: 2500, paymentMode: "online" });
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.payment, "on_arrival");
  assert.equal(res.body.booking.pricing.source, "estimate");
  assert.equal(res.body.booking.paymentMethod, "Pay on arrival");
});

// ---- Rendering: invoice + notifications read the same stored breakdown -------

const invoiceFor = (id, email) => {
  const res = mockRes();
  getBookingInvoice({ params: { id }, auth: { email, role: "admin" } }, res);
  return res.body;
};

test("invoice shows route with stops, duration, subtotal, GST and total", async () => {
  const res = await book({
    trip: { type: "oneway", pickup: CHENNAI, stops: [TENKASI], drop: KANYAKUMARI, date: "2026-12-15", time: "06:00" },
    vehicleId: "sedan",
    paymentMode: "arrival",
  });
  const html = invoiceFor(res.body.booking.id);
  for (const s of ["Chennai", "Stop 1", "Tenkasi", "Kanyakumari", "Subtotal", "GST @ 5%", "₹3,300", "₹165", "₹3,465"]) {
    assert.ok(html.includes(s), `invoice includes ${s}`);
  }

  const hourly = await book({ trip: { type: "hourly", pickup: CHENNAI, pkg: "4h40", date: "2026-12-16", time: "10:00" }, vehicleId: "sedan", paymentMode: "arrival" });
  assert.ok(invoiceFor(hourly.body.booking.id).includes("4 hours · 40 km package"));
});

test("legacy bookings (no pricing/stops/rental) still render without a GST split", () => {
  const id = `LEGACY-${Date.now()}`;
  insertBooking({ id, customerEmail: "old@test.local", name: "Old", fare: 12000, status: "Approved", fromDate: "2026-01-01", toDate: "2026-01-02", pickup: "A", drop: "B", createdAt: "2026-01-01T00:00:00Z" });
  const html = invoiceFor(id);
  assert.ok(html.includes("₹12,000"));
  assert.ok(!html.includes("GST @"));
  const ctx = defaultContext(getBookingById(id));
  assert.equal(ctx.gstAmount, "");
  assert.equal(ctx.totalAmount, "₹12,000");
});

test("booking emails carry stops, duration and the GST breakdown", async () => {
  const res = await book({
    trip: { type: "oneway", pickup: CHENNAI, stops: [TENKASI], drop: KANYAKUMARI, date: "2026-12-17", time: "06:00" },
    vehicleId: "sedan",
    paymentMode: "arrival",
  });
  const ctx = defaultContext(res.body.booking);
  for (const event of [NotificationEvents.BOOKING_CREATED, NotificationEvents.ADMIN_BOOKING_UNPAID]) {
    const { body } = render(emailTemplates[event], "email", ctx);
    for (const s of ["Tenkasi", "Kanyakumari", "GST (5%)", "₹165", "₹3,465", "200 km"]) {
      assert.ok(body.includes(s), `${event} email includes ${s}`);
    }
  }
});

test("an old-bundle trip-planner request (no trip, has distanceKm) is kept as an estimate, never charged online", async () => {
  const res = await book({
    fromDate: "2026-12-20", toDate: "2026-12-20", item: "Sedan", category: "vehicle", vehicleId: "sedan",
    fare: 4700, distanceKm: 300, paymentMode: "online", paymentPlan: "advance",
  });
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.payment, "on_arrival");
  assert.equal(res.body.booking.pricing.source, "estimate");
  assert.equal(res.body.booking.pricing.subtotal, 4700);
  assert.equal(res.body.booking.vehicleId, "sedan");
});

test("booking succeeds even when the notification engine throws", async () => {
  const { eventBus } = await import("../../notifications/index.js");
  const original = eventBus.emitEvent;
  eventBus.emitEvent = () => { throw new Error("provider down"); };
  try {
    const res = await book({ trip: { type: "hourly", pickup: CHENNAI, pkg: "8h80", date: "2026-12-21", time: "09:00" }, vehicleId: "sedan", paymentMode: "arrival" });
    assert.equal(res.statusCode, 201);
    assert.ok(getBookingById(res.body.booking.id), "booking persisted");
  } finally {
    eventBus.emitEvent = original;
  }
});

test("round trip bills up & down: Chennai → Kanyakumari 670 km = 1,340 km, shown explicitly", async () => {
  const { distanceLabel } = await import("../../services/bookingView.js");
  const q = quoteVehicleTrip(sedan(), { type: "roundtrip", distanceKm: 670, days: 2 });
  assert.equal(q.pricing.oneWayKm, 670);
  assert.equal(q.pricing.roundTripKm, 1340);
  assert.equal(q.pricing.billKm, 1340);
  const line = q.pricing.lines.find((l) => l.key === "distance");
  assert.equal(line.label, "Vehicle charges (up & down)");
  assert.equal(line.detail, "670 km up + 670 km down = 1,340 km × ₹14/km");
  assert.equal(line.amount, 1340 * 14);
  assert.equal(q.pricing.subtotal, 1340 * 14 + 500 * 2);
  assert.match(q.included[0], /1,340 km included — 670 km up & 670 km down/);
  assert.equal(distanceLabel({ distanceKm: 670, pricing: q.pricing }), "670 km × 2 (up & down) = 1,340 km");

  // Per-day minimum still applies when it exceeds up & down, and says so.
  const short = quoteVehicleTrip(sedan(), { type: "roundtrip", distanceKm: 200, days: 3 });
  assert.equal(short.pricing.billKm, 750);
  assert.match(short.pricing.lines[0].detail, /200 km up \+ 200 km down = 400 km; minimum 250 km\/day × 3 days = 750 km billed/);
});
