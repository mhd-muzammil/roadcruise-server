import { test } from "node:test";
import assert from "node:assert/strict";

import { defaultRecipients, getWorkflow, workflows } from "../workflows/registry.js";
import { Channels, NotificationEvents } from "../config/events.js";

test("defaultRecipients maps channel keys correctly (channel-key regression)", () => {
  const r = defaultRecipients({
    email: "u@x.com",
    phone: "+919999999999",
    name: "Asha",
    customerId: 42,
  });
  // The engine looks up recipients[channel]; keys MUST equal channel names.
  assert.equal(r[Channels.EMAIL], "u@x.com");
  assert.equal(r[Channels.SMS], "+919999999999", "sms must map to phone");
  assert.equal(r[Channels.WHATSAPP], "+919999999999", "whatsapp must map to phone");
  assert.equal(r.customerId, 42);
  assert.equal(r.name, "Asha");
});

test("whatsapp prefers a dedicated wa id over phone", () => {
  const r = defaultRecipients({ phone: "+91100", whatsapp: "+91999" });
  assert.equal(r[Channels.WHATSAPP], "+91999");
  assert.equal(r[Channels.SMS], "+91100");
});

test("alternate payload field names resolve", () => {
  const r = defaultRecipients({ customerEmail: "c@x.com", customerPhone: "+91222", userId: 7 });
  assert.equal(r[Channels.EMAIL], "c@x.com");
  assert.equal(r[Channels.SMS], "+91222");
  assert.equal(r[Channels.WHATSAPP], "+91222");
  assert.equal(r.customerId, 7);
});

test("missing addresses resolve to null (channel will be SKIPPED, not failed)", () => {
  const r = defaultRecipients({});
  assert.equal(r[Channels.EMAIL], null);
  assert.equal(r[Channels.SMS], null);
  assert.equal(r[Channels.WHATSAPP], null);
});

test("getWorkflow returns the booking.created workflow", () => {
  const wf = getWorkflow(NotificationEvents.BOOKING_CREATED);
  assert.equal(wf, workflows[NotificationEvents.BOOKING_CREATED]);
  assert.deepEqual(wf.channels, [Channels.EMAIL, Channels.SMS, Channels.WHATSAPP]);
});

test("getWorkflow returns __default for an unknown event", () => {
  const wf = getWorkflow("some.unregistered.event");
  assert.equal(wf, workflows.__default);
  assert.equal(typeof wf.resolveRecipients, "function");
  assert.equal(typeof wf.buildContext, "function");
});
