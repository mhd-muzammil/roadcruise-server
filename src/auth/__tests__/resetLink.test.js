import { test } from "node:test";
import assert from "node:assert/strict";

import { appLink } from "../core/AuthService.js";
import { config, normalizeAppBaseUrl } from "../config/auth.config.js";

// Regression tests for the emailed-link builder. The original bug: APP_BASE_URL
// was documented as needing a trailing "/#" for the client's HashRouter, but
// dotenv truncates unquoted values at "#" (inline-comment rule), so links were
// emitted WITHOUT the hash (https://site//reset-password?…) and the SPA served
// the homepage instead of the reset page. The hash fragment is now appended in
// code and the env value is normalized to a bare origin.

test("normalizeAppBaseUrl strips every trailing '/', '#', '/#' variant", () => {
  const want = "https://roadcruise-client.vercel.app";
  for (const raw of [want, `${want}/`, `${want}/#`, `${want}/#/`, `${want}//`, ` ${want}/# `]) {
    assert.equal(normalizeAppBaseUrl(raw), want, `raw=${JSON.stringify(raw)}`);
  }
});

test("normalizeAppBaseUrl falls back to the dev origin when unset", () => {
  assert.equal(normalizeAppBaseUrl(undefined), "http://localhost:5173");
  assert.equal(normalizeAppBaseUrl(""), "http://localhost:5173");
});

test("config.appBaseUrl is a bare origin (no trailing '/' or '#')", () => {
  assert.ok(!/[/#]$/.test(config.appBaseUrl), `got ${config.appBaseUrl}`);
});

test("appLink builds a HashRouter URL with encoded query params", () => {
  const link = appLink("/reset-password", { email: "user+tag@example.com", token: "abc123DEF" });
  assert.equal(
    link,
    `${config.appBaseUrl}/#/reset-password?email=user%2Btag%40example.com&token=abc123DEF`
  );
});

test("appLink never emits the broken hash-less shape", () => {
  const link = appLink("/reset-password", { email: "a@b.c", token: "t" });
  assert.ok(link.includes("/#/reset-password?"), "hash fragment present");
  assert.ok(!link.includes("//reset-password"), "no hash-less double-slash path");
});

test("appLink without params emits no query string", () => {
  assert.equal(appLink("/reset-password"), `${config.appBaseUrl}/#/reset-password`);
});
