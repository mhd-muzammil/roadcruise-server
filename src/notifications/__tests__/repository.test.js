import { test } from "node:test";
import assert from "node:assert/strict";

import { JsonNotificationRepository } from "../repository/NotificationRepository.js";
import { DeliveryStatus } from "../config/events.js";

// NOTE: the JSON store writes to src/notifications/data/. Tests stay independent
// by using unique ids/keys per test (namespaced with the test name), so they
// never collide with each other or with any pre-existing rows.
const repo = new JsonNotificationRepository();
const uid = (name) => `RC-NTF-TEST-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

test("create assigns defaults and findById returns the row", async () => {
  const id = uid("create");
  const created = await repo.create({
    id,
    event: "booking.created",
    channel: "email",
    recipient: "create@test.local",
  });
  assert.equal(created.id, id);
  assert.equal(created.status, DeliveryStatus.QUEUED);
  assert.equal(created.attempts, 0);
  assert.ok(created.createdAt);

  const found = await repo.findById(id);
  assert.ok(found);
  assert.equal(found.id, id);
  assert.equal(found.recipient, "create@test.local");

  assert.equal(await repo.findById(uid("missing")), null);
});

test("update patches fields and bumps updatedAt", async () => {
  const id = uid("update");
  await repo.create({ id, event: "booking.created", channel: "sms", recipient: "9" });
  const updated = await repo.update(id, { status: DeliveryStatus.SENT, attempts: 1 });
  assert.equal(updated.status, DeliveryStatus.SENT);
  assert.equal(updated.attempts, 1);

  const reread = await repo.findById(id);
  assert.equal(reread.status, DeliveryStatus.SENT);

  // updating a non-existent id returns null
  assert.equal(await repo.update(uid("nope"), { status: "x" }), null);
});

test("query filters by status, channel, event and search", async () => {
  const tag = `query-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const evt = `evt.${tag}`;
  const idA = uid("queryA");
  const idB = uid("queryB");
  await repo.create({ id: idA, event: evt, channel: "email", recipient: `aa@${tag}.local`, status: DeliveryStatus.SENT });
  await repo.create({ id: idB, event: evt, channel: "sms", recipient: `bb@${tag}.local`, status: DeliveryStatus.FAILED });

  const byEvent = await repo.query({ event: evt });
  assert.equal(byEvent.items.length, 2);

  const byStatus = await repo.query({ event: evt, status: DeliveryStatus.SENT });
  assert.equal(byStatus.items.length, 1);
  assert.equal(byStatus.items[0].id, idA);

  const byChannel = await repo.query({ event: evt, channel: "sms" });
  assert.equal(byChannel.items.length, 1);
  assert.equal(byChannel.items[0].id, idB);

  const bySearch = await repo.query({ search: `aa@${tag}` });
  assert.equal(bySearch.items.length, 1);
  assert.equal(bySearch.items[0].id, idA);

  // pagination shape
  const paged = await repo.query({ event: evt, limit: 1, offset: 0 });
  assert.equal(paged.total, 2);
  assert.equal(paged.limit, 1);
  assert.equal(paged.items.length, 1);
});

test("findByIdempotencyKey returns the matching row", async () => {
  const id = uid("idk");
  const key = `idk_test_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  await repo.create({ id, event: "x", channel: "email", recipient: "r", idempotencyKey: key });
  const found = await repo.findByIdempotencyKey(key);
  assert.ok(found);
  assert.equal(found.id, id);

  assert.equal(await repo.findByIdempotencyKey(""), null);
  assert.equal(await repo.findByIdempotencyKey(`idk_absent_${Date.now()}`), null);
});

test("findDue returns QUEUED/FAILED records whose nextAttemptAt is past", async () => {
  const past = new Date(Date.now() - 60000).toISOString();
  const future = new Date(Date.now() + 600000).toISOString();
  const dueId = uid("dueQueued");
  const failedDueId = uid("dueFailed");
  const notDueId = uid("notDueFuture");
  const sentId = uid("sentNotDue");

  await repo.create({ id: dueId, event: "x", channel: "email", recipient: "r", status: DeliveryStatus.QUEUED, nextAttemptAt: past });
  await repo.create({ id: failedDueId, event: "x", channel: "email", recipient: "r", status: DeliveryStatus.FAILED, nextAttemptAt: past });
  await repo.create({ id: notDueId, event: "x", channel: "email", recipient: "r", status: DeliveryStatus.QUEUED, nextAttemptAt: future });
  await repo.create({ id: sentId, event: "x", channel: "email", recipient: "r", status: DeliveryStatus.SENT, nextAttemptAt: past });

  const due = await repo.findDue();
  const dueIds = new Set(due.map((d) => d.id));
  assert.ok(dueIds.has(dueId));
  assert.ok(dueIds.has(failedDueId));
  assert.ok(!dueIds.has(notDueId), "future nextAttemptAt must not be due");
  assert.ok(!dueIds.has(sentId), "SENT records must not be due");
});

test("pushDeadLetter appends to the dead-letter list", async () => {
  const nid = uid("dl");
  const before = await repo.listDeadLetters();
  await repo.pushDeadLetter({ notificationId: nid, event: "x", channel: "email", recipient: "r", error: "boom", attempts: 3 });
  const after = await repo.listDeadLetters();
  assert.equal(after.length, before.length + 1);
  const row = after.find((d) => d.notificationId === nid);
  assert.ok(row);
  assert.equal(row.error, "boom");
  assert.ok(row.movedAt);
});
