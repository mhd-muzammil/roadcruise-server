// Real tests for the booking-cancellation feature (customer + admin).
// Exercises the actual controller against a real (throwaway) SQLite DB and the
// real notification EventBus. No mocks of our own code — only stand-in req/res
// objects, exactly what Express would hand the controller.
//
// Run: npm run test:bookings   (SQLITE_PATH/DATA_DIR isolated by setup.env.mjs)
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { cancelBooking } from "../booking.controller.js";
import { insertBooking, getBookingById } from "../../utils/db.js";
import { insertVehicle } from "../../db/vehicles.db.js";
import { isVehicleAvailable } from "../../services/availability.js";
import { Roles } from "../../auth/rbac/roles.js";

import { eventBus } from "../../notifications/core/EventBus.js";
import { NotificationEvents, Channels } from "../../notifications/config/events.js";
import { emailTemplates } from "../../notifications/templates/email/index.js";
import { render } from "../../notifications/templates/engine.js";
import { defaultContext } from "../../notifications/workflows/registry.js";

// ---- tiny test doubles -------------------------------------------------------

/** Minimal stand-in for an Express response; records status + JSON body. */
function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

const reqFor = (id, auth) => ({ params: { id }, auth });

/** Let the EventBus's setImmediate-deferred emit run, then resolve. */
const flush = () => new Promise((r) => setImmediate(() => setImmediate(r)));

/**
 * Capture the customer-facing BOOKING_CANCELLED events emitted while `fn` runs.
 * Returns the list of envelopes the bus delivered (usually 0 or 1).
 */
async function captureCancelEvents(fn) {
  const seen = [];
  const listener = (env) => seen.push(env);
  eventBus.on(NotificationEvents.BOOKING_CANCELLED, listener);
  try {
    await fn();
    await flush();
  } finally {
    eventBus.off(NotificationEvents.BOOKING_CANCELLED, listener);
  }
  return seen;
}

/** Capture BOTH the customer and admin cancellation events during `fn`. */
async function captureBothCancelEvents(fn) {
  const customer = [];
  const admin = [];
  const onCustomer = (env) => customer.push(env);
  const onAdmin = (env) => admin.push(env);
  eventBus.on(NotificationEvents.BOOKING_CANCELLED, onCustomer);
  eventBus.on(NotificationEvents.ADMIN_BOOKING_CANCELLED, onAdmin);
  try {
    await fn();
    await flush();
  } finally {
    eventBus.off(NotificationEvents.BOOKING_CANCELLED, onCustomer);
    eventBus.off(NotificationEvents.ADMIN_BOOKING_CANCELLED, onAdmin);
  }
  return { customer, admin };
}

// Trip dates must stay in the FUTURE: a held vehicle unit is auto-freed once
// the trip's toDate passes, so hard-coded dates silently rot the availability
// assertions the moment the calendar catches up with them.
const dayOffset = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

// A realistic Approved booking owned by `email`, holding an optional vehicle.
const bookingSeed = (id, email, over = {}) => ({
  id,
  customerEmail: email,
  name: "Test Customer",
  phone: "9000000000",
  fromDate: dayOffset(7),
  toDate: dayOffset(9),
  tripType: "Round-trip",
  item: "Innova Crysta",
  vehicle: "Innova Crysta",
  fare: 12000,
  status: "Approved",
  paymentMethod: "Online",
  driver: "None",
  category: "vehicle",
  pickup: "Kochi",
  drop: "Munnar",
  vehicleId: null,
  vehicleReleased: false,
  createdAt: "2026-07-24T00:00:00.000Z",
  ...over,
});

// Unique ids per test keep the shared DB collision-free without a full reset.
let seq = 0;
const nextId = () => `TST-CANCEL-${++seq}`;

// ---- 1. Customer cancels their own booking (happy path) ----------------------

test("customer can cancel their own booking → status Cancelled, email fired", async () => {
  const id = nextId();
  insertBooking(bookingSeed(id, "alice@example.com"));

  const res = mockRes();
  const events = await captureCancelEvents(() =>
    cancelBooking(reqFor(id, { role: Roles.CUSTOMER, email: "alice@example.com" }), res)
  );

  assert.equal(res.statusCode, 200, "responds 200 OK");
  assert.equal(res.body.status, "Cancelled", "response body reflects cancellation");
  assert.equal(getBookingById(id).status, "Cancelled", "persisted to the DB");

  assert.equal(events.length, 1, "exactly one customer cancellation notification is emitted");
  assert.equal(events[0].payload.id, id);
  assert.equal(events[0].payload.customerEmail, "alice@example.com");
  assert.equal(events[0].payload.status, "Cancelled");
});

// ---- 1b. A cancel notifies BOTH the customer and the admin -------------------

test("cancelling emits BOTH a customer and an admin notification", async () => {
  const id = nextId();
  insertBooking(bookingSeed(id, "alice@example.com"));

  const { customer, admin } = await captureBothCancelEvents(() =>
    cancelBooking(reqFor(id, { role: Roles.CUSTOMER, email: "alice@example.com" }), mockRes())
  );

  assert.equal(customer.length, 1, "customer is notified");
  assert.equal(admin.length, 1, "admin is notified");
  assert.equal(admin[0].payload.id, id, "admin alert carries the booking id");
  assert.equal(admin[0].payload.customerEmail, "alice@example.com");
});

// ---- 2. A customer cannot cancel someone else's booking (authorization) ------

test("customer cannot cancel another user's booking → 403, no change, no email", async () => {
  const id = nextId();
  insertBooking(bookingSeed(id, "owner@example.com"));

  const res = mockRes();
  const events = await captureCancelEvents(() =>
    cancelBooking(reqFor(id, { role: Roles.CUSTOMER, email: "mallory@example.com" }), res)
  );

  assert.equal(res.statusCode, 403, "forbidden for a non-owner customer");
  assert.match(res.body.error, /your own/i);
  assert.equal(getBookingById(id).status, "Approved", "booking is untouched");
  assert.equal(events.length, 0, "no cancellation email for a rejected attempt");
});

// ---- 3. Unknown booking → 404 ------------------------------------------------

test("cancelling a non-existent booking → 404", async () => {
  const res = mockRes();
  cancelBooking(reqFor("DOES-NOT-EXIST", { role: Roles.CUSTOMER, email: "alice@example.com" }), res);
  assert.equal(res.statusCode, 404);
  assert.match(res.body.error, /not found/i);
});

// ---- 4. Idempotency: cancelling an already-cancelled booking sends no 2nd mail

test("cancelling an already-cancelled booking → 200, and does NOT email again", async () => {
  const id = nextId();
  insertBooking(bookingSeed(id, "alice@example.com", { status: "Cancelled" }));

  const res = mockRes();
  const events = await captureCancelEvents(() =>
    cancelBooking(reqFor(id, { role: Roles.CUSTOMER, email: "alice@example.com" }), res)
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "Cancelled");
  assert.equal(events.length, 0, "no duplicate cancellation email on a repeat call");
});

// ---- 5. A completed trip cannot be cancelled ---------------------------------

test("a Completed booking cannot be cancelled → 409, no change", async () => {
  const id = nextId();
  insertBooking(bookingSeed(id, "alice@example.com", { status: "Completed" }));

  const res = mockRes();
  const events = await captureCancelEvents(() =>
    cancelBooking(reqFor(id, { role: Roles.CUSTOMER, email: "alice@example.com" }), res)
  );

  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /completed/i);
  assert.equal(getBookingById(id).status, "Completed", "still completed");
  assert.equal(events.length, 0);
});

// ---- 6. Admin can cancel ANY booking (not just their own) --------------------

test("admin can cancel any customer's booking → Cancelled, email fired", async () => {
  const id = nextId();
  insertBooking(bookingSeed(id, "charlie@example.com", { status: "Pending" }));

  const res = mockRes();
  const events = await captureCancelEvents(() =>
    cancelBooking(reqFor(id, { role: Roles.ADMIN, email: "admin@example.com" }), res)
  );

  assert.equal(res.statusCode, 200);
  assert.equal(getBookingById(id).status, "Cancelled");
  assert.equal(events.length, 1, "customer still gets the cancellation email");
  assert.equal(events[0].payload.customerEmail, "charlie@example.com");
});

// ---- 7. Staff (>= STAFF rank) can also cancel any booking --------------------

test("staff can cancel any customer's booking", async () => {
  const id = nextId();
  insertBooking(bookingSeed(id, "dora@example.com"));

  const res = mockRes();
  cancelBooking(reqFor(id, { role: Roles.STAFF, email: "staff@example.com" }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(getBookingById(id).status, "Cancelled");
});

// ---- 8. Cancelling frees the held vehicle unit -------------------------------

test("cancelling frees the held vehicle unit (availability)", async () => {
  const vehicleId = `veh-cancel-${Date.now()}`;
  insertVehicle({ id: vehicleId, name: "Cancel Test SUV", category: "SUVs", totalUnits: 1 });

  const id = nextId();
  insertBooking(bookingSeed(id, "dave@example.com", { vehicleId, vehicleReleased: false }));

  assert.equal(isVehicleAvailable(vehicleId), false, "unit is held while the booking is active");

  const res = mockRes();
  cancelBooking(reqFor(id, { role: Roles.CUSTOMER, email: "dave@example.com" }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(isVehicleAvailable(vehicleId), true, "unit is freed once the booking is cancelled");
});

// ---- 9. The cancellation EMAIL renders with the right content ----------------

test("BOOKING_CANCELLED email renders subject + body with the booking details", () => {
  const booking = bookingSeed("RDZ042", "erin@example.com", {
    name: "Erin",
    vehicle: "Kia Carens",
    status: "Cancelled",
  });
  // The engine passes the payload through defaultContext (+ branding) before
  // filling the template — same path the live notification takes.
  const ctx = defaultContext({ ...booking, paymentStatus: "Cancelled" });
  const out = render(emailTemplates[NotificationEvents.BOOKING_CANCELLED], Channels.EMAIL, ctx);

  assert.match(out.subject, /Cancelled/i, "subject announces the cancellation");
  assert.match(out.subject, /RDZ042/, "subject carries the booking id");
  assert.match(out.body, /Erin/, "greets the customer by name");
  assert.match(out.body, /has been cancelled/i, "body states the booking was cancelled");
  assert.match(out.body, /RDZ042/, "body shows the booking id");
  assert.match(out.body, /Kia Carens/, "body shows the vehicle");
});
