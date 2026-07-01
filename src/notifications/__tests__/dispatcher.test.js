import { test } from "node:test";
import assert from "node:assert/strict";

import { Dispatcher } from "../core/Dispatcher.js";
import { JsonNotificationRepository } from "../repository/NotificationRepository.js";
import { DeliveryStatus, NotificationEvents, Channels } from "../config/events.js";

const repo = new JsonNotificationRepository();
const fakeQueue = { enqueue() {} };
const dispatcher = new Dispatcher({ repository: repo, queue: fakeQueue });

const uid = (name) => `RC-NTF-DISP-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

// minimal valid context so templates render
const ctx = { customerName: "Tester", bookingId: "B-TEST", companyName: "Road Cruise" };

test("successful send -> status SENT, attempts 1", async () => {
  const id = uid("ok");
  await repo.create({
    id,
    event: NotificationEvents.BOOKING_CREATED,
    channel: Channels.EMAIL,
    recipient: "ok@test.local", // mock email succeeds for non fail@ recipients
    status: DeliveryStatus.QUEUED,
    maxAttempts: 2,
    payload: ctx,
  });

  await dispatcher.process(id);

  const rec = await repo.findById(id);
  assert.equal(rec.status, DeliveryStatus.SENT);
  assert.equal(rec.attempts, 1);
  assert.ok(rec.sentAt);
  assert.ok(rec.providerResponse);
  assert.equal(rec.provider, "mock-email");
  assert.ok(rec.rendered && rec.rendered.body);
});

test("failing send retries with future backoff, then dead-letters when exhausted", async () => {
  const id = uid("fail");
  await repo.create({
    id,
    event: NotificationEvents.BOOKING_CREATED,
    channel: Channels.EMAIL,
    recipient: "fail@test.local", // mock email throws for fail@ recipients
    status: DeliveryStatus.QUEUED,
    maxAttempts: 2,
    payload: ctx,
  });

  const t0 = Date.now();

  // Attempt 1 -> failure, attempts < maxAttempts -> FAILED + backoff scheduled.
  await dispatcher.process(id);
  const afterFirst = await repo.findById(id);
  assert.equal(afterFirst.status, DeliveryStatus.FAILED);
  assert.equal(afterFirst.attempts, 1);
  assert.ok(afterFirst.error);
  assert.ok(afterFirst.nextAttemptAt, "backoff should set nextAttemptAt");
  assert.ok(
    new Date(afterFirst.nextAttemptAt).getTime() > t0,
    "nextAttemptAt must be in the future (backoff)"
  );

  // Attempt 2 -> failure, attempts == maxAttempts -> DEAD_LETTER.
  await dispatcher.process(id);
  const afterSecond = await repo.findById(id);
  assert.equal(afterSecond.status, DeliveryStatus.DEAD_LETTER);
  assert.equal(afterSecond.attempts, 2);
  assert.ok(afterSecond.completedAt);

  // A dead-letter row must exist for this notification.
  const dls = await repo.listDeadLetters();
  const row = dls.find((d) => d.notificationId === id);
  assert.ok(row, "dead-letter row should exist");
  assert.equal(row.attempts, 2);
  assert.equal(row.channel, Channels.EMAIL);
});

test("process() is a no-op for records not in QUEUED/FAILED state", async () => {
  const id = uid("sent");
  await repo.create({
    id,
    event: NotificationEvents.BOOKING_CREATED,
    channel: Channels.EMAIL,
    recipient: "fail@test.local", // would throw if it ran
    status: DeliveryStatus.SENT,
    maxAttempts: 2,
    payload: ctx,
  });

  await dispatcher.process(id); // must not touch it
  const rec = await repo.findById(id);
  assert.equal(rec.status, DeliveryStatus.SENT);
  assert.equal(rec.attempts, 0);
});
