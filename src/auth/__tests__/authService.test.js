import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { getAuthService } from "../core/AuthService.js";
import { mintMockIdToken } from "../providers/GoogleProvider.js";

// AuthService.authenticateWithGoogle -> createFromGoogle/linkGoogle/touchLastLogin
// WRITE src/config/db.json. Snapshot the exact bytes before the suite and restore
// after. Every test uses UNIQUE emails/subs so tests are independent.
// Assumes MOCK Google mode (no GOOGLE_CLIENT_ID) — the zero-infra default.
const __filename = fileURLToPath(import.meta.url);
const DB_PATH = path.resolve(path.dirname(__filename), "../../config/db.json");

const auth = getAuthService();
let dbSnapshot;

before(() => {
  dbSnapshot = fs.readFileSync(DB_PATH);
});

after(() => {
  fs.writeFileSync(DB_PATH, dbSnapshot);
});

function seedLocalUser(user) {
  const db = JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
  db.users.push(user);
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf-8");
}

function countUsers(email) {
  const db = JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
  return db.users.filter((u) => String(u.email).toLowerCase() === email.toLowerCase()).length;
}

test("NEW email => firstLogin:true, sanitized user (no password) + 3-part token", async () => {
  const email = "as.new@example.com";
  const idToken = mintMockIdToken({ sub: "as-new-sub", email, name: "AS New", emailVerified: true });

  const res = await auth.authenticateWithGoogle({ idToken });

  assert.equal(res.firstLogin, true);
  assert.equal(res.linked, false);
  assert.equal(res.user.email, email);
  assert.equal("password" in res.user, false, "returned user is sanitized");
  assert.equal(res.user.role, "customer");
  assert.equal(typeof res.token, "string");
  assert.equal(res.token.split(".").length, 3, "3-part session token");
  assert.equal(countUsers(email), 1);
});

test("SAME token again => firstLogin:false (returning user), still one row", async () => {
  const email = "as.returning@example.com";
  const idToken = mintMockIdToken({ sub: "as-returning-sub", email, emailVerified: true });

  const first = await auth.authenticateWithGoogle({ idToken });
  assert.equal(first.firstLogin, true);

  const second = await auth.authenticateWithGoogle({ idToken });
  assert.equal(second.firstLogin, false, "second login is not a first login");
  assert.equal(second.linked, false);
  assert.equal(second.user.email, email);
  assert.equal(countUsers(email), 1, "no duplicate created on returning login");
});

test("token for an existing LOCAL account email => linked:true, role preserved, no duplicate", async () => {
  const email = "as.local@example.com";
  seedLocalUser({
    name: "AS Local",
    email,
    password: "local-pw",
    role: "manager",
    phone: "+91 91111 11111",
    provider: "local",
    authProvider: "local",
    providers: ["local"],
  });

  const idToken = mintMockIdToken({ sub: "as-local-google-sub", email, emailVerified: true });
  const res = await auth.authenticateWithGoogle({ idToken });

  assert.equal(res.linked, true, "existing local account is linked, not duplicated");
  assert.equal(res.firstLogin, false);
  assert.equal(res.user.role, "manager", "role preserved on link");
  assert.equal("password" in res.user, false, "sanitized (no password) in response");
  assert.equal(countUsers(email), 1, "no duplicate row");
});

async function assertRejectsInvalidToken(idToken, extra, label) {
  await assert.rejects(
    () => auth.authenticateWithGoogle({ idToken, ...extra }),
    (err) => {
      assert.equal(err.code, "INVALID_TOKEN", `${label}: expected INVALID_TOKEN, got ${err.code}`);
      return true;
    },
    label
  );
}

test("invalid / expired / unverified tokens throw INVALID_TOKEN and create no user", async () => {
  const badSig = (() => {
    const t = mintMockIdToken({ sub: "as-bad-sub", email: "as.bad@example.com" });
    const [h, b] = t.split(".");
    return `${h}.${b}.tampered`;
  })();
  await assertRejectsInvalidToken(badSig, {}, "tampered signature");

  const expired = mintMockIdToken({ sub: "as-exp-sub", email: "as.expired@example.com", expSec: -10 });
  await assertRejectsInvalidToken(expired, {}, "expired");

  const unverified = mintMockIdToken({ sub: "as-unv-sub", email: "as.unverified@example.com", emailVerified: false });
  await assertRejectsInvalidToken(unverified, {}, "email not verified");

  const nonceTok = mintMockIdToken({ sub: "as-nm-sub", email: "as.nonce@example.com", nonce: "tok-nonce" });
  await assertRejectsInvalidToken(nonceTok, { nonce: "other-nonce" }, "nonce mismatch");

  // None of the rejected tokens created a user.
  assert.equal(countUsers("as.bad@example.com"), 0);
  assert.equal(countUsers("as.expired@example.com"), 0);
  assert.equal(countUsers("as.unverified@example.com"), 0);
  assert.equal(countUsers("as.nonce@example.com"), 0);
});
