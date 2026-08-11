import { createHash, randomInt, timingSafeEqual } from "crypto";
import { config } from "../config/auth.config.js";

/**
 * One-time passcode store for phone (SMS) login.
 *
 * Mirrors nonceStore.js: in-memory, zero-infra, lazily swept, hard-capped. Back
 * it with Redis behind this same interface for multi-instance deployments —
 * until then a code issued by one instance cannot be verified by another.
 *
 * SECURITY MODEL — an OTP is a 6-digit secret, i.e. only ~20 bits, so the store
 * (not the code length) has to carry the defence:
 *
 *   - Codes are stored SHA-256 HASHED, never plaintext. A heap dump or an
 *     accidental log of this map leaks nothing usable.
 *   - Comparison is timing-safe, over the hashes.
 *   - A code is BURNED on first successful verify (single use).
 *   - Verify attempts are capped per issued code (config.otpLogin.maxAttempts).
 *     Blowing the cap destroys the code, so an attacker gets N guesses out of
 *     10^6 and then has to request a new one — which is separately throttled.
 *   - Resends are throttled by a cooldown, so the endpoint cannot be used as a
 *     free SMS cannon against a third party's phone (every send costs money).
 *
 * The phone number is the key, normalized by the caller (userService.normalizePhone)
 * so "+91 63804 22961" and "6380422961" cannot hold two independent codes.
 */
const store = new Map(); // phone -> { hash, expiresAt, attempts, issuedAt }
const MAX_ENTRIES = 20000; // bound memory against request spam

const hashCode = (code) => createHash("sha256").update(String(code)).digest("hex");

function sweep() {
  const now = Date.now();
  for (const [k, v] of store) if (v.expiresAt <= now) store.delete(k);
}

/** Cryptographically-random numeric code, zero-padded, never starting short. */
function generateCode(length) {
  const max = 10 ** length;
  return String(randomInt(0, max)).padStart(length, "0");
}

/**
 * Seconds a caller must wait before a new code may be issued for this phone,
 * or 0 if a send is allowed right now. Checked BEFORE generating/sending so a
 * throttled request never costs an SMS.
 */
export function resendCooldownRemaining(phone) {
  const entry = store.get(phone);
  if (!entry) return 0;
  const elapsed = Date.now() - entry.issuedAt;
  const cooldownMs = config.otpLogin.resendCooldownSec * 1000;
  return elapsed >= cooldownMs ? 0 : Math.ceil((cooldownMs - elapsed) / 1000);
}

/**
 * Issue a code for a phone, replacing any outstanding one (a fresh request
 * invalidates the previous code — otherwise both would stay live and double an
 * attacker's guessing budget).
 *
 * @returns {{ code: string, expiresInSec: number }} plaintext code — hand it
 *   straight to the SMS provider and never log, store or return it to a client.
 */
export function issueOtp(phone) {
  sweep();
  while (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
  const code = generateCode(config.otpLogin.codeLength);
  const now = Date.now();
  store.set(phone, {
    hash: hashCode(code),
    expiresAt: now + config.otpLogin.ttlSec * 1000,
    attempts: 0,
    issuedAt: now,
  });
  return { code, expiresInSec: config.otpLogin.ttlSec };
}

/**
 * Verify + burn a code.
 *
 * @returns {{ ok: boolean, reason?: "not_found"|"expired"|"too_many_attempts"|"mismatch", attemptsLeft?: number }}
 *   Reasons are for AUDIT and rate-limit decisions only. Never surface which of
 *   them occurred to the caller — "no code outstanding" vs "wrong code" tells an
 *   attacker whether a number is enrolled.
 */
export function verifyOtp(phone, code) {
  sweep();
  const entry = store.get(phone);
  if (!entry) return { ok: false, reason: "not_found" };
  if (entry.expiresAt <= Date.now()) {
    store.delete(phone);
    return { ok: false, reason: "expired" };
  }
  if (entry.attempts >= config.otpLogin.maxAttempts) {
    store.delete(phone);
    return { ok: false, reason: "too_many_attempts" };
  }

  entry.attempts += 1;
  const a = Buffer.from(hashCode(code));
  const b = Buffer.from(entry.hash);
  const match = a.length === b.length && timingSafeEqual(a, b);

  if (!match) {
    const attemptsLeft = config.otpLogin.maxAttempts - entry.attempts;
    // Burn the code once the budget is spent, so the next request must re-send.
    if (attemptsLeft <= 0) store.delete(phone);
    return { ok: false, reason: "mismatch", attemptsLeft: Math.max(attemptsLeft, 0) };
  }

  store.delete(phone); // single use
  return { ok: true };
}

/** Drop any outstanding code for a phone (used on logout-all / admin actions). */
export function clearOtp(phone) {
  store.delete(phone);
}

/** test/debug only */
export function _size() {
  return store.size;
}

export default { issueOtp, verifyOtp, clearOtp, resendCooldownRemaining, _size };
