import { test } from "node:test";
import assert from "node:assert/strict";

import { appLink } from "../core/AuthService.js";
import { config, normalizeAppBaseUrl } from "../config/auth.config.js";

// Regression tests for the emailed-link builder. The client migrated from
// HashRouter to BrowserRouter, so emitted links are now clean paths
// (https://site/reset-password?…) with no "#" fragment. APP_BASE_URL is still
// normalized to a bare origin because dotenv truncates unquoted values at "#"
// (inline-comment rule); the route path is always appended in code. Old
// HashRouter links still resolve via the client's compatibility shim.

test("normalizeAppBaseUrl strips every trailing '/', '#', '/#' variant", () => {
  const want = "https://roadcruise.in";
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

test("appLink builds a BrowserRouter clean-path URL with encoded query params", () => {
  const link = appLink("/reset-password", { email: "user+tag@example.com", token: "abc123DEF" });
  assert.equal(
    link,
    `${config.appBaseUrl}/reset-password?email=user%2Btag%40example.com&token=abc123DEF`
  );
});

test("appLink emits a clean path with no '#' fragment or double slash", () => {
  const link = appLink("/reset-password", { email: "a@b.c", token: "t" });
  assert.ok(link.includes("/reset-password?"), "clean route path present");
  assert.ok(!link.includes("#"), "no hash fragment");
  assert.ok(!link.includes("//reset-password"), "no double-slash path");
});

test("appLink without params emits no query string", () => {
  assert.equal(appLink("/reset-password"), `${config.appBaseUrl}/reset-password`);
});
