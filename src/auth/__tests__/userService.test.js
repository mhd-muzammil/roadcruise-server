import { test, before } from "node:test";
import assert from "node:assert/strict";

import {
  sanitize,
  findByEmail,
  findByGoogleId,
  createFromGoogle,
  linkGoogle,
} from "../core/userService.js";
import { useTempDb, seedUser as seedLocalUser, countUsers } from "../../db/testSupport.js";

// Each run uses an isolated, empty temp SQLite DB (never the real one). Every
// test uses UNIQUE emails/subs so they are independent.
before(() => useTempDb());

test("createFromGoogle creates a customer with additive Google fields and no password", () => {
  const email = "us.create@example.com";
  const profile = {
    provider: "google",
    sub: "us-create-sub",
    email,
    emailVerified: true,
    name: "US Create",
    picture: "https://example.com/us.png",
  };

  const user = createFromGoogle(profile);

  assert.equal(user.email, email);
  assert.equal(user.role, "customer");
  assert.equal(user.provider, "google");
  assert.equal(user.googleId, "us-create-sub");
  assert.equal(user.avatar, "https://example.com/us.png");
  assert.equal(user.emailVerified, true);
  assert.deepEqual(user.providers, ["google"]);
  assert.equal(user.password, null, "Google-only account has null password");

  // Locatable by both email and googleId.
  assert.equal(findByEmail(email)?.email, email);
  assert.equal(findByGoogleId("us-create-sub")?.email, email);
  assert.equal(countUsers(email), 1);
});

test("createFromGoogle derives name from email local-part when name is absent", () => {
  const email = "us.noname@example.com";
  const user = createFromGoogle({ sub: "us-noname-sub", email, emailVerified: true });
  assert.equal(user.name, "us.noname");
});

test("findByEmail is case-insensitive; findByGoogleId returns null for unknown id", () => {
  const email = "us.find@example.com";
  createFromGoogle({ sub: "us-find-sub", email, emailVerified: true });
  assert.equal(findByEmail("US.FIND@EXAMPLE.COM")?.googleId, "us-find-sub");
  assert.equal(findByGoogleId("nope-does-not-exist"), null);
});

test("linkGoogle onto an existing LOCAL user preserves password+role and merges providers", () => {
  const email = "us.link@example.com";
  seedLocalUser({
    name: "Local Linker",
    email,
    password: "secret-local-pw",
    role: "manager",
    phone: "+91 90000 00000",
    provider: "local",
    authProvider: "local",
    providers: ["local"],
  });

  const existing = findByEmail(email);
  assert.ok(existing, "seeded local user is present");

  const linked = linkGoogle(existing, {
    sub: "us-link-google-sub",
    email,
    emailVerified: true,
    picture: "https://example.com/link.png",
  });

  assert.equal(linked.googleId, "us-link-google-sub");
  assert.equal(linked.emailVerified, true);
  assert.equal(linked.password, "secret-local-pw", "existing local password preserved");
  assert.equal(linked.role, "manager", "existing role preserved");
  assert.ok(linked.providers.includes("local"), "providers include 'local'");
  assert.ok(linked.providers.includes("google"), "providers include 'google'");

  // No duplicate row was created — still exactly one user with this email.
  assert.equal(countUsers(email), 1);
  assert.equal(findByGoogleId("us-link-google-sub")?.email, email);
});

test("sanitize strips the password field", () => {
  const safe = sanitize({ email: "us.sanitize@example.com", password: "hunter2", role: "customer" });
  assert.equal("password" in safe, false);
  assert.equal(safe.email, "us.sanitize@example.com");
  assert.equal(safe.role, "customer");
  // Non-mutating: original is unaffected other than being copied.
  assert.equal(sanitize(null), null);
});
