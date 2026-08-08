import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import config from "../config/notification.config.js";
import {
  dlt,
  toDltText,
  varNames,
  buildVars,
  registrationSheet,
  envKeyFor,
  FIXED_KEYS,
} from "../config/dlt.js";
import { AirtelIqSmsProvider } from "../providers/sms/AirtelIqSmsProvider.js";
import { Msg91SmsProvider } from "../providers/sms/Msg91SmsProvider.js";
import { NotificationEvents } from "../config/events.js";

const BRANDING = { companyName: "RoadCruise", supportPhone: "+91 73388 99062" };
const origFetch = globalThis.fetch;
const origAirtel = { ...config.airtelIq };
const origMsg91 = { ...config.msg91 };
const TID = "1707171234567890123";

before(() => {
  Object.assign(config.airtelIq, {
    customerId: "cust_test",
    username: "u",
    password: "p",
    senderId: "RDCRSE",
    baseUrl: "https://iqsms.airtel.in",
    messageType: "SERVICE_IMPLICIT",
    defaultCountryCode: "91",
    timeoutMs: 60,
  });
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
  Object.assign(config.airtelIq, origAirtel);
  Object.assign(config.msg91, origMsg91);
});
beforeEach(() => {
  globalThis.fetch = origFetch;
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("DLT_") || /^MSG91_.*_(TEMPLATE_ID|VARS)$/.test(k)) delete process.env[k];
  }
});

function stubFetch({ status = 200, json = {}, calls } = {}) {
  globalThis.fetch = async (url, opts) => {
    calls?.push({ url, opts });
    return { ok: status >= 200 && status < 300, status, json: async () => json };
  };
}

// -------------------- template -> DLT text --------------------
test("toDltText bakes branding in as fixed text and varies only the dynamic parts", () => {
  const tpl = "{{companyName}}: Booking {{bookingId}} for {{vehicle}}. Help: {{supportPhone}}";
  assert.equal(
    toDltText(tpl, BRANDING),
    "RoadCruise: Booking {#var#} for {#var#}. Help: +91 73388 99062"
  );
});

test("varNames excludes branding constants and preserves registration order", () => {
  const tpl = "{{companyName}}: {{bookingId}} {{vehicle}} {{tripDate}}. {{supportPhone}}";
  assert.deepEqual(varNames(tpl), ["bookingId", "vehicle", "tripDate"]);
  for (const k of FIXED_KEYS) assert.ok(!varNames(`{{${k}}}`).includes(k));
});

test("buildVars returns sanitized values positionally aligned with varNames", () => {
  const tpl = "{{companyName}}: {{bookingId}} {{vehicle}} {{missing}}";
  const vars = buildVars(tpl, { bookingId: "RC-1", vehicle: "Innova\nCrysta" });
  // Same length/order as varNames, control chars stripped, absent -> "".
  assert.deepEqual(varNames(tpl), ["bookingId", "vehicle", "missing"]);
  assert.deepEqual(vars, ["RC-1", "Innova Crysta", ""]);
});

test("buildVars resolves dotted paths", () => {
  assert.deepEqual(buildVars("{{a.b}}", { a: { b: "deep" } }), ["deep"]);
});

// -------------------- registration sheet --------------------
test("registrationSheet covers every SMS event and reports registration status", () => {
  const sheet = registrationSheet(BRANDING);
  assert.ok(sheet.length >= 15);
  const confirmed = sheet.find((t) => t.event === NotificationEvents.BOOKING_CONFIRMED);
  assert.equal(confirmed.envKey, "DLT_TID_BOOKING_CONFIRMED");
  assert.equal(confirmed.registered, false);
  assert.ok(confirmed.dltText.includes("{#var#}"));
  assert.ok(!confirmed.dltText.includes("{{"), "no unconverted handlebars survive");
  // Slot count must equal the variable count, or the operator match fails.
  assert.equal(confirmed.dltText.split("{#var#}").length - 1, confirmed.vars.length);
});

test("every SMS template yields matching slot and variable counts", () => {
  for (const t of registrationSheet(BRANDING)) {
    assert.equal(
      t.dltText.split("{#var#}").length - 1,
      t.vars.length,
      `${t.constName}: slot/var count mismatch`
    );
    assert.ok(!t.dltText.includes("{{"), `${t.constName}: unconverted handlebars`);
  }
});

test("registrationSheet attaches a warnings array to every entry", () => {
  for (const t of registrationSheet(BRANDING)) assert.ok(Array.isArray(t.warnings));
  // The rule itself: an all-variable body has no fixed text left to scrub.
  assert.equal(toDltText("{{a}} {{b}}", BRANDING).split("{#var#}").join("").trim().length, 0);
});

test("registrationSheet reflects an approved id once its env var is set", () => {
  process.env[envKeyFor("BOOKING_CONFIRMED")] = TID;
  const t = registrationSheet(BRANDING).find((x) => x.constName === "BOOKING_CONFIRMED");
  assert.equal(t.registered, true);
  assert.equal(t.templateId, TID);
  assert.equal(dlt.templateIdFor(NotificationEvents.BOOKING_CONFIRMED), TID);
  assert.equal(dlt.configured, true);
});

test("templateIdFor returns empty for an unregistered or unknown event", () => {
  assert.equal(dlt.templateIdFor(NotificationEvents.BOOKING_CONFIRMED), "");
  assert.equal(dlt.templateIdFor("not.an.event"), "");
  assert.equal(dlt.configured, false);
});

// -------------------- Airtel IQ provider --------------------
test("airtel: sends body + dltTemplateId + entityId, returns providerMessageId", async () => {
  process.env[envKeyFor("BOOKING_CONFIRMED")] = TID;
  process.env.DLT_ENTITY_ID = "1101100000000012345";
  const calls = [];
  stubFetch({ status: 200, json: { messageRequestId: "req_abc" }, calls });

  const res = await new AirtelIqSmsProvider().send({
    to: "9876543210",
    body: "RoadCruise: Booking RC-1 CONFIRMED.",
    event: NotificationEvents.BOOKING_CONFIRMED,
  });

  assert.equal(res.status, "sent");
  assert.equal(res.providerMessageId, "req_abc");
  assert.match(calls[0].url, /\/gateway\/airtel-xchange\/v2\/sms\/send$/);
  const sent = JSON.parse(calls[0].opts.body);
  assert.equal(sent.dltTemplateId, TID);
  assert.equal(sent.entityId, "1101100000000012345");
  assert.equal(sent.sourceAddress, "RDCRSE");
  assert.equal(sent.messageType, "SERVICE_IMPLICIT");
  assert.deepEqual(sent.destinationAddress, ["919876543210"]); // 10-digit gets +91
  assert.match(calls[0].opts.headers.Authorization, /^Basic /);
});

test("airtel: an unregistered event fails PERMANENTLY instead of silently sending", async () => {
  stubFetch({ status: 200, json: { messageRequestId: "req_abc" } });
  await assert.rejects(
    () =>
      new AirtelIqSmsProvider().send({
        to: "9876543210",
        body: "x",
        event: NotificationEvents.BOOKING_CONFIRMED,
      }),
    (e) => e.retryable === false && /no DLT template id/i.test(e.message)
  );
});

test("airtel: 5xx is retryable, 4xx is terminal", async () => {
  process.env[envKeyFor("BOOKING_CONFIRMED")] = TID;
  const p = new AirtelIqSmsProvider();
  const send = () =>
    p.send({ to: "9876543210", body: "x", event: NotificationEvents.BOOKING_CONFIRMED });

  stubFetch({ status: 503, json: { errorMessage: "unavailable" } });
  await assert.rejects(send, (e) => e.retryable === true && e.statusCode === 503);

  stubFetch({ status: 401, json: { errorMessage: "bad creds" } });
  await assert.rejects(send, (e) => e.retryable === false && e.statusCode === 401);
});

test("airtel: a 200 carrying an errorCode is treated as a failure, not a send", async () => {
  process.env[envKeyFor("BOOKING_CONFIRMED")] = TID;
  stubFetch({ status: 200, json: { errorCode: "E01", errorMessage: "template mismatch" } });
  await assert.rejects(
    () =>
      new AirtelIqSmsProvider().send({
        to: "9876543210",
        body: "x",
        event: NotificationEvents.BOOKING_CONFIRMED,
      }),
    (e) => /template mismatch/.test(e.message)
  );
});

test("airtel: never leaks the recipient or credentials in an error", async () => {
  process.env[envKeyFor("BOOKING_CONFIRMED")] = TID;
  stubFetch({ status: 200, json: {} });
  await assert.rejects(
    () =>
      new AirtelIqSmsProvider().send({
        to: "abc",
        body: "x",
        event: NotificationEvents.BOOKING_CONFIRMED,
      }),
    (e) => !e.message.includes("abc") && !e.message.includes("cust_test") && e.retryable === false
  );
});

// -------------------- MSG91 uses a DIFFERENT id space --------------------
// config/dlt.js holds the 19-digit AIRTEL DLT ids (what Airtel IQ puts on the
// wire). MSG91's Flow API wants MSG91's own 24-char template id instead. Mixing
// them up is rejected by the gateway, so the two registries stay disjoint.
test("msg91: ignores DLT_TID_* and uses its own per-event MSG91 template id", async () => {
  process.env[envKeyFor("OTP_REQUESTED")] = TID; // Airtel id — must NOT be used
  process.env.MSG91_OTP_TEMPLATE_ID = "6a7359294976ac1599096612";
  // OTP ships BLOCKED until its MSG91 template is fixed; supply a resolved
  // mapping so this test can exercise the id-space separation it is about.
  process.env.MSG91_OTP_VARS = "otp=otp,company=companyName";
  const calls = [];
  stubFetch({ status: 200, json: { type: "success", request_id: "r1" }, calls });

  await new Msg91SmsProvider().send({
    to: "9876543210",
    body: "ignored — MSG91 renders the approved template itself",
    event: NotificationEvents.OTP_REQUESTED,
    vars: ["482913"],
    context: { otp: "482913", companyName: "RoadCruise" },
  });

  const sent = JSON.parse(calls[0].opts.body);
  assert.equal(sent.flow_id, "6a7359294976ac1599096612");
  assert.notEqual(sent.flow_id, TID, "the 19-digit Airtel DLT id must never reach MSG91");
  assert.deepEqual(sent.recipients[0], {
    mobiles: "919876543210",
    otp: "482913",
    company: "RoadCruise",
  });
  delete process.env.MSG91_OTP_TEMPLATE_ID;
  delete process.env.MSG91_OTP_VARS;
});

test("msg91: an event with no MSG91 template id fails permanently instead of sending", async () => {
  process.env[envKeyFor("BOOKING_CONFIRMED")] = TID; // approved on Airtel DLT only
  stubFetch({ status: 200, json: { type: "success", request_id: "r1" } });

  await assert.rejects(
    () =>
      new Msg91SmsProvider().send({
        to: "9876543210",
        body: "RoadCruise: Booking RC-1 CONFIRMED.",
        event: NotificationEvents.BOOKING_CONFIRMED,
        context: { bookingId: "RC-1" },
      }),
    (e) => e.retryable === false && /MSG91_BOOKING_TEMPLATE_ID/.test(e.message)
  );
});

// -------------------- the core invariant --------------------
// The operator matches the text we transmit against the REGISTERED template.
// So substituting our ordered vars back into the registered text must reproduce
// the rendered body byte-for-byte. If this fails, SMS silently stops being
// delivered (accepted with a 200, then dropped) — which is why it is a test.
test("every SMS template round-trips: registered DLT text + ordered vars === rendered body", async () => {
  const { smsTemplates } = await import("../templates/sms/index.js");
  const { render } = await import("../templates/engine.js");

  const ctx = {
    ...BRANDING,
    supportEmail: "info@roadcruise.in",
    websiteUrl: "https://roadcruise.in",
    customerName: "Arjun",
    bookingId: "RC-10231",
    vehicle: "Innova Crysta",
    tripDate: "12 Aug 2026",
    driver: "Ravi",
    paymentAmount: "4500",
    invoiceNumber: "INV-77",
    pickup: "Chennai",
    drop: "Pondicherry",
    otp: "482913",
  };

  for (const t of registrationSheet(BRANDING)) {
    const def = smsTemplates[t.event];
    const body = render(def, "sms", ctx).body;
    const vars = buildVars(typeof def === "function" ? def(ctx).text : def.text, ctx);
    let i = 0;
    const reconstructed = t.dltText.replace(/\{#var#\}/g, () => vars[i++]);
    assert.equal(reconstructed, body, `${t.constName}: transmitted body diverges from registered template`);
  }
});
