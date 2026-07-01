import { test } from "node:test";
import assert from "node:assert/strict";

import { signAccessToken, signRefreshToken, verifyTyped, verifyToken } from "../core/token.js";

// Typed access/refresh tokens are pure HMAC — no db writes, no snapshot needed.

test("signAccessToken produces a verifyTyped-valid 'access' token", () => {
  const token = signAccessToken({ email: "typed.access@example.com", role: "customer", tokenVersion: 0, sid: "sess_a" });
  const res = verifyTyped(token, "access");
  assert.equal(res.valid, true, "verifies as access");
  assert.equal(res.payload.type, "access");
  assert.equal(res.payload.email, "typed.access@example.com");
  assert.equal(res.payload.role, "customer");
  assert.equal(res.payload.sid, "sess_a");
});

test("signRefreshToken produces a verifyTyped-valid 'refresh' token", () => {
  const token = signRefreshToken({ email: "typed.refresh@example.com", tokenVersion: 0, sid: "sess_r", jti: "jti-1" });
  const res = verifyTyped(token, "refresh");
  assert.equal(res.valid, true, "verifies as refresh");
  assert.equal(res.payload.type, "refresh");
  assert.equal(res.payload.sid, "sess_r");
});

test("verifyTyped rejects a token of the wrong type", () => {
  const access = signAccessToken({ email: "typed.wrong@example.com", role: "customer", sid: "sess_w" });
  const res = verifyTyped(access, "refresh");
  assert.equal(res.valid, false, "an access token is not a valid refresh token");
  assert.equal(res.reason, "wrong_type");
});

test("a provided jti in the refresh token is preserved (rotation-bug guard)", () => {
  const jti = "rotation-jti-abc123";
  const token = signRefreshToken({ email: "typed.jti@example.com", tokenVersion: 0, sid: "sess_j", jti });
  const res = verifyToken(token);
  assert.equal(res.valid, true);
  assert.equal(res.payload.jti, jti, "the caller-provided jti round-trips (not regenerated)");
});
