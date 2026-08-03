// Real tests for customer self-service trip modification (PATCH /:id/modify).
// Exercises the actual controller against a real (throwaway) SQLite DB and the
// real notification EventBus — no mocks of our own code, only stand-in req/res
// objects, exactly what Express would hand the controller.
//
// Run: npm run test:bookings   (SQLITE_PATH/DATA_DIR isolated by setup.env.mjs)
import { test } from "node:test";
import assert from "node:assert/strict";

import { modifyBooking } from "../booking.controller.js";
import { insertBooking, getBookingById } from "../../utils/db.js";
import { Roles } from "../../auth/rbac/roles.js";

import { eventBus } from "../../notifications/core/EventBus.js";
import { NotificationEvents } from "../../notifications/config/events.js";

// ---- tiny test doubles -------------------------------------------------------

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

const reqFor = (id, auth, body = {}) => ({ params: { id }, auth, body });

/** Let the EventBus's setImmediate-deferred emit run, then resolve. */
const flush = () => new Promise((r) => setImmediate(() => setImmediate(r)));

/** Capture the customer (rescheduled) + admin (modified) events during `fn`. */
async function captureModifyEvents(fn) {
  const customer = [];
  const admin = [];
  const onCustomer = (env) => customer.push(env);
  const onAdmin = (env) => admin.push(env);
  eventBus.on(NotificationEvents.BOOKING_RESCHEDULED, onCustomer);
  eventBus.on(NotificationEvents.ADMIN_BOOKING_MODIFIED, onAdmin);
  try {
    await fn();
    await flush();
  } finally {
    eventBus.off(NotificationEvents.BOOKING_RESCHEDULED, onCustomer);
    eventBus.off(NotificationEvents.ADMIN_BOOKING_MODIFIED, onAdmin);
  }
  return { customer, admin };
}

const bookingSeed = (id, email, over = {}) => ({
  id,
  customerEmail: email,
  name: "Test Customer",
  phone: "9000000000",
  fromDate: "2026-09-01",
  toDate: "2026-09-03",
  tripType: "Round-trip",
  item: "Innova Crysta",
  vehicle: "Innova Crysta",
  fare: 12000,
  paymentPlan: "advance",
  advanceAmount: 2400,
  status: "Approved",
  paymentMethod: "Online (20% advance)",
  driver: "None",
  category: "vehicle",
  pickup: "Chennai",
  drop: "Madurai",
  vehicleId: null,
  vehicleReleased: false,
  passengers: "4",
  pickupTime: "06:00",
  notes: "",
  createdAt: "2026-08-01T00:00:00.000Z",
  ...over,
});

// Unique ids per test keep the shared DB collision-free without a full reset.
let seq = 0;
const nextId = () => `TST-MODIFY-${++seq}`;

// ---- 1. Owner edits trip details (happy path) --------------------------------

test("owner can modify trip details → 200, persisted, customer + admin notified", async () => {
  const id = nextId();
  insertBooking(bookingSeed(id, "alice@example.com"));

  const res = mockRes();
  const { customer, admin } = await captureModifyEvents(() =>
    modifyBooking(
      reqFor(id, { role: Roles.CUSTOMER, email: "alice@example.com" }, {
        fromDate: "2026-09-05",
        toDate: "2026-09-07",
        pickup: "Chennai Airport (MAA)",
        passengers: "5",
        pickupTime: "07:30",
        notes: "Need a baby seat",
      }),
      res
    )
  );

  assert.equal(res.statusCode, 200, "responds 200 OK");
  const saved = getBookingById(id);
  assert.equal(saved.fromDate, "2026-09-05");
  assert.equal(saved.toDate, "2026-09-07");
  assert.equal(saved.pickup, "Chennai Airport (MAA)");
  assert.equal(saved.passengers, "5");
  assert.equal(saved.pickupTime, "07:30");
  assert.equal(saved.notes, "Need a baby seat");
  assert.equal(saved.fare, 12000, "the fare never changes on a modify");
  assert.equal(saved.status, "Approved", "the status never changes on a modify");

  assert.equal(customer.length, 1, "customer gets a 'booking rescheduled' notification");
  assert.equal(customer[0].payload.fromDate, "2026-09-05");
  assert.equal(admin.length, 1, "business inbox gets a 'booking modified' alert");
  assert.equal(admin[0].payload.id, id);
});

// ---- 2. Non-owner is rejected ------------------------------------------------

test("customer cannot modify another user's booking → 403, no change, no events", async () => {
  const id = nextId();
  insertBooking(bookingSeed(id, "owner@example.com"));

  const res = mockRes();
  const { customer, admin } = await captureModifyEvents(() =>
    modifyBooking(reqFor(id, { role: Roles.CUSTOMER, email: "mallory@example.com" }, { pickup: "Hijacked" }), res)
  );

  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /your own/i);
  assert.equal(getBookingById(id).pickup, "Chennai", "booking is untouched");
  assert.equal(customer.length + admin.length, 0, "no notifications for a rejected attempt");
});

// ---- 3. Staff can modify any booking -----------------------------------------

test("staff can modify any customer's booking → 200", async () => {
  const id = nextId();
  insertBooking(bookingSeed(id, "owner@example.com"));

  const res = mockRes();
  await captureModifyEvents(() =>
    modifyBooking(reqFor(id, { role: Roles.STAFF, email: "staff@roadcruise.in" }, { drop: "Trichy" }), res)
  );

  assert.equal(res.statusCode, 200);
  assert.equal(getBookingById(id).drop, "Trichy");
});

// ---- 4. Cancelled / Completed bookings are locked ----------------------------

test("a cancelled booking cannot be modified → 409", async () => {
  const id = nextId();
  insertBooking(bookingSeed(id, "alice@example.com", { status: "Cancelled" }));

  const res = mockRes();
  modifyBooking(reqFor(id, { role: Roles.CUSTOMER, email: "alice@example.com" }, { pickup: "X" }), res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /cancelled/i);
});

test("a completed booking cannot be modified → 409", async () => {
  const id = nextId();
  insertBooking(bookingSeed(id, "alice@example.com", { status: "Completed" }));

  const res = mockRes();
  modifyBooking(reqFor(id, { role: Roles.CUSTOMER, email: "alice@example.com" }, { pickup: "X" }), res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /completed/i);
});

// ---- 5. Date validation ------------------------------------------------------

test("reversed dates are rejected → 400, nothing persisted", async () => {
  const id = nextId();
  insertBooking(bookingSeed(id, "alice@example.com"));

  const res = mockRes();
  modifyBooking(
    reqFor(id, { role: Roles.CUSTOMER, email: "alice@example.com" }, { fromDate: "2026-09-10", toDate: "2026-09-08" }),
    res
  );
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /end date/i);
  assert.equal(getBookingById(id).fromDate, "2026-09-01", "booking is untouched");
});

test("a malformed date is rejected → 400", async () => {
  const id = nextId();
  insertBooking(bookingSeed(id, "alice@example.com"));

  const res = mockRes();
  modifyBooking(reqFor(id, { role: Roles.CUSTOMER, email: "alice@example.com" }, { fromDate: "next tuesday" }), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /valid dates/i);
});

// ---- 6. Field whitelist: money/status tampering is ignored -------------------

test("fare/status/vehicleId in the body are silently ignored (whitelist)", async () => {
  const id = nextId();
  insertBooking(bookingSeed(id, "alice@example.com"));

  const res = mockRes();
  await captureModifyEvents(() =>
    modifyBooking(
      reqFor(id, { role: Roles.CUSTOMER, email: "alice@example.com" }, {
        fare: 1, advanceAmount: 0, status: "Approved", vehicleId: "someone-elses-car", drop: "Salem",
      }),
      res
    )
  );

  assert.equal(res.statusCode, 200);
  const saved = getBookingById(id);
  assert.equal(saved.fare, 12000, "fare tampering ignored");
  assert.equal(saved.advanceAmount, 2400, "advance tampering ignored");
  assert.equal(saved.vehicleId, null, "vehicle tampering ignored");
  assert.equal(saved.drop, "Salem", "the whitelisted field still applies");
});

// ---- 7. A no-op modify sends no notifications --------------------------------

test("submitting unchanged values → 200 and NO notifications", async () => {
  const id = nextId();
  insertBooking(bookingSeed(id, "alice@example.com"));

  const res = mockRes();
  const { customer, admin } = await captureModifyEvents(() =>
    modifyBooking(
      reqFor(id, { role: Roles.CUSTOMER, email: "alice@example.com" }, { pickup: "Chennai", drop: "Madurai" }),
      res
    )
  );

  assert.equal(res.statusCode, 200);
  assert.equal(customer.length + admin.length, 0, "no-op modifies must not spam anyone");
});

// ---- 8. Unknown booking → 404 ------------------------------------------------

test("modifying a non-existent booking → 404", () => {
  const res = mockRes();
  modifyBooking(reqFor("DOES-NOT-EXIST", { role: Roles.CUSTOMER, email: "alice@example.com" }, { pickup: "X" }), res);
  assert.equal(res.statusCode, 404);
  assert.match(res.body.error, /not found/i);
});
