import { test } from "node:test";
import assert from "node:assert/strict";

import { signToken, verifyToken } from "../core/token.js";

// signToken/verifyToken are pure (HMAC over config.jwtSecret) and do NOT write
// db.json, so no snapshot/restore is needed here.

test("signToken/verifyToken round-trip preserves claims and adds iat/exp/jti", () => {
  const token = signToken({ sub: "token.roundtrip@example.com", role: "customer" });
  assert.equal(typeof token, "string");
  assert.equal(token.split(".").length, 3, "token is a 3-part JWT-like string");

  const res = verifyToken(token);
  assert.equal(res.valid, true);
  assert.equal(res.payload.sub, "token.roundtrip@example.com");
  assert.equal(res.payload.role, "customer");
  assert.equal(typeof res.payload.iat, "number");
  assert.equal(typeof res.payload.exp, "number");
  assert.equal(typeof res.payload.jti, "string");
  assert.ok(res.payload.exp > res.payload.iat, "exp is after iat");
});

test("tampered token (mutated payload segment) is invalid with bad_signature", () => {
  const token = signToken({ sub: "token.tamper@example.com", role: "customer" });
  const [head, body, sig] = token.split(".");

  // Flip a character in the payload segment without re-signing.
  const flip = (c) => (c === "A" ? "B" : "A");
  const tamperedBody = flip(body[0]) + body.slice(1);
  const tampered = `${head}.${tamperedBody}.${sig}`;
  assert.notEqual(tampered, token);

  const res = verifyToken(tampered);
  assert.equal(res.valid, false);
  assert.equal(res.reason, "bad_signature");
});

test("tampered signature is invalid", () => {
  const token = signToken({ sub: "token.tampersig@example.com" });
  const [head, body] = token.split(".");
  const res = verifyToken(`${head}.${body}.deadbeef`);
  assert.equal(res.valid, false);
  assert.equal(res.reason, "bad_signature");
});

test("expired token (negative ttlSec) reports reason 'expired'", () => {
  // Correctly signed but already expired.
  const token = signToken({ sub: "token.expired@example.com" }, { ttlSec: -10 });
  const res = verifyToken(token);
  assert.equal(res.valid, false);
  assert.equal(res.reason, "expired");
});

test("malformed token (not 3 parts) is invalid", () => {
  assert.equal(verifyToken("not-a-jwt").valid, false);
  assert.equal(verifyToken("only.two").reason, "malformed");
  assert.equal(verifyToken("a.b.c.d").reason, "malformed");
});

test("missing / non-string token is invalid with reason 'missing'", () => {
  assert.equal(verifyToken().reason, "missing");
  assert.equal(verifyToken("").reason, "missing");
  assert.equal(verifyToken(null).reason, "missing");
  assert.equal(verifyToken(123).reason, "missing");
});
