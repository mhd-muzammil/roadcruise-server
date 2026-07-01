import { test } from "node:test";
import assert from "node:assert/strict";

import { issueNonce, consumeNonce } from "../core/nonceStore.js";

// nonceStore is an in-memory Map; it does NOT write db.json.

test("issueNonce returns unique, non-empty values", () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const n = issueNonce();
    assert.equal(typeof n, "string");
    assert.ok(n.length > 0);
    assert.ok(!seen.has(n), "nonce is unique");
    seen.add(n);
  }
});

test("consumeNonce is single-use: true once, then false on replay", () => {
  const n = issueNonce();
  assert.equal(consumeNonce(n), true, "first consume succeeds");
  assert.equal(consumeNonce(n), false, "replay of the same nonce is burned");
});

test("consumeNonce returns false for unknown / empty / null nonce", () => {
  assert.equal(consumeNonce("never-issued-nonce-xyz"), false);
  assert.equal(consumeNonce(""), false);
  assert.equal(consumeNonce(null), false);
  assert.equal(consumeNonce(undefined), false);
});

test("burning one nonce does not affect a different issued nonce", () => {
  const a = issueNonce();
  const b = issueNonce();
  assert.equal(consumeNonce(a), true);
  assert.equal(consumeNonce(b), true, "second, independent nonce still valid");
  assert.equal(consumeNonce(a), false);
  assert.equal(consumeNonce(b), false);
});
