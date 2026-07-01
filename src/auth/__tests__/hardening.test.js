import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { getAuthService } from "../core/AuthService.js";
import { storedCredential, setResetToken, setVerificationToken, findByEmail } from "../core/userService.js";
import { config } from "../config/auth.config.js";

// AuthService.authenticateLocal / registerLocal / resetPassword / verifyEmail WRITE
// src/config/db.json (users) via userService, and sessionStore writes
// src/auth/data/sessions.json. Snapshot the exact bytes of BOTH before the suite
// and restore after, so both files are left byte-identical. Every test uses a
// UNIQUE email. Assumes default flags (refreshToken/passwordReset on) and default
// lockout (maxAttempts=5).
const __filename = fileURLToPath(import.meta.url);
const DB_PATH = path.resolve(path.dirname(__filename), "../../config/db.json");
const SESSIONS_PATH = path.resolve(path.dirname(__filename), "../data/sessions.json");

const auth = getAuthService();
let dbSnapshot;
let sessionsSnapshot;

before(() => {
  dbSnapshot = fs.readFileSync(DB_PATH);
  sessionsSnapshot = fs.readFileSync(SESSIONS_PATH);
});

after(() => {
  fs.writeFileSync(DB_PATH, dbSnapshot);
  fs.writeFileSync(SESSIONS_PATH, sessionsSnapshot);
});

/** Seed a raw user row directly into db.json (used for legacy plaintext accounts). */
function seedUser(user) {
  const db = JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
  db.users.push(user);
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf-8");
}

/** Read the raw persisted user row (bypassing sanitize) for internal assertions. */
function rawUser(email) {
  const db = JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
  return db.users.find((u) => String(u.email).toLowerCase() === email.toLowerCase()) || null;
}

test("authenticateLocal migrates a legacy PLAINTEXT user to a scrypt hash", async () => {
  const email = "hard.migrate@example.com";
  seedUser({ name: "Legacy Migrate", email, password: "Legacy!Pass1", role: "customer", provider: "local" });

  const res = await auth.authenticateLocal({ email, password: "Legacy!Pass1" });
  assert.equal(res.user.email, email, "login succeeds");
  assert.equal("password" in res.user, false, "returned user is sanitized");
  assert.equal("passwordHash" in res.user, false, "returned user has no passwordHash");
  assert.ok(res.accessToken, "access token issued");

  const migrated = rawUser(email);
  assert.equal(migrated.password, undefined, "legacy plaintext removed");
  assert.ok(String(storedCredential(migrated)).startsWith("scrypt$"), "credential is now a scrypt hash");
  assert.equal(migrated.passwordMigrated, true, "flagged migrated");

  // A second login still succeeds against the migrated hash.
  const second = await auth.authenticateLocal({ email, password: "Legacy!Pass1" });
  assert.equal(second.user.email, email, "second login against migrated hash succeeds");
});

test("wrong password increments failedLoginAttempts and locks after maxAttempts", async () => {
  const email = "hard.lock@example.com";
  seedUser({ name: "Lock Me", email, password: "Correct!Pass1", role: "customer", provider: "local" });

  const max = config.lockout.maxAttempts; // 5 by default
  // (max - 1) wrong attempts: rejected as INVALID_CREDENTIALS, not yet locked.
  for (let i = 0; i < max - 1; i++) {
    await assert.rejects(
      () => auth.authenticateLocal({ email, password: "wrong" }),
      (e) => e.code === "INVALID_CREDENTIALS"
    );
  }
  assert.equal(rawUser(email).failedLoginAttempts, max - 1, "attempts counted");

  // The max-th wrong attempt locks the account (still surfaced as INVALID_CREDENTIALS).
  await assert.rejects(
    () => auth.authenticateLocal({ email, password: "wrong" }),
    (e) => e.code === "INVALID_CREDENTIALS"
  );
  const locked = rawUser(email);
  assert.equal(locked.failedLoginAttempts >= max, true, "reached max attempts");
  assert.ok(locked.lockedUntil, "lockedUntil set");

  // Now even the CORRECT password is refused with ACCOUNT_LOCKED.
  await assert.rejects(
    () => auth.authenticateLocal({ email, password: "Correct!Pass1" }),
    (e) => {
      assert.equal(e.code, "ACCOUNT_LOCKED", `expected ACCOUNT_LOCKED, got ${e.code}`);
      return true;
    }
  );
});

test("registerLocal rejects a weak password with WEAK_PASSWORD", async () => {
  await assert.rejects(
    () => auth.registerLocal({ name: "Weak", email: "hard.weak@example.com", password: "abc" }),
    (e) => {
      assert.equal(e.code, "WEAK_PASSWORD");
      return true;
    }
  );
  assert.equal(rawUser("hard.weak@example.com"), null, "no user created on weak password");
});

test("registerLocal rejects a duplicate email with EMAIL_EXISTS", async () => {
  const email = "hard.dup@example.com";
  await auth.registerLocal({ name: "First", email, password: "Str0ng!Pass" });
  await assert.rejects(
    () => auth.registerLocal({ name: "Second", email, password: "Str0ng!Pass" }),
    (e) => {
      assert.equal(e.code, "EMAIL_EXISTS");
      return true;
    }
  );
});

test("registerLocal success returns a sanitized user + access + refresh tokens", async () => {
  const email = "hard.register@example.com";
  const res = await auth.registerLocal({ name: "Reg User", email, password: "Str0ng!Pass" });
  assert.equal(res.user.email, email);
  assert.equal(res.user.role, "customer");
  assert.equal("password" in res.user, false, "no plaintext in response");
  assert.equal("passwordHash" in res.user, false, "no passwordHash in response");
  assert.equal(typeof res.accessToken, "string");
  assert.equal(typeof res.refreshToken, "string", "refresh token issued (flag on)");

  // Persisted credential is a scrypt hash, never plaintext.
  assert.ok(String(storedCredential(rawUser(email))).startsWith("scrypt$"));
});

test("refresh rotates the refresh token; reusing the OLD one throws TOKEN_REUSE", async () => {
  const email = "hard.refresh@example.com";
  const reg = await auth.registerLocal({ name: "Refresh User", email, password: "Str0ng!Pass" });
  const originalRefresh = reg.refreshToken;

  const rotated = await auth.refresh({ refreshToken: originalRefresh });
  assert.equal(typeof rotated.accessToken, "string");
  assert.equal(typeof rotated.refreshToken, "string");
  assert.notEqual(rotated.refreshToken, originalRefresh, "a new refresh token is issued");

  // The new refresh token works.
  const again = await auth.refresh({ refreshToken: rotated.refreshToken });
  assert.equal(typeof again.refreshToken, "string");

  // Reusing the ORIGINAL (already-rotated) refresh token is detected as reuse.
  await assert.rejects(
    () => auth.refresh({ refreshToken: originalRefresh }),
    (e) => {
      assert.equal(e.code, "TOKEN_REUSE", `expected TOKEN_REUSE, got ${e.code}`);
      return true;
    }
  );
});

test("resetPassword with a valid single-use token succeeds and bumps tokenVersion", async () => {
  const email = "hard.reset@example.com";
  await auth.registerLocal({ name: "Reset User", email, password: "Str0ng!Pass" });
  const beforeVersion = rawUser(email).tokenVersion || 0;

  const token = "reset-token-xyz";
  setResetToken(email, token);

  const res = await auth.resetPassword({ email, token, newPassword: "NewStr0ng!Pass" });
  assert.equal(res.ok, true, "reset succeeds");
  assert.equal(rawUser(email).tokenVersion, beforeVersion + 1, "tokenVersion bumped (invalidates old tokens)");

  // New password now authenticates.
  const login = await auth.authenticateLocal({ email, password: "NewStr0ng!Pass" });
  assert.equal(login.user.email, email);

  // Reusing the same reset token fails (single-use).
  await assert.rejects(
    () => auth.resetPassword({ email, token, newPassword: "Another!Pass1" }),
    (e) => {
      assert.equal(e.code, "INVALID_TOKEN", `expected INVALID_TOKEN, got ${e.code}`);
      return true;
    }
  );
});

test("verifyEmail with a valid token sets emailVerified", async () => {
  const email = "hard.verify@example.com";
  await auth.registerLocal({ name: "Verify User", email, password: "Str0ng!Pass" });
  assert.notEqual(rawUser(email).emailVerified, true, "starts unverified");

  const token = "verify-token-abc";
  setVerificationToken(email, token);

  const res = await auth.verifyEmail({ email, token });
  assert.equal(res.ok, true);
  assert.equal(rawUser(email).emailVerified, true, "email marked verified");

  // Sanity: findByEmail reflects the change.
  assert.equal(findByEmail(email).emailVerified, true);
});
