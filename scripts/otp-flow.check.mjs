/**
 * Throwaway end-to-end check of the phone-OTP login flow, run against a scratch
 * DATA_DIR so it never touches real data. Not a unit test — it exercises the
 * real AuthService, otpStore, userService and session issuance together.
 */
// Isolate by DEFAULT: this script writes real user records, and running it
// against the dev DATA_DIR silently leaves a fake account behind. An explicit
// DATA_DIR still wins, so CI can point it wherever it likes.
import { fileURLToPath } from "url";
import { rmSync } from "fs";
const OWN_DATA_DIR = !process.env.DATA_DIR;
process.env.DATA_DIR ||= fileURLToPath(new URL("../.tmp-otp-check/", import.meta.url));
// Start from empty when we own the directory. The first run creates the test
// user, so a second run against leftover state fails "flags new user" and looks
// like a product regression — it is not, and that false alarm is worth ruling
// out permanently. An explicitly supplied DATA_DIR is never deleted.
if (OWN_DATA_DIR) rmSync(process.env.DATA_DIR, { recursive: true, force: true });
process.env.NOTIF_SMS_PROVIDER = "mock";
process.env.NOTIF_EMAIL_PROVIDER = "mock";
process.env.NOTIF_WHATSAPP_PROVIDER = "mock";

const { getAuthService } = await import("../src/auth/core/AuthService.js");
const { issueOtp, resendCooldownRemaining } = await import("../src/auth/core/otpStore.js");
const { findByPhone, normalizePhone } = await import("../src/auth/core/userService.js");
const { verifyToken } = await import("../src/auth/core/token.js");

const svc = getAuthService();
const PHONE = "9123456780"; // scratch number, never sent to
let pass = 0, fail = 0;
const check = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label} ${extra}`); }
};

console.log("\n1. validation");
for (const bad of ["12345", "1234567890", "", "abcdefghij"]) {
  try { await svc.requestPhoneOtp({ phone: bad }); check(`rejects ${JSON.stringify(bad)}`, false); }
  catch (e) { check(`rejects ${JSON.stringify(bad)}`, e.code === "VALIDATION", e.code); }
}

console.log("\n2. request issues a code + cooldown");
const req = await svc.requestPhoneOtp({ phone: "+91 " + PHONE });
check("returns sent:true", req.sent === true);
check("reports expiry", req.expiresInSec === 300, String(req.expiresInSec));
check("flags new user", req.isNewUser === true);
check("cooldown now active", resendCooldownRemaining(PHONE) > 0);
try { await svc.requestPhoneOtp({ phone: PHONE }); check("second request throttled", false); }
catch (e) { check("second request throttled", e.code === "OTP_COOLDOWN", e.code); }

console.log("\n3. wrong code is rejected, correct code logs in");
const { code } = issueOtp(PHONE); // replaces the live code with a known one
try { await svc.verifyPhoneOtp({ phone: PHONE, code: "000000" }); check("wrong code rejected", false); }
catch (e) { check("wrong code rejected", e.code === "OTP_INVALID", e.code); }

const { code: code2 } = issueOtp(PHONE);
const login = await svc.verifyPhoneOtp({ phone: PHONE, code: code2, name: "Test Rider" });
check("returns a user", !!login.user);
check("flags first-time signup", login.isNewUser === true);
check("access token verifies", verifyToken(login.accessToken).valid);
check("refresh token issued", !!login.refreshToken);
check("session id issued", !!login.sessionId);
check("user has normalized phone", login.user.phone === PHONE, login.user.phone);
check("phone marked verified", login.user.phoneVerified === true);
check("placeholder email flagged", login.user.emailPlaceholder === true);
check("email is non-deliverable", String(login.user.email).endsWith("@phone.invalid"), login.user.email);
check("no secrets leaked", !("password" in login.user) && !("passwordHash" in login.user));

console.log("\n4. code is single-use");
try { await svc.verifyPhoneOtp({ phone: PHONE, code: code2 }); check("reused code rejected", false); }
catch (e) { check("reused code rejected", e.code === "OTP_INVALID", e.code); }

console.log("\n5. second login adopts the SAME account (no duplicate)");
const { code: code3 } = issueOtp(PHONE);
const login2 = await svc.verifyPhoneOtp({ phone: PHONE, code: code3 });
check("not flagged as new", login2.isNewUser === false);
check("same email as before", login2.user.email === login.user.email);
check("exactly one record for the phone", !!findByPhone(PHONE));

console.log("\n6. attempt cap burns the code");
const { code: code4 } = issueOtp(PHONE);
for (let i = 0; i < 5; i++) {
  try { await svc.verifyPhoneOtp({ phone: PHONE, code: "111111" }); } catch {}
}
try { await svc.verifyPhoneOtp({ phone: PHONE, code: code4 }); check("correct code dead after 5 wrong tries", false); }
catch (e) { check("correct code dead after 5 wrong tries", e.code === "OTP_INVALID", e.code); }

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
