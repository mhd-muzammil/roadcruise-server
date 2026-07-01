import { test } from "node:test";
import assert from "node:assert/strict";

import { hashPassword, verifyPassword, isLegacyPlaintext } from "../core/password.js";
import { validatePassword } from "../core/passwordPolicy.js";

// Pure crypto/policy — no db writes, no snapshot needed. Assumes default
// AUTH_PASSWORD_ALGO (scrypt), the zero-dep built-in.

test("hashPassword produces a self-describing scrypt$ hash", async () => {
  const hash = await hashPassword("Str0ng!Pass");
  assert.ok(hash.startsWith("scrypt$"), `expected scrypt$ prefix, got: ${hash.slice(0, 12)}`);
  // scrypt$N$r$p$salt$hash => 6 dollar-delimited parts
  assert.equal(hash.split("$").length, 6, "scrypt hash has algo+params+salt+digest segments");
});

test("verifyPassword is true for the correct password, false for a wrong one", async () => {
  const hash = await hashPassword("Str0ng!Pass");
  assert.equal(await verifyPassword("Str0ng!Pass", hash), true, "correct password verifies");
  assert.equal(await verifyPassword("wrong-password", hash), false, "wrong password rejected");
});

test("verifyPassword accepts a legacy PLAINTEXT stored value and rejects a wrong one", async () => {
  const stored = "legacy-plaintext-pw";
  assert.equal(isLegacyPlaintext(stored), true, "plaintext has no recognized hash prefix");
  assert.equal(await verifyPassword("legacy-plaintext-pw", stored), true, "matching plaintext verifies");
  assert.equal(await verifyPassword("nope", stored), false, "wrong plaintext rejected");
});

test("a scrypt hash is NOT flagged as legacy plaintext", async () => {
  const hash = await hashPassword("Str0ng!Pass");
  assert.equal(isLegacyPlaintext(hash), false, "scrypt$ hash is not legacy");
});

test("validatePassword rejects a weak password with a message", () => {
  const res = validatePassword("abc");
  assert.equal(res.ok, false, "weak password rejected");
  assert.ok(Array.isArray(res.errors) && res.errors.length > 0, "errors listed");
  assert.equal(typeof res.message, "string");
  assert.ok(res.message.length > 0, "a human-readable message is returned");
});

test("validatePassword accepts a strong password", () => {
  const res = validatePassword("Str0ng!Pass");
  assert.equal(res.ok, true, "strong password accepted");
  assert.deepEqual(res.errors, []);
  assert.equal(res.message, null);
});
