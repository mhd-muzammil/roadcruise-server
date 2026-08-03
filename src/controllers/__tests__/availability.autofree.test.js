// Real tests for the auto-free availability model: a booking's vehicle unit
// frees AUTOMATICALLY once its trip end date (toDate) has passed — no admin
// action needed — while cancellation and the admin's early "Free" release keep
// working. Exercises the real availability service against a real (throwaway)
// SQLite DB — no mocks of our own code.
//
// Run: npm run test:bookings   (SQLITE_PATH/DATA_DIR isolated by setup.env.mjs)
import { test } from "node:test";
import assert from "node:assert/strict";

import { insertBooking } from "../../utils/db.js";
import { insertVehicle } from "../../db/vehicles.db.js";
import {
  tripEnded,
  heldCounts,
  heldBookingsFor,
  withAvailability,
  isVehicleAvailable,
} from "../../services/availability.js";

// Unique ids per test keep the shared DB collision-free without a full reset.
let seq = 0;
const nextId = () => `TST-AUTOFREE-${++seq}`;

/** Local YYYY-MM-DD for a date `days` from now (bookings store local dates). */
const localDate = (days = 0) => {
  const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const bookingSeed = (id, vehicleId, over = {}) => ({
  id,
  customerEmail: "holder@example.com",
  name: "Hold Customer",
  phone: "9000000000",
  fromDate: localDate(1),
  toDate: localDate(3),
  tripType: "Round-trip",
  item: "Held Vehicle",
  vehicle: "Held Vehicle",
  fare: 8000,
  status: "Approved",
  paymentMethod: "Online",
  driver: "None",
  category: "vehicle",
  pickup: "Chennai",
  drop: "Pondicherry",
  vehicleId,
  vehicleReleased: false,
  createdAt: new Date().toISOString(),
  ...over,
});

// ---- 1. tripEnded: the date rule itself --------------------------------------

test("tripEnded: past toDate is ended; today/future/invalid are not", () => {
  assert.equal(tripEnded({ toDate: localDate(-1) }), true, "yesterday's trip has ended");
  assert.equal(tripEnded({ toDate: localDate(0) }), false, "a trip ending TODAY holds until end of day");
  assert.equal(tripEnded({ toDate: localDate(5) }), false, "a future trip has not ended");
  assert.equal(tripEnded({ toDate: "not-a-date" }), false, "unparseable toDate keeps the hold (fail-safe)");
  assert.equal(tripEnded({}), false, "missing toDate keeps the hold (fail-safe)");
});

// ---- 2. A unit auto-frees once the trip end date passes ----------------------

test("a booking whose toDate has passed no longer holds its vehicle unit", () => {
  const v = insertVehicle({ name: `AutoFree-${nextId()}`, totalUnits: 1 });
  insertBooking(bookingSeed(nextId(), v.id, { fromDate: localDate(-5), toDate: localDate(-2) }));

  assert.equal(isVehicleAvailable(v.id), true, "vehicle is bookable again after the trip");
  assert.equal(heldCounts()[v.id] ?? 0, 0, "no held units are counted");
  assert.deepEqual(heldBookingsFor(v.id), [], "the admin Free list no longer shows the finished trip");
});

// ---- 3. An active (future) trip still holds its unit -------------------------

test("an upcoming booking holds its unit: unavailable when all units are held", () => {
  const v = insertVehicle({ name: `Active-${nextId()}`, totalUnits: 1 });
  const id = nextId();
  insertBooking(bookingSeed(id, v.id));

  assert.equal(isVehicleAvailable(v.id), false, "the only unit is held");
  assert.equal(heldCounts()[v.id], 1, "exactly one held unit");
  assert.equal(heldBookingsFor(v.id).length, 1, "the admin Free list shows the holder");
  assert.equal(heldBookingsFor(v.id)[0].id, id);

  const decorated = withAvailability({ id: v.id, totalUnits: 1 });
  assert.equal(decorated.available, false);
  assert.equal(decorated.heldCount, 1);
});

// ---- 4. Mixed holds: only unfinished, unreleased, uncancelled trips count ----

test("cancelled, admin-released and finished trips all free their units; active ones don't", () => {
  const v = insertVehicle({ name: `Mixed-${nextId()}`, totalUnits: 4 });
  insertBooking(bookingSeed(nextId(), v.id, { status: "Cancelled" }));
  insertBooking(bookingSeed(nextId(), v.id, { vehicleReleased: true }));
  insertBooking(bookingSeed(nextId(), v.id, { fromDate: localDate(-4), toDate: localDate(-1) }));
  const activeId = nextId();
  insertBooking(bookingSeed(activeId, v.id));

  assert.equal(heldCounts()[v.id], 1, "only the active trip holds a unit");
  const holders = heldBookingsFor(v.id);
  assert.equal(holders.length, 1);
  assert.equal(holders[0].id, activeId);
  assert.equal(isVehicleAvailable(v.id), true, "3 of 4 units are free");
});

// ---- 5. A trip ending today keeps its hold until the day is over -------------

test("a trip whose toDate is TODAY still holds its unit (frees end of day)", () => {
  const v = insertVehicle({ name: `Today-${nextId()}`, totalUnits: 1 });
  insertBooking(bookingSeed(nextId(), v.id, { fromDate: localDate(-2), toDate: localDate(0) }));

  assert.equal(isVehicleAvailable(v.id), false, "the ongoing (ends-today) trip still holds the unit");
});
