import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveTemplate } from "../templates/registry.js";
import { Channels, NotificationEvents } from "../config/events.js";

test("resolveTemplate returns a def for booking.created on all 3 channels (no fallback)", () => {
  for (const channel of [Channels.EMAIL, Channels.SMS, Channels.WHATSAPP]) {
    const { def, usedFallback } = resolveTemplate(channel, NotificationEvents.BOOKING_CREATED);
    assert.ok(def, `expected a def for ${channel}`);
    assert.equal(usedFallback, false, `should not fall back for ${channel}`);
    // each channel def must carry renderable content
    const hasContent = def.subject || def.html || def.text;
    assert.ok(hasContent, `def for ${channel} should have content`);
  }
});

test("unknown event falls back to generic with usedFallback=true", () => {
  for (const channel of [Channels.EMAIL, Channels.SMS, Channels.WHATSAPP]) {
    const { def, usedFallback } = resolveTemplate(channel, "totally.unknown.event");
    assert.equal(usedFallback, true, `should fall back for ${channel}`);
    assert.ok(def, `generic def should exist for ${channel}`);
  }
});

test("unknown channel throws", () => {
  assert.throws(() => resolveTemplate("carrier-pigeon", NotificationEvents.BOOKING_CREATED), /No template library/);
});
