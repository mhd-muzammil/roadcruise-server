import { test } from "node:test";
import assert from "node:assert/strict";

import { idempotencyKey } from "../core/idempotency.js";

test("identical inputs produce identical keys (deterministic)", () => {
  const args = { event: "booking.created", channel: "email", recipient: "a@x.com", businessKey: "B1" };
  const k1 = idempotencyKey(args);
  const k2 = idempotencyKey({ ...args });
  assert.equal(k1, k2);
  assert.match(k1, /^idk_[0-9a-f]{32}$/);
});

test("different event -> different key", () => {
  const base = { channel: "email", recipient: "a@x.com", businessKey: "B1" };
  assert.notEqual(
    idempotencyKey({ ...base, event: "booking.created" }),
    idempotencyKey({ ...base, event: "booking.confirmed" })
  );
});

test("different channel -> different key", () => {
  const base = { event: "booking.created", recipient: "a@x.com", businessKey: "B1" };
  assert.notEqual(
    idempotencyKey({ ...base, channel: "email" }),
    idempotencyKey({ ...base, channel: "sms" })
  );
});

test("different recipient -> different key", () => {
  const base = { event: "booking.created", channel: "email", businessKey: "B1" };
  assert.notEqual(
    idempotencyKey({ ...base, recipient: "a@x.com" }),
    idempotencyKey({ ...base, recipient: "b@x.com" })
  );
});

test("different businessKey -> different key", () => {
  const base = { event: "booking.created", channel: "email", recipient: "a@x.com" };
  assert.notEqual(
    idempotencyKey({ ...base, businessKey: "B1" }),
    idempotencyKey({ ...base, businessKey: "B2" })
  );
});

test("missing recipient/businessKey default to empty and stay stable", () => {
  const k1 = idempotencyKey({ event: "e", channel: "email" });
  const k2 = idempotencyKey({ event: "e", channel: "email", recipient: "", businessKey: "" });
  assert.equal(k1, k2);
});
