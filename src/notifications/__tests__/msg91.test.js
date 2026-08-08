import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import config from "../config/notification.config.js";
import { Msg91SmsProvider } from "../providers/sms/Msg91SmsProvider.js";
import { MockSmsProvider } from "../providers/sms/MockSmsProvider.js";
import { validateProviderConfig } from "../index.js";
import { Channels, NotificationEvents } from "../config/events.js";
import { msg91TemplateFor, parseVarMap } from "../config/msg91Templates.js";

// The MSG91 provider reads config.msg91 lazily at send time and its per-event
// template ids lazily from process.env, so we populate both for the suite and
// restore afterwards. globalThis.fetch is stubbed per-test — no real HTTP, and
// therefore no real SMS, is ever issued from the test suite.
const origFetch = globalThis.fetch;
const origMsg91 = { ...config.msg91 };

// The REAL ids from the RoadCruise MSG91 account (public identifiers, not
// secrets). Asserting on them is deliberate: a wrong id silently sends the
// wrong approved content, which no other check would catch.
const OTP_TEMPLATE_ID = "6a7359294976ac1599096612";
const REMINDER_TEMPLATE_ID = "6a735a25ab93306df0082913";
// Stands in for a corrected MSG91 OTP template with two distinctly named vars.
const OTP_VARS = "otp=otp,company=companyName";

const MSG91_ENV = [
  "MSG91_OTP_TEMPLATE_ID",
  "MSG91_REMINDER_TEMPLATE_ID",
  "MSG91_BOOKING_TEMPLATE_ID",
  "MSG91_OTP_VARS",
  "MSG91_REMINDER_VARS",
  "MSG91_BOOKING_VARS",
];

before(() => {
  Object.assign(config.msg91, {
    authKey: "test-auth-key",
    senderId: "KVROCR",
    baseUrl: "https://control.msg91.com",
    defaultCountryCode: "91",
    timeoutMs: 60,
  });
});
after(() => {
  globalThis.fetch = origFetch;
  Object.assign(config.msg91, origMsg91);
  for (const k of MSG91_ENV) delete process.env[k];
});
beforeEach(() => {
  globalThis.fetch = origFetch;
  for (const k of MSG91_ENV) delete process.env[k];
  // The two templates MSG91 reports as "Verified by DLT". Booking stays unset:
  // its template is approved on Airtel DLT but does not exist in MSG91 yet.
  process.env.MSG91_OTP_TEMPLATE_ID = OTP_TEMPLATE_ID;
  process.env.MSG91_REMINDER_TEMPLATE_ID = REMINDER_TEMPLATE_ID;
  // The OTP template ships BLOCKED (its real MSG91 placeholders cannot be mapped
  // correctly — see config/msg91Templates.js). Most cases here exercise the send
  // path, so they simulate a CORRECTED template by supplying the override that
  // lifts the block. The block itself is covered by its own tests below.
  process.env.MSG91_OTP_VARS = OTP_VARS;
});

const provider = new Msg91SmsProvider();

/** Build a fake fetch returning a given status + json body; records the call. */
function stubFetch({ status = 200, json = {}, calls } = {}) {
  globalThis.fetch = async (url, opts) => {
    calls?.push({ url, opts });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => json,
    };
  };
}

const OK = { type: "success", request_id: "req_123" };

// -------------------- event -> template selection --------------------
test("OTP selects the OTP_VERIFICATION template and sends the app's OTP as a variable", async () => {
  const calls = [];
  stubFetch({ status: 200, json: OK, calls });

  const res = await provider.send({
    to: "9876543210",
    event: NotificationEvents.OTP_REQUESTED,
    body: "rendered text that must NOT be transmitted",
    context: { otp: "482913", companyName: "RoadCruise" },
  });

  // "submitted", never "sent": a 200 from MSG91 is acceptance, not delivery.
  assert.equal(res.status, "submitted");
  assert.equal(res.deliveryConfirmed, false);
  assert.equal(res.providerMessageId, "req_123");
  assert.match(calls[0].url, /\/api\/v5\/flow\/$/);
  const sent = JSON.parse(calls[0].opts.body);
  // The v5 Flow API keys the approved template as flow_id; template_id is
  // rejected asynchronously as API-failed 400.
  assert.equal(sent.flow_id, OTP_TEMPLATE_ID);
  assert.equal(sent.template_id, undefined, "template_id must never be sent");
  assert.equal(sent.sender, "KVROCR");
  assert.equal(sent.recipients[0].mobiles, "919876543210"); // 10-digit -> +CC
  // Names come from MSG91_OTP_VARS (a corrected template — see beforeEach).
  assert.equal(sent.recipients[0].otp, "482913"); // the OTP the APP generated
  assert.equal(calls[0].opts.headers.authkey, "test-auth-key");
});

test("reminder selects the REMINDER_BEFORE_RIDE template", async () => {
  const calls = [];
  stubFetch({ status: 200, json: OK, calls });

  await provider.send({
    to: "9876543210",
    event: NotificationEvents.TRIP_REMINDER,
    context: { bookingId: "RC-1", tripDate: "12 Aug", vehicle: "Innova", pickup: "Chennai", driver: "Ravi" },
  });

  const sent = JSON.parse(calls[0].opts.body);
  assert.equal(sent.flow_id, REMINDER_TEMPLATE_ID);
  assert.notEqual(sent.flow_id, OTP_TEMPLATE_ID, "reminder must not reuse the OTP template");
});

// -------------------- request id extraction --------------------
// The v5 Flow API returns the request id in `message`, not `request_id`. Losing
// it means no handle for looking the message up in MSG91's delivery reports.
test("captures the request id MSG91 actually returns (in `message`)", async () => {
  stubFetch({ status: 200, json: { type: "success", message: "366868704876456431524f53" } });
  const res = await provider.send({
    to: "9876543210",
    event: NotificationEvents.OTP_REQUESTED,
    context: { otp: "482913", companyName: "RoadCruise" },
  });
  assert.equal(res.providerMessageId, "366868704876456431524f53");
  assert.notEqual(res.providerMessageId, "success", "must not store the literal status word as an id");
});

test("prefers request_id when present, and never invents one", async () => {
  stubFetch({ status: 200, json: { type: "success", request_id: "req_9", message: "ignored" } });
  const withId = await provider.send({
    to: "9876543210",
    event: NotificationEvents.OTP_REQUESTED,
    context: { otp: "1", companyName: "RoadCruise" },
  });
  assert.equal(withId.providerMessageId, "req_9");

  // A bare success with no id at all is reported as null, not as "success".
  stubFetch({ status: 200, json: { type: "success" } });
  const noId = await provider.send({
    to: "9876543210",
    event: NotificationEvents.OTP_REQUESTED,
    context: { otp: "1", companyName: "RoadCruise" },
  });
  assert.equal(noId.providerMessageId, null);
});

// -------------------- OTP is FAIL-SAFE until the template is fixed ----------
// The live MSG91 template declares ##alphanumeric## twice under one name plus a
// mid-sentence ##numeric##, so no mapping renders a correct message. Rather than
// ship a wrong one, OTP is blocked until a resolved mapping is supplied.
test("OTP is BLOCKED by default and never reaches the network", async () => {
  delete process.env.MSG91_OTP_VARS; // back to the shipped (unresolved) state
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return { ok: true, status: 200, json: async () => OK };
  };

  await assert.rejects(
    () =>
      provider.send({
        to: "9876543210",
        event: NotificationEvents.OTP_REQUESTED,
        context: { otp: "482913", companyName: "RoadCruise" },
      }),
    (err) => {
      assert.equal(err.retryable, false, "a blocked mapping is terminal, not retried");
      assert.match(err.message, /UNRESOLVED/);
      assert.match(err.message, /MSG91_OTP_VARS/);
      return true;
    }
  );
  assert.equal(called, false, "a malformed OTP must never be put on the wire");
});

test("the block is reported by the mapping layer, with a reason", () => {
  delete process.env.MSG91_OTP_VARS;
  const t = msg91TemplateFor(NotificationEvents.OTP_REQUESTED);
  assert.equal(t.blocked, true);
  assert.ok(t.blockedReason.length > 0);
  assert.deepEqual(t.vars, [], "no guessed default mapping is shipped");
  // The template id is still configured — this is a MAPPING block, not a
  // missing-id block, and the two are reported distinctly.
  assert.equal(t.configured, true);
});

test("supplying MSG91_OTP_VARS lifts the block — no deploy needed", () => {
  process.env.MSG91_OTP_VARS = "otp=otp,company=companyName";
  const t = msg91TemplateFor(NotificationEvents.OTP_REQUESTED);
  assert.equal(t.blocked, false);
  assert.deepEqual(t.vars, [
    { name: "otp", key: "otp" },
    { name: "company", key: "companyName" },
  ]);
});

test("only OTP is blocked — reminder and booking are untouched", () => {
  delete process.env.MSG91_OTP_VARS;
  assert.equal(msg91TemplateFor(NotificationEvents.TRIP_REMINDER).blocked, false);
  assert.equal(msg91TemplateFor(NotificationEvents.BOOKING_CONFIRMED).blocked, false);
});

test("the OTP variable is fed by the app's OTP, never generated here", async () => {
  const calls = [];
  stubFetch({ status: 200, json: OK, calls });
  await provider.send({
    to: "9876543210",
    event: NotificationEvents.OTP_REQUESTED,
    context: { otp: "000123" },
  });
  // Byte-identical to what the caller supplied — no regeneration, no padding.
  assert.equal(JSON.parse(calls[0].opts.body).recipients[0].otp, "000123");
});

test("MSG91_OTP_VARS can remap the OTP placeholders without a code change", async () => {
  process.env.MSG91_OTP_VARS = "alphanumeric=otp,numeric=otpNumeric";
  const calls = [];
  stubFetch({ status: 200, json: OK, calls });
  await provider.send({
    to: "9876543210",
    event: NotificationEvents.OTP_REQUESTED,
    context: { otp: "482913", otpNumeric: "5" },
  });
  const r = JSON.parse(calls[0].opts.body).recipients[0];
  assert.equal(r.alphanumeric, "482913");
  assert.equal(r.numeric, "5");
});

// -------------------- acceptance is not delivery --------------------
test("HTTP 200 + type:success is reported as SUBMITTED, never as delivered", async () => {
  stubFetch({ status: 200, json: { type: "success", message: "36686870" } });
  const res = await provider.send({
    to: "9876543210",
    event: NotificationEvents.OTP_REQUESTED,
    context: { otp: "482913" },
  });
  assert.equal(res.status, "submitted");
  assert.notEqual(res.status, "sent");
  assert.notEqual(res.status, "delivered");
  assert.equal(res.deliveryConfirmed, false, "nothing here may claim delivery");
});

// -------------------- secret hygiene --------------------
test("the auth key and the OTP never reach the logs", async () => {
  const lines = [];
  const origLog = console.log, origErr = console.error;
  console.log = (...a) => lines.push(a.join(" "));
  console.error = (...a) => lines.push(a.join(" "));
  try {
    stubFetch({ status: 200, json: OK });
    await provider.send({
      to: "9876543210",
      event: NotificationEvents.OTP_REQUESTED,
      context: { otp: "482913", companyName: "RoadCruise" },
    });
    stubFetch({ status: 400, json: { message: "bad request" } });
    await provider
      .send({ to: "9876543210", event: NotificationEvents.OTP_REQUESTED, context: { otp: "482913" } })
      .catch(() => {});
  } finally {
    console.log = origLog;
    console.error = origErr;
  }

  const out = lines.join("\n");
  assert.ok(lines.length > 0, "the provider does log something (so this test is meaningful)");
  assert.doesNotMatch(out, /test-auth-key/, "auth key must never be logged");
  assert.doesNotMatch(out, /482913/, "the OTP value must never be logged");
  assert.doesNotMatch(out, /9876543210/, "the full recipient must never be logged");
  assert.match(out, /\*+3210/, "the recipient is logged masked, for correlation");
  assert.match(out, /vars=otp\|company/, "variable NAMES are safe to log");
});

test("each event maps to its own template id — no cross-talk", () => {
  assert.equal(msg91TemplateFor(NotificationEvents.OTP_REQUESTED).templateId, OTP_TEMPLATE_ID);
  assert.equal(msg91TemplateFor(NotificationEvents.TRIP_REMINDER).templateId, REMINDER_TEMPLATE_ID);
  assert.equal(msg91TemplateFor(NotificationEvents.BOOKING_CONFIRMED).templateId, "");
  // An event with no approved template at all resolves to null (never a fallback).
  assert.equal(msg91TemplateFor(NotificationEvents.PAYMENT_SUCCESSFUL), null);
});

// -------------------- the core DLT invariant --------------------
test("never sends arbitrary rendered SMS text — only template id + variables", async () => {
  const calls = [];
  stubFetch({ status: 200, json: OK, calls });

  const body = "RoadCruise: Your verification code is 482913. Do not share it.";
  await provider.send({
    to: "9876543210",
    event: NotificationEvents.OTP_REQUESTED,
    body,
    context: { otp: "482913", companyName: "RoadCruise" },
  });

  const wire = calls[0].opts.body;
  assert.ok(!wire.includes(body), "the rendered body must never reach MSG91");
  assert.ok(!wire.includes("Do not share"), "no approved-template prose may be transmitted");
  const sent = JSON.parse(wire);
  assert.deepEqual(Object.keys(sent).sort(), ["flow_id", "recipients", "sender"]);
  // Every recipient key is `mobiles` or a mapped variable name — nothing else.
  const allowed = new Set(["mobiles", "otp", "company"]);
  for (const k of Object.keys(sent.recipients[0])) assert.ok(allowed.has(k), `unexpected key ${k}`);
});

test("variable values are sanitized the same way rendered text is", async () => {
  const calls = [];
  stubFetch({ status: 200, json: OK, calls });

  await provider.send({
    to: "9876543210",
    event: NotificationEvents.TRIP_REMINDER,
    context: { bookingId: "RC-1", vehicle: "Innova\nCrysta", tripDate: "12 Aug" },
  });

  const r = JSON.parse(calls[0].opts.body).recipients[0];
  assert.equal(r.vehicle, "Innova Crysta"); // control chars stripped
  assert.equal(r.pickup, ""); // absent context value -> empty, never "undefined"
  assert.equal(r.driver, "");
});

test("MSG91_*_VARS overrides the variable names without a code change", async () => {
  process.env.MSG91_OTP_VARS = "code=otp,brand=companyName";
  const calls = [];
  stubFetch({ status: 200, json: OK, calls });

  await provider.send({
    to: "9876543210",
    event: NotificationEvents.OTP_REQUESTED,
    context: { otp: "482913", companyName: "RoadCruise" },
  });

  const r = JSON.parse(calls[0].opts.body).recipients[0];
  assert.deepEqual(r, { mobiles: "919876543210", code: "482913", brand: "RoadCruise" });
});

test("parseVarMap: ordered pairs, bare shorthand, tolerant of whitespace/junk", () => {
  assert.deepEqual(parseVarMap("otp=otp, company=companyName"), [
    { name: "otp", key: "otp" },
    { name: "company", key: "companyName" },
  ]);
  assert.deepEqual(parseVarMap("otp"), [{ name: "otp", key: "otp" }]);
  assert.deepEqual(parseVarMap(""), []);
  assert.deepEqual(parseVarMap(undefined), []);
});

// -------------------- booking: fails safe until MSG91 has the template ------
test("booking confirmation does NOT send while MSG91_BOOKING_TEMPLATE_ID is unset", async () => {
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return { ok: true, status: 200, json: async () => OK };
  };

  await assert.rejects(
    () =>
      provider.send({
        to: "9876543210",
        event: NotificationEvents.BOOKING_CONFIRMED,
        body: "RoadCruise: Booking RC-1 CONFIRMED.",
        context: { bookingId: "RC-1" },
      }),
    (err) => {
      assert.equal(err.retryable, false, "config error must be terminal, not retried");
      assert.match(err.message, /MSG91_BOOKING_TEMPLATE_ID/);
      return true;
    }
  );
  assert.equal(called, false, "must not hit MSG91 without an approved template");
});

test("booking works through the same mapping once its MSG91 id is configured", async () => {
  process.env.MSG91_BOOKING_TEMPLATE_ID = "aaaaaaaaaaaaaaaaaaaaaaaa";
  const calls = [];
  stubFetch({ status: 200, json: OK, calls });

  await provider.send({
    to: "9876543210",
    event: NotificationEvents.BOOKING_CONFIRMED,
    context: { bookingId: "RC-1", vehicle: "Innova", tripDate: "12 Aug", driver: "Ravi", paymentAmount: "4500" },
  });

  const sent = JSON.parse(calls[0].opts.body);
  assert.equal(sent.flow_id, "aaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(sent.recipients[0].bookingId, "RC-1");
});

test("an event with no approved template never falls back to another one", async () => {
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return { ok: true, status: 200, json: async () => OK };
  };

  await assert.rejects(
    () =>
      provider.send({
        to: "9876543210",
        event: NotificationEvents.PAYMENT_SUCCESSFUL,
        body: "RoadCruise: Payment received.",
        context: { paymentAmount: "4500" },
      }),
    (err) => {
      assert.equal(err.retryable, false);
      assert.match(err.message, /no DLT-approved MSG91 template is mapped/);
      return true;
    }
  );
  assert.equal(called, false);
});

// -------------------- number normalization --------------------
test("normalizes +91.., 91.., and bare 10-digit numbers", () => {
  assert.equal(provider._normalize("+919876543210"), "919876543210");
  assert.equal(provider._normalize("919876543210"), "919876543210");
  assert.equal(provider._normalize("9876543210"), "919876543210");
  assert.equal(provider._normalize("+91 98765 43210"), "919876543210");
});

// -------------------- invalid number --------------------
test("invalid number: throws non-retryable and never calls the API", async () => {
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return { ok: true, status: 200, json: async () => ({}) };
  };

  await assert.rejects(
    () => provider.send({ to: "not-a-number", event: NotificationEvents.OTP_REQUESTED, context: {} }),
    (err) => {
      assert.equal(err.retryable, false);
      return true;
    }
  );
  assert.equal(called, false, "must not hit the network for an invalid recipient");
});

// -------------------- credential handling --------------------
test("missing auth key: fails permanently before any HTTP call", async () => {
  const saved = config.msg91.authKey;
  config.msg91.authKey = "";
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return { ok: true, status: 200, json: async () => OK };
  };
  try {
    await assert.rejects(
      () =>
        provider.send({
          to: "9876543210",
          event: NotificationEvents.OTP_REQUESTED,
          context: { otp: "1" },
        }),
      (err) => {
        assert.equal(err.retryable, false);
        assert.match(err.message, /MSG91_API_KEY/);
        return true;
      }
    );
    assert.equal(called, false);
  } finally {
    config.msg91.authKey = saved;
  }
});

// -------------------- HTTP error classification --------------------
const otpSend = () =>
  provider.send({
    to: "9876543210",
    event: NotificationEvents.OTP_REQUESTED,
    context: { otp: "482913", companyName: "RoadCruise" },
  });

test("HTTP 401: throws NON-retryable (bad credentials never succeed on retry)", async () => {
  stubFetch({ status: 401, json: { message: "unauthorized" } });
  await assert.rejects(otpSend, (err) => {
    assert.equal(err.retryable, false);
    assert.equal(err.statusCode, 401);
    assert.doesNotMatch(err.message, /test-auth-key/, "must never leak the auth key");
    return true;
  });
});

for (const status of [400, 403, 404]) {
  test(`HTTP ${status}: classified NON-retryable`, async () => {
    stubFetch({ status, json: { message: "client error" } });
    await assert.rejects(otpSend, (err) => {
      assert.equal(err.retryable, false);
      assert.equal(err.statusCode, status);
      return true;
    });
  });
}
for (const status of [408, 429, 500, 502, 503, 504]) {
  test(`HTTP ${status}: classified RETRYABLE (transient)`, async () => {
    stubFetch({ status, json: { message: "transient" } });
    await assert.rejects(otpSend, (err) => {
      assert.equal(err.retryable, true);
      assert.equal(err.statusCode, status);
      return true;
    });
  });
}

test("HTTP 200 with logical error (bad template) is NON-retryable", async () => {
  stubFetch({ status: 200, json: { type: "error", message: "invalid template" } });
  await assert.rejects(otpSend, (err) => {
    assert.equal(err.retryable, false);
    return true;
  });
});

test("errors never leak the OTP value or the recipient", async () => {
  stubFetch({ status: 400, json: { message: "bad request" } });
  await assert.rejects(otpSend, (err) => {
    assert.doesNotMatch(err.message, /482913/, "the OTP must never appear in an error");
    assert.doesNotMatch(err.message, /9876543210/, "the recipient must never appear in an error");
    return true;
  });
});

// -------------------- timeout --------------------
test("timeout: aborts after timeoutMs and throws a RETRYABLE timeout error", async () => {
  // Fetch that hangs until the AbortController fires, then rejects like the
  // real fetch does on abort.
  globalThis.fetch = (url, opts) =>
    new Promise((_resolve, reject) => {
      opts.signal.addEventListener("abort", () => {
        const e = new Error("aborted");
        e.name = "AbortError";
        reject(e);
      });
    });

  await assert.rejects(otpSend, (err) => {
    assert.equal(err.retryable, true);
    assert.match(err.message, /timed out/);
    return true;
  });
});

// -------------------- network error --------------------
test("network error: throws RETRYABLE", async () => {
  globalThis.fetch = async () => {
    throw new Error("ECONNRESET");
  };
  await assert.rejects(otpSend, (err) => {
    assert.equal(err.retryable, true);
    return true;
  });
});

// -------------------- provider selection --------------------
test("provider identity is 'msg91-sms' (used by the registry)", () => {
  assert.equal(new Msg91SmsProvider().name, "msg91-sms");
});

test("config selection: NOTIF_SMS_PROVIDER=msg91 resolves providers.sms=msg91", async () => {
  process.env.NOTIF_SMS_PROVIDER = "msg91";
  const fresh = (await import("../config/notification.config.js?sel")).default;
  assert.equal(fresh.providers[Channels.SMS], "msg91");
});

// -------------------- mock provider is untouched --------------------
test("mock provider still works and needs no MSG91 credentials", async () => {
  const mock = new MockSmsProvider();
  assert.equal(mock.name, "mock-sms");
  const res = await mock.send({ to: "9876543210", body: "Hello" });
  assert.equal(res.status, "sent");
  assert.match(res.providerMessageId, /^mock-sms-/);
  await assert.rejects(() => mock.send({ to: "0000000000", body: "x" }));
});

// -------------------- configuration validation --------------------
test("validation: msg91 selected but missing key/sender/templates -> errors (fail closed)", () => {
  delete process.env.MSG91_OTP_TEMPLATE_ID;
  delete process.env.MSG91_REMINDER_TEMPLATE_ID;
  const errs = validateProviderConfig({
    providers: { [Channels.SMS]: "msg91" },
    msg91: { authKey: "", senderId: "" },
    branding: { companyName: "RoadCruise", supportPhone: "+91 73388 99062" },
  });
  const joined = errs.join(" ");
  assert.match(joined, /MSG91_API_KEY/);
  assert.match(joined, /MSG91_SENDER_ID/);
  assert.match(joined, /MSG91_OTP_TEMPLATE_ID/);
  assert.match(joined, /MSG91_REMINDER_TEMPLATE_ID/);
});

test("validation: «CHANGEME» placeholders count as unset", () => {
  const errs = validateProviderConfig({
    providers: { [Channels.SMS]: "msg91" },
    msg91: { authKey: "«CHANGEME_key»", senderId: "KVROCR" },
    branding: { companyName: "RoadCruise", supportPhone: "+91 73388 99062" },
  });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /MSG91_API_KEY/);
});

test("validation: verified templates configured -> no errors, booking id NOT required", () => {
  delete process.env.MSG91_BOOKING_TEMPLATE_ID;
  const errs = validateProviderConfig({
    providers: { [Channels.SMS]: "msg91" },
    msg91: { authKey: "real-key", senderId: "KVROCR" },
    branding: { companyName: "RoadCruise", supportPhone: "+91 73388 99062" },
  });
  assert.deepEqual(errs, []);
});

test("validation: another provider selected -> always valid (mock default boots)", () => {
  delete process.env.MSG91_OTP_TEMPLATE_ID;
  delete process.env.MSG91_REMINDER_TEMPLATE_ID;
  const errs = validateProviderConfig({
    providers: { [Channels.SMS]: "mock" },
    msg91: { authKey: "", senderId: "" },
    branding: { companyName: "RoadCruise", supportPhone: "+91 73388 99062" },
  });
  assert.deepEqual(errs, []);
});
