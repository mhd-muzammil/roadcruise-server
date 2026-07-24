// End-to-end DELIVERY diagnosis for booking cancellation.
// Unlike booking.cancel.test.js (which checks the event is emitted), this drives
// the REAL notification engine — workflow resolution, recipient resolution,
// dedup, record creation, template render, and provider send — and inspects the
// resulting notification records to see WHO actually gets a "SENT" email.
//
// Providers are the built-in mocks (mock-email succeeds for any non-"fail@"
// recipient), so a SENT record with channel=email + a given recipient is proof
// the pipeline would hand that address to the real SMTP provider in production.
import { test } from "node:test";
import assert from "node:assert/strict";

import { NotificationService } from "../../notifications/core/NotificationService.js";
import { Dispatcher } from "../../notifications/core/Dispatcher.js";
import { JsonNotificationRepository } from "../../notifications/repository/NotificationRepository.js";
import { NotificationEvents, Channels, DeliveryStatus } from "../../notifications/config/events.js";
import config from "../../notifications/config/notification.config.js";

// Drive one domain event all the way through the engine and return the records
// it created, each with its final (post-send) status.
async function deliver(event, payload) {
  const repo = new JsonNotificationRepository();
  const queue = { enqueue() {}, start() {} };
  const dispatcher = new Dispatcher({ repository: repo, queue });
  const service = new NotificationService({ repository: repo, queue, dispatcher });

  const envelope = {
    eventId: `E2E-${event}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    event,
    payload,
    actor: "system",
    correlationId: payload.id || null,
  };
  const created = await service.handleEvent(envelope);
  for (const r of created) await dispatcher.process(r.id);
  return Promise.all(created.map((r) => repo.findById(r.id)));
}

const emailTo = (records) =>
  records.filter((r) => r.channel === Channels.EMAIL).map((r) => r.recipient);

const booking = (over = {}) => ({
  id: "RDZ900",
  customerEmail: "customer@test.local",
  name: "Test Customer",
  phone: "9000000000",
  fromDate: "2026-08-01",
  toDate: "2026-08-03",
  tripType: "Round-trip",
  item: "Innova Crysta",
  vehicle: "Innova Crysta",
  fare: 12000,
  status: "Cancelled",
  ...over,
});

test("a cancellation emails the CUSTOMER (booking.cancelled workflow)", async () => {
  const records = await deliver(NotificationEvents.BOOKING_CANCELLED, booking());

  const customerEmail = records.find(
    (r) => r.channel === Channels.EMAIL && r.recipient === "customer@test.local"
  );
  assert.ok(customerEmail, "a cancellation email is addressed to the customer");
  assert.equal(customerEmail.status, DeliveryStatus.SENT, "customer email sends OK via the pipeline");
});

test("a cancellation now ALSO emails the ADMIN (admin.booking_cancelled workflow)", async () => {
  const adminAddress = config.admin.email; // admin@test.local in tests, ADMIN_EMAIL in prod
  assert.ok(adminAddress, "test env must configure an admin inbox");

  const records = await deliver(NotificationEvents.ADMIN_BOOKING_CANCELLED, booking());
  console.log("[diagnosis] admin-cancellation email recipients:", emailTo(records));

  const adminEmail = records.find((r) => r.channel === Channels.EMAIL && r.recipient === adminAddress);
  assert.ok(adminEmail, "admin now receives a cancellation alert (gap fixed)");
  assert.equal(adminEmail.status, DeliveryStatus.SENT, "admin email sends OK via the pipeline");

  // The admin alert must go to the business inbox, never the customer.
  assert.equal(
    emailTo(records).includes("customer@test.local"),
    false,
    "admin alert is not sent to the customer"
  );
});

test("CONTROL: booking-confirmed email reaches the customer through the same engine", async () => {
  // Sanity check that the pipeline itself delivers customer email, so a failed
  // cancellation delivery would point at the workflow, not the whole engine.
  const records = await deliver(NotificationEvents.BOOKING_CONFIRMED, booking({ status: "Approved" }));
  const customerEmail = records.find(
    (r) => r.channel === Channels.EMAIL && r.recipient === "customer@test.local"
  );
  assert.ok(customerEmail, "confirmation email is addressed to the customer");
  assert.equal(customerEmail.status, DeliveryStatus.SENT);
});
