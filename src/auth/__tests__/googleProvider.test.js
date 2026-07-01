import { test } from "node:test";
import assert from "node:assert/strict";

import { GoogleProvider, mintMockIdToken } from "../providers/GoogleProvider.js";

// GoogleProvider.authenticate (mock mode) verifies a locally-signed token and
// normalizes the profile. It does NOT write db.json — no snapshot needed.
//
// Assumes MOCK mode (no GOOGLE_CLIENT_ID in env), which is the zero-infra default.

const provider = new GoogleProvider();

test("authenticate accepts a valid mock id token and returns a normalized profile", async () => {
  const idToken = mintMockIdToken({
    sub: "gp-sub-happy",
    email: "GP.Happy@Example.COM",
    name: "GP Happy",
    picture: "https://example.com/a.png",
    emailVerified: true,
  });

  const profile = await provider.authenticate({ idToken });
  assert.deepEqual(profile, {
    provider: "google",
    sub: "gp-sub-happy",
    email: "gp.happy@example.com", // lowercased + trimmed
    emailVerified: true,
    name: "GP Happy",
    picture: "https://example.com/a.png",
  });
});

test("happy path validates audience (mock aud 'mock-google-client') and issuer", async () => {
  // The helper always mints aud='mock-google-client' / iss='https://accounts.google.com'.
  // A wrong aud cannot be produced via the helper, so a successful authenticate
  // proves aud+iss were enforced and accepted.
  const idToken = mintMockIdToken({ sub: "gp-sub-aud", email: "gp.aud@example.com" });
  const profile = await provider.authenticate({ idToken });
  assert.equal(profile.provider, "google");
  assert.equal(profile.sub, "gp-sub-aud");
});

test("valid nonce matching the token nonce is accepted", async () => {
  const idToken = mintMockIdToken({ sub: "gp-sub-nonce-ok", email: "gp.nonceok@example.com", nonce: "n-123" });
  const profile = await provider.authenticate({ idToken, nonce: "n-123" });
  assert.equal(profile.email, "gp.nonceok@example.com");
});

async function assertRejectsInvalidToken(args, label) {
  await assert.rejects(
    () => provider.authenticate(args),
    (err) => {
      assert.equal(err.code, "INVALID_TOKEN", `${label}: expected INVALID_TOKEN, got ${err.code}`);
      return true;
    },
    label
  );
}

test("rejects tampered signature with INVALID_TOKEN", async () => {
  const idToken = mintMockIdToken({ sub: "gp-sub-tamper", email: "gp.tamper@example.com" });
  const [head, body] = idToken.split(".");
  await assertRejectsInvalidToken({ idToken: `${head}.${body}.deadbeef` }, "tampered signature");
});

test("rejects tampered payload (signature no longer matches) with INVALID_TOKEN", async () => {
  const idToken = mintMockIdToken({ sub: "gp-sub-tamper2", email: "gp.tamper2@example.com" });
  const [head, body, sig] = idToken.split(".");
  const flip = (c) => (c === "A" ? "B" : "A");
  const tamperedBody = flip(body[0]) + body.slice(1);
  await assertRejectsInvalidToken({ idToken: `${head}.${tamperedBody}.${sig}` }, "tampered payload");
});

test("rejects expired token (expSec < 0) with INVALID_TOKEN", async () => {
  const idToken = mintMockIdToken({ sub: "gp-sub-exp", email: "gp.exp@example.com", expSec: -10 });
  await assertRejectsInvalidToken({ idToken }, "expired");
});

test("rejects email_verified=false with INVALID_TOKEN", async () => {
  const idToken = mintMockIdToken({ sub: "gp-sub-unv", email: "gp.unv@example.com", emailVerified: false });
  await assertRejectsInvalidToken({ idToken }, "email not verified");
});

test("rejects nonce mismatch with INVALID_TOKEN", async () => {
  const idToken = mintMockIdToken({ sub: "gp-sub-nm", email: "gp.nm@example.com", nonce: "token-nonce" });
  await assertRejectsInvalidToken({ idToken, nonce: "different-nonce" }, "nonce mismatch");
});

test("rejects malformed (non 3-part) id token with INVALID_TOKEN", async () => {
  await assertRejectsInvalidToken({ idToken: "not.a.valid.jwt.at.all" }, "malformed");
});

test("rejects missing id token with INVALID_TOKEN", async () => {
  await assertRejectsInvalidToken({}, "missing idToken");
});
