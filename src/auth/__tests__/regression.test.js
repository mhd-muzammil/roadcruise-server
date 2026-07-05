import { test, before } from "node:test";
import assert from "node:assert/strict";

import { EmailPasswordProvider } from "../providers/EmailPasswordProvider.js";
import { useTempDb, seedUser } from "../../db/testSupport.js";

// REGRESSION guard: proves the existing local email/password login still works
// through the provider abstraction (which mirrors the live login's plaintext
// comparison exactly). Runs against an isolated temp DB seeded with a
// deterministic admin (decoupled from the mutable real db.json).
const local = new EmailPasswordProvider();

before(() => {
  useTempDb();
  seedUser({ name: "Admin Mohamed", email: "admin@roadcruise.com", password: "admin123", role: "admin" });
});

test("seeded admin (admin@roadcruise.com / admin123) authenticates successfully", async () => {
  const profile = await local.authenticate({ email: "admin@roadcruise.com", password: "admin123" });
  assert.equal(profile.provider, "local");
  assert.equal(profile.email, "admin@roadcruise.com");
  assert.equal(profile.name, "Admin Mohamed");
});

test("wrong password for the admin throws INVALID_CREDENTIALS", async () => {
  await assert.rejects(
    () => local.authenticate({ email: "admin@roadcruise.com", password: "wrong-password" }),
    (err) => {
      assert.equal(err.code, "INVALID_CREDENTIALS");
      return true;
    }
  );
});

test("unknown email throws INVALID_CREDENTIALS", async () => {
  await assert.rejects(
    () => local.authenticate({ email: "nobody@nowhere.example", password: "whatever" }),
    (err) => {
      assert.equal(err.code, "INVALID_CREDENTIALS");
      return true;
    }
  );
});

test("Google-only user (password null) cannot log in via email/password", async () => {
  const email = "reg.googleonly@example.com";
  seedUser({
    name: "Reg GoogleOnly",
    email,
    password: null,
    role: "customer",
    phone: "+91 92222 22222",
    provider: "google",
    authProvider: "google",
    providers: ["google"],
    googleId: "reg-googleonly-sub",
  });

  await assert.rejects(
    () => local.authenticate({ email, password: "anything" }),
    (err) => {
      assert.equal(err.code, "INVALID_CREDENTIALS", "null-password account is not locally authenticatable");
      return true;
    }
  );
});
