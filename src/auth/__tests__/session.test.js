import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import {
  createSession,
  findById,
  listForUser,
  rotateJti,
  revoke,
  revokeAllForUser,
  isActive,
  parseUserAgent,
} from "../core/sessionStore.js";

// sessionStore WRITES src/auth/data/sessions.json (its own store, not db.json).
// Snapshot/restore those exact bytes so the file is left untouched. It does NOT
// touch src/config/db.json. Every test uses a UNIQUE user email.
const __filename = fileURLToPath(import.meta.url);
const SESSIONS_PATH = path.resolve(path.dirname(__filename), "../data/sessions.json");

let sessionsSnapshot;

before(() => {
  sessionsSnapshot = fs.readFileSync(SESSIONS_PATH);
});

after(() => {
  fs.writeFileSync(SESSIONS_PATH, sessionsSnapshot);
});

const CHROME_WIN =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

test("parseUserAgent extracts browser/os/device", () => {
  assert.deepEqual(parseUserAgent(CHROME_WIN), { browser: "Chrome", os: "Windows", device: "Desktop" });
  assert.deepEqual(parseUserAgent(SAFARI_IPHONE), { browser: "Safari", os: "iOS", device: "Mobile" });
});

test("createSession stores device/browser/os parsed from the User-Agent", async () => {
  const s = await createSession({ userEmail: "sess.create@example.com", userAgent: CHROME_WIN, refreshJti: "jti-c" });
  assert.equal(s.browser, "Chrome");
  assert.equal(s.os, "Windows");
  assert.equal(s.device, "Desktop");
  assert.equal(s.userEmail, "sess.create@example.com");
  assert.equal(s.refreshJti, "jti-c");
  assert.equal(s.revoked, false);
  assert.equal(isActive(s), true, "a fresh session is active");
  assert.deepEqual(findById(s.sessionId), s, "persisted and retrievable by id");
});

test("listForUser returns active sessions only", async () => {
  const email = "sess.list@example.com";
  const a = await createSession({ userEmail: email, userAgent: CHROME_WIN, refreshJti: "jti-a" });
  const b = await createSession({ userEmail: email, userAgent: CHROME_WIN, refreshJti: "jti-b" });

  let active = listForUser(email);
  assert.equal(active.length, 2, "both sessions active initially");

  await revoke(b.sessionId);
  active = listForUser(email);
  assert.equal(active.length, 1, "revoked session excluded from active list");
  assert.equal(active[0].sessionId, a.sessionId);

  const all = listForUser(email, { includeInactive: true });
  assert.equal(all.length, 2, "includeInactive returns the revoked one too");
});

test("rotateJti changes the session's refreshJti", async () => {
  const s = await createSession({ userEmail: "sess.rotate@example.com", userAgent: CHROME_WIN, refreshJti: "old-jti" });
  await rotateJti(s.sessionId, "new-jti");
  const after = findById(s.sessionId);
  assert.equal(after.refreshJti, "new-jti", "jti rotated");
  assert.notEqual(after.refreshJti, "old-jti");
});

test("revoke marks the session revoked (isActive false)", async () => {
  const s = await createSession({ userEmail: "sess.revoke@example.com", userAgent: CHROME_WIN, refreshJti: "jti-x" });
  assert.equal(isActive(findById(s.sessionId)), true);
  await revoke(s.sessionId, "user");
  const after = findById(s.sessionId);
  assert.equal(after.revoked, true);
  assert.equal(after.revokedBy, "user");
  assert.equal(isActive(after), false, "revoked session is not active");
});

test("revokeAllForUser revokes every active session for the user", async () => {
  const email = "sess.revokeall@example.com";
  await createSession({ userEmail: email, userAgent: CHROME_WIN, refreshJti: "j1" });
  await createSession({ userEmail: email, userAgent: CHROME_WIN, refreshJti: "j2" });
  await createSession({ userEmail: email, userAgent: CHROME_WIN, refreshJti: "j3" });

  const count = await revokeAllForUser(email, "logout_all");
  assert.equal(count, 3, "all three active sessions revoked");
  assert.equal(listForUser(email).length, 0, "no active sessions remain");
});
