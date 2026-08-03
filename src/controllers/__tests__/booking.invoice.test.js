// Real tests for the customer invoice download (GET /:id/invoice). Exercises
// the actual controller against a real (throwaway) SQLite DB — no mocks of our
// own code, only stand-in req/res objects.
//
// Run: npm run test:bookings   (SQLITE_PATH/DATA_DIR isolated by setup.env.mjs)
import { test } from "node:test";
import assert from "node:assert/strict";

import { getBookingInvoice } from "../booking.controller.js";
import { insertBooking } from "../../utils/db.js";
import { Roles } from "../../auth/rbac/roles.js";

// ---- tiny test doubles -------------------------------------------------------

/** Stand-in res that also records headers + raw send() payloads (HTML). */
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

const reqFor = (id, auth) => ({ params: { id }, auth });

const bookingSeed = (id, email, over = {}) => ({
  id,
  customerEmail: email,
  name: "Invoice Customer",
  phone: "9000000000",
  fromDate: "2026-09-01",
  toDate: "2026-09-03",
  tripType: "Round-trip",
  item: "Innova Crysta",
  vehicle: "Innova Crysta",
  fare: 12000,
  paymentPlan: "full",
  advanceAmount: 0,
  status: "Pending",
  paymentMethod: "Pay on arrival",
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
const nextId = () => `TST-INV-${++seq}`;

// ---- 1. Owner downloads their invoice (happy path) ---------------------------

test("owner gets a self-contained HTML invoice with the booking's details", () => {
  const id = nextId();
  insertBooking(bookingSeed(id, "alice@example.com"));

  const res = mockRes();
  getBookingInvoice(reqFor(id, { role: Roles.CUSTOMER, email: "alice@example.com" }), res);

  assert.equal(res.statusCode, 200);
  assert.match(res.headers["Content-Type"], /text\/html/, "served as HTML");
  assert.match(
    res.headers["Content-Disposition"],
    new RegExp(`RoadCruise-Invoice-${id}\\.html`),
    "download filename carries the booking ref"
  );

  const html = String(res.body);
  assert.match(html, /^<!doctype html>/i, "a full standalone document");
  assert.ok(html.includes(`RC-INV-${id}`), "fallback invoice number derives from the booking ref");
  assert.ok(html.includes("₹12,000"), "fare is rendered in INR format");
  assert.ok(html.includes("Chennai"), "pickup appears");
  assert.ok(html.includes("Madurai"), "drop appears");
  assert.ok(html.includes("Invoice Customer"), "billed-to name appears");
  assert.ok(html.includes("Balance due"), "an unpaid booking shows the amount still due");
  assert.ok(html.includes("window.print()"), "print/save-as-PDF affordance is present");
});

// ---- 2. User-controlled fields are HTML-escaped (XSS) ------------------------

test("booking fields are HTML-escaped in the invoice (no script injection)", () => {
  const id = nextId();
  insertBooking(
    bookingSeed(id, "alice@example.com", {
      name: `<script>alert("x")</script>`,
      pickup: `"><img src=x onerror=alert(1)>`,
    })
  );

  const res = mockRes();
  getBookingInvoice(reqFor(id, { role: Roles.CUSTOMER, email: "alice@example.com" }), res);

  const html = String(res.body);
  assert.equal(res.statusCode, 200);
  assert.ok(!html.includes("<script>alert"), "raw script tags never reach the document");
  assert.ok(!html.includes("<img src=x"), "raw attribute-breaking markup never reaches the document");
  assert.ok(html.includes("&lt;script&gt;"), "the content is escaped, not dropped");
});

// ---- 3. Authorization --------------------------------------------------------

test("a stranger cannot download someone else's invoice → 403", () => {
  const id = nextId();
  insertBooking(bookingSeed(id, "owner@example.com"));

  const res = mockRes();
  getBookingInvoice(reqFor(id, { role: Roles.CUSTOMER, email: "mallory@example.com" }), res);

  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /your own/i);
});

test("staff can download any customer's invoice → 200", () => {
  const id = nextId();
  insertBooking(bookingSeed(id, "owner@example.com"));

  const res = mockRes();
  getBookingInvoice(reqFor(id, { role: Roles.STAFF, email: "staff@roadcruise.in" }), res);

  assert.equal(res.statusCode, 200);
  assert.match(String(res.body), /^<!doctype html>/i);
});

// ---- 4. Unknown booking → 404 ------------------------------------------------

test("invoice for a non-existent booking → 404", () => {
  const res = mockRes();
  getBookingInvoice(reqFor("DOES-NOT-EXIST", { role: Roles.CUSTOMER, email: "alice@example.com" }), res);
  assert.equal(res.statusCode, 404);
  assert.match(res.body.error, /not found/i);
});

// ---- 5. Advance-plan booking shows the balance owed to the driver ------------

test("an advance-plan booking's invoice reflects the full fare (balance model)", () => {
  const id = nextId();
  insertBooking(
    bookingSeed(id, "alice@example.com", {
      paymentPlan: "advance",
      advanceAmount: 2400,
      paymentMethod: "Online (20% advance)",
      status: "Approved",
    })
  );

  const res = mockRes();
  getBookingInvoice(reqFor(id, { role: Roles.CUSTOMER, email: "alice@example.com" }), res);

  const html = String(res.body);
  assert.equal(res.statusCode, 200);
  assert.ok(html.includes("₹12,000"), "total fare rendered");
  assert.ok(html.includes("Online (20% advance)"), "payment method rendered");
});
