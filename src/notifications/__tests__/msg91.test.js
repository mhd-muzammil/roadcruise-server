import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import config from "../config/notification.config.js";
import { Msg91SmsProvider } from "../providers/sms/Msg91SmsProvider.js";
import { validateProviderConfig } from "../index.js";
import { Channels } from "../config/events.js";

// The MSG91 provider reads config.msg91 lazily at send time, so we populate the
// (unfrozen) config object for the suite and restore it after. globalThis.fetch
// is stubbed per-test so no real HTTP is made.
const origFetch = globalThis.fetch;
const origMsg91 = { ...config.msg91 };

before(() => {
  Object.assign(config.msg91, {
    authKey: "test-auth-key",
    senderId: "RDCRSE",
    templateId: "test-template-id",
    baseUrl: "https://control.msg91.com",
    bodyVar: "body",
    defaultCountryCode: "91",
    timeoutMs: 60,
  });
});
after(() => {
  globalThis.fetch = origFetch;
  Object.assign(config.msg91, origMsg91);
});
beforeEach(() => {
  globalThis.fetch = origFetch;
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

// -------------------- success --------------------
test("success: returns providerMessageId + status sent, calls MSG91 v5 flow API", async () => {
  const calls = [];
  stubFetch({ status: 200, json: { type: "success", request_id: "req_123" }, calls });

  const res = await provider.send({ to: "9876543210", body: "Hello" });

  assert.equal(res.status, "sent");
  assert.equal(res.providerMessageId, "req_123");
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/v5\/flow\/$/);
  const sentBody = JSON.parse(calls[0].opts.body);
  assert.equal(sentBody.template_id, "test-template-id");
  assert.equal(sentBody.recipients[0].mobiles, "919876543210"); // 10-digit -> +CC
  assert.equal(sentBody.recipients[0].body, "Hello"); // rendered text in bodyVar
  assert.equal(calls[0].opts.headers.authkey, "test-auth-key");
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
  globalThis.fetch = async () => { called = true; return { ok: true, status: 200, json: async () => ({}) }; };

  await assert.rejects(
    () => provider.send({ to: "not-a-number", body: "x" }),
    (err) => { assert.equal(err.retryable, false); return true; }
  );
  assert.equal(called, false, "must not hit the network for an invalid recipient");
});

// -------------------- 401 (terminal) --------------------
test("HTTP 401: throws NON-retryable (bad credentials never succeed on retry)", async () => {
  stubFetch({ status: 401, json: { message: "unauthorized" } });
  await assert.rejects(
    () => provider.send({ to: "9876543210", body: "x" }),
    (err) => {
      assert.equal(err.retryable, false);
      assert.equal(err.statusCode, 401);
      assert.doesNotMatch(err.message, /test-auth-key/, "must never leak the auth key");
      return true;
    }
  );
});

// -------------------- retry classification --------------------
for (const status of [400, 403, 404]) {
  test(`HTTP ${status}: classified NON-retryable`, async () => {
    stubFetch({ status, json: { message: "client error" } });
    await assert.rejects(
      () => provider.send({ to: "9876543210", body: "x" }),
      (err) => { assert.equal(err.retryable, false); assert.equal(err.statusCode, status); return true; }
    );
  });
}
for (const status of [408, 429, 500, 502, 503, 504]) {
  test(`HTTP ${status}: classified RETRYABLE (transient)`, async () => {
    stubFetch({ status, json: { message: "transient" } });
    await assert.rejects(
      () => provider.send({ to: "9876543210", body: "x" }),
      (err) => { assert.equal(err.retryable, true); assert.equal(err.statusCode, status); return true; }
    );
  });
}

test("HTTP 200 with logical error (bad template) is NON-retryable", async () => {
  stubFetch({ status: 200, json: { type: "error", message: "invalid template" } });
  await assert.rejects(
    () => provider.send({ to: "9876543210", body: "x" }),
    (err) => { assert.equal(err.retryable, false); return true; }
  );
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

  await assert.rejects(
    () => provider.send({ to: "9876543210", body: "x" }),
    (err) => { assert.equal(err.retryable, true); assert.match(err.message, /timed out/); return true; }
  );
});

// -------------------- network error --------------------
test("network error: throws RETRYABLE", async () => {
  globalThis.fetch = async () => { throw new Error("ECONNRESET"); };
  await assert.rejects(
    () => provider.send({ to: "9876543210", body: "x" }),
    (err) => { assert.equal(err.retryable, true); return true; }
  );
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

// -------------------- configuration validation --------------------
test("validation: msg91 selected but missing key/template -> errors (fail closed)", () => {
  const errs = validateProviderConfig({
    providers: { [Channels.SMS]: "msg91" },
    msg91: { authKey: "", templateId: "" },
  });
  assert.equal(errs.length, 2);
  assert.match(errs.join(" "), /MSG91_API_KEY/);
  assert.match(errs.join(" "), /MSG91_TEMPLATE_ID/);
});

test("validation: «CHANGEME» placeholders count as unset", () => {
  const errs = validateProviderConfig({
    providers: { [Channels.SMS]: "msg91" },
    msg91: { authKey: "real-key", templateId: "«CHANGEME_template»" },
  });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /MSG91_TEMPLATE_ID/);
});

test("validation: fully configured msg91 -> no errors", () => {
  const errs = validateProviderConfig({
    providers: { [Channels.SMS]: "msg91" },
    msg91: { authKey: "real-key", templateId: "real-template" },
  });
  assert.deepEqual(errs, []);
});

test("validation: another provider selected -> always valid (mock default boots)", () => {
  const errs = validateProviderConfig({
    providers: { [Channels.SMS]: "mock" },
    msg91: { authKey: "", templateId: "" },
  });
  assert.deepEqual(errs, []);
});
