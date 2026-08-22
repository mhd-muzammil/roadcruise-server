import { createHash } from "crypto";
import { readDb, writeDb } from "../../utils/db.js";
import { config } from "../config/auth.config.js";

/** SHA-256 hex — used to store reset/verification tokens HASHED (never plaintext). */
export const hashToken = (t) => createHash("sha256").update(String(t)).digest("hex");

/**
 * UserService — additive user management over the EXISTING db.json users array
 * (via the existing utils/db.js). It NEVER removes existing fields and treats
 * the new fields (provider/googleId/avatar/emailVerified/lastLogin/authProvider/
 * providers/createdAt) as optional, so pre-existing email/password users keep
 * working untouched.
 */
const norm = (email) => String(email || "").toLowerCase().trim();

/**
 * Fields that must NEVER be returned to a client. Beyond the legacy plaintext
 * `password`, this now strips the password hash, all token hashes, and internal
 * security/lockout state introduced by the hardening work.
 */
const SENSITIVE_FIELDS = [
  "password", "passwordHash", "passwordAlgorithm", "passwordMigrated", "lastPasswordChange",
  "resetTokenHash", "resetTokenExpiry", "verificationTokenHash", "verificationTokenExpiry",
  "failedLoginAttempts", "failedLoginWindowStart", "lockedUntil", "tokenVersion",
  "roleChangedBy", "roleChangedAt",
];

/** Strip secrets + internal security state before returning a user to a client. */
export function sanitize(user) {
  if (!user) return user;
  const safe = { ...user };
  for (const f of SENSITIVE_FIELDS) delete safe[f];
  return safe;
}

export function findByEmail(email) {
  const e = norm(email);
  return readDb().users.find((u) => norm(u.email) === e) || null;
}

export function findByGoogleId(googleId) {
  if (!googleId) return null;
  return readDb().users.find((u) => u.googleId === googleId) || null;
}

/** Mutate a single user record (matched by email) atomically-ish via writeDb. */
function mutateUser(email, mutator) {
  const db = readDb();
  const idx = db.users.findIndex((u) => norm(u.email) === norm(email));
  if (idx === -1) return null;
  db.users[idx] = mutator({ ...db.users[idx] });
  writeDb(db);
  return db.users[idx];
}

/** Create a brand-new Google-provisioned account. */
export function createFromGoogle(profile) {
  const db = readDb();
  const now = new Date().toISOString();
  const user = {
    name: profile.name || profile.email.split("@")[0],
    email: norm(profile.email),
    password: null, // Google-only account: no local password
    role: "customer",
    phone: config.defaultPhone,
    // ---- additive auth fields ----
    provider: "google",
    authProvider: "google",
    providers: ["google"],
    googleId: profile.sub,
    avatar: profile.picture || null,
    emailVerified: true,
    lastLogin: now,
    createdAt: now,
  };
  db.users.push(user);
  writeDb(db);
  return user;
}

/**
 * Normalize an Indian mobile to bare 10 digits — the canonical form used for
 * lookups and as the OTP store key.
 *
 * Accepts "+91 63804 22961", "0-6380422961", "916380422961", "6380422961". The
 * country code is STRIPPED rather than prepended: existing users were created
 * with free-text phone values, so 10 digits is the only shape both sides can
 * agree on. Msg91SmsProvider re-adds the country code at send time.
 *
 * @returns {string} 10 digits, or "" if this cannot be an Indian mobile.
 */
export function normalizePhone(input) {
  const digits = String(input ?? "").replace(/\D/g, "");
  // Strip a leading country code (91) or trunk prefix (0) before length-checking.
  const bare =
    digits.length > 10 && digits.startsWith("91")
      ? digits.slice(-10)
      : digits.length === 11 && digits.startsWith("0")
        ? digits.slice(1)
        : digits;
  // Indian mobiles are 10 digits starting 6-9. Rejecting everything else here
  // keeps landlines and typos out of the OTP store, and off the SMS bill.
  return /^[6-9]\d{9}$/.test(bare) ? bare : "";
}

/**
 * Find a user by mobile number, comparing NORMALIZED forms on both sides so a
 * record stored as "+91 63804 22961" still matches a login typed as
 * "6380422961". Returns the first match: phone is not enforced-unique on
 * pre-existing data, and a verified OTP proves control of the number regardless.
 */
export function findByPhone(phone) {
  const target = normalizePhone(phone);
  if (!target) return null;
  return readDb().users.find((u) => normalizePhone(u.phone) === target) || null;
}

/**
 * Create an account provisioned by a verified phone number.
 *
 * Sessions, audit records and every mutate path in this module are keyed on
 * `email`, so a phone-only user still needs one. It gets a SYNTHETIC address at
 * config.otpLogin.placeholderEmailDomain (default "phone.invalid", reserved by
 * RFC 2606 so it can never resolve). Two consequences worth knowing:
 *
 *   - `emailVerified` is false and stays false. Nothing may send mail here; the
 *     OTP notification deliberately passes only `phone`, so the email channel is
 *     SKIPPED rather than bounced (bounces damage sender reputation).
 *   - `emailPlaceholder: true` marks it, so the UI can ask for a real address
 *     later and account-linking can tell it apart from a genuine mailbox.
 */
export function createFromPhone({ phone, name } = {}) {
  const normalized = normalizePhone(phone);
  const db = readDb();
  const now = new Date().toISOString();
  const user = {
    name: name || `Guest ${normalized.slice(-4)}`,
    email: `${normalized}@${config.otpLogin.placeholderEmailDomain}`,
    password: null, // phone-only account: no local password
    role: "customer",
    phone: normalized,
    // ---- additive auth fields ----
    provider: "phone",
    authProvider: "phone",
    providers: ["phone"],
    googleId: null,
    avatar: null,
    emailVerified: false,
    emailPlaceholder: true,
    phoneVerified: true, // an OTP was proved before this record was written
    lastLogin: now,
    createdAt: now,
  };
  db.users.push(user);
  writeDb(db);
  return user;
}

/** Record a proved phone on an EXISTING account after a successful OTP login. */
export function markPhoneVerified(email, phone) {
  return mutateUser(email, (u) => {
    const providers = new Set([...(u.providers || []), u.provider || "local", "phone"]);
    return {
      ...u,
      phone: u.phone || normalizePhone(phone),
      phoneVerified: true,
      providers: [...providers].filter(Boolean),
      lastLogin: new Date().toISOString(),
    };
  });
}

/** Link Google to an existing (email/password) account — no duplicate created. */
export function linkGoogle(existing, profile) {
  return mutateUser(existing.email, (u) => {
    const providers = new Set([...(u.providers || []), u.provider || "local", "google"]);
    return {
      ...u,
      googleId: profile.sub,
      avatar: u.avatar || profile.picture || null,
      emailVerified: true,
      providers: [...providers].filter(Boolean),
      authProvider: u.authProvider && u.authProvider !== "google" ? `${u.authProvider},google` : "google",
      lastLogin: new Date().toISOString(),
    };
  });
}

/**
 * Record or withdraw marketing consent.
 *
 * TWO DIFFERENT STANDARDS, deliberately stored as two fields:
 *
 *   marketingOptIn   affirmative, timestamped consent. TRAI service-explicit SMS
 *                    requires this — an offer may not be texted to someone who
 *                    merely holds an account. Absent means NO.
 *   marketingOptOut  suppression. Email to an existing customer is legitimate
 *                    under the business relationship, so it ships unless the
 *                    customer says stop.
 *
 * Collapsing them into one boolean would either text people who never agreed, or
 * silence email for everyone who simply never saw a checkbox.
 *
 * The timestamp, source and IP are the evidence half: a DLT audit asks WHEN and
 * WHERE consent was given, and "the flag is true" is not an answer.
 */
export function setMarketingConsent(email, optIn, { source = "unknown", ip = null } = {}) {
  return mutateUser(email, (u) => ({
    ...u,
    marketingOptIn: optIn === true,
    // Withdrawing consent must also suppress email — a customer clicking "no"
    // means no, not "no SMS but keep the emails".
    marketingOptOut: optIn === true ? false : true,
    marketingConsentAt: new Date().toISOString(),
    marketingConsentSource: source,
    marketingConsentIp: ip,
  }));
}

export function touchLastLogin(email) {
  return mutateUser(email, (u) => ({ ...u, lastLogin: new Date().toISOString() }));
}

/**
 * OPTIONAL additive backfill migration: set default auth fields on legacy users
 * that predate this module. Idempotent; never overwrites existing values; never
 * touches passwords. Documented in README — not auto-run on existing accounts.
 */
export function migrateLegacyUsers() {
  const db = readDb();
  let changed = 0;
  db.users = db.users.map((u) => {
    if (u.provider && u.authProvider) return u;
    changed += 1;
    return {
      ...u,
      provider: u.provider || "local",
      authProvider: u.authProvider || "local",
      providers: u.providers || ["local"],
      googleId: u.googleId ?? null,
      avatar: u.avatar ?? null,
      emailVerified: u.emailVerified ?? false,
      lastLogin: u.lastLogin ?? null,
    };
  });
  if (changed) writeDb(db);
  return { migrated: changed };
}

// ============================================================================
//  Enterprise hardening: password hash fields, lockout, token versioning,
//  reset/verification tokens. All ADDITIVE — legacy users are read with sane
//  defaults and only gain fields as they log in / register / reset.
// ============================================================================

/** Return the stored credential to verify against (hash preferred, legacy plaintext fallback). */
export function storedCredential(user) {
  return user?.passwordHash ?? user?.password ?? null;
}

/** True if the user still holds a legacy plaintext password (needs migration). */
export function needsPasswordMigration(user) {
  return !!user && !user.passwordHash && user.password != null;
}

/** Create a new LOCAL (email/password) user with hardened fields. */
export function createLocalUser({ name, email, phone, passwordHash, algo }) {
  const db = readDb();
  const now = new Date().toISOString();
  const user = {
    name,
    email: norm(email),
    phone: phone || config.defaultPhone,
    role: "customer",
    // hardened credential fields (no plaintext ever stored)
    passwordHash,
    passwordAlgorithm: algo,
    passwordMigrated: true,
    lastPasswordChange: now,
    // provider / identity
    provider: "local",
    authProvider: "local",
    providers: ["local"],
    googleId: null,
    avatar: null,
    emailVerified: false,
    // security state
    tokenVersion: 0,
    failedLoginAttempts: 0,
    lockedUntil: null,
    lastLogin: null,
    createdAt: now,
  };
  db.users.push(user);
  writeDb(db);
  return user;
}

/** Set/replace a user's password hash (used by register-path already; migration + reset). */
export function setPasswordHash(email, passwordHash, algo, { migrated = true } = {}) {
  return mutateUser(email, (u) => {
    const next = {
      ...u,
      passwordHash,
      passwordAlgorithm: algo,
      passwordMigrated: migrated,
      lastPasswordChange: new Date().toISOString(),
    };
    delete next.password; // remove any legacy plaintext
    return next;
  });
}

export function isLocked(user) {
  return !!(user && user.lockedUntil && new Date(user.lockedUntil).getTime() > Date.now());
}

/** Record a failed login; lock the account after maxAttempts within the window. */
export function recordFailedLogin(email) {
  const { maxAttempts, lockMs, windowMs } = config.lockout;
  let result = { failedLoginAttempts: 0, locked: false, lockedUntil: null };
  mutateUser(email, (u) => {
    const now = Date.now();
    const windowStart = u.failedLoginWindowStart ? new Date(u.failedLoginWindowStart).getTime() : 0;
    let attempts = u.failedLoginAttempts || 0;
    let start = u.failedLoginWindowStart;
    if (!start || now - windowStart > windowMs) {
      attempts = 0;
      start = new Date(now).toISOString();
    }
    attempts += 1;
    const locked = attempts >= maxAttempts;
    const lockedUntil = locked ? new Date(now + lockMs).toISOString() : u.lockedUntil || null;
    result = { failedLoginAttempts: attempts, locked, lockedUntil };
    return { ...u, failedLoginAttempts: attempts, failedLoginWindowStart: start, lockedUntil };
  });
  return result;
}

export function resetFailedLogins(email) {
  return mutateUser(email, (u) => ({ ...u, failedLoginAttempts: 0, failedLoginWindowStart: null, lockedUntil: null }));
}

/** Admin/manual unlock. */
export function unlockAccount(email) {
  return resetFailedLogins(email);
}

/** Bump tokenVersion — invalidates ALL existing access/refresh tokens for the user. */
export function bumpTokenVersion(email) {
  return mutateUser(email, (u) => ({ ...u, tokenVersion: (u.tokenVersion || 0) + 1 }));
}

export function setEmailVerified(email, verified = true) {
  return mutateUser(email, (u) => ({ ...u, emailVerified: verified }));
}

export function setRole(email, role, actor = "admin") {
  return mutateUser(email, (u) => ({ ...u, role, roleChangedBy: actor, roleChangedAt: new Date().toISOString() }));
}

/** True if this email is configured (via ADMIN_EMAILS/ADMIN_EMAIL) to be an admin. */
export function isConfiguredAdmin(email) {
  return config.adminEmails.includes(norm(email));
}

/**
 * Promote a user to the admin role when their email is in the configured admin
 * list — the secure, server-side replacement for the removed client "bypass".
 * Idempotent: only writes when the role actually needs to change. Returns the
 * (possibly updated) user, or the original when no change is needed.
 */
export function elevateIfAdmin(email) {
  const user = findByEmail(email);
  if (!user) return user;
  if (isConfiguredAdmin(email) && user.role !== "admin") {
    return setRole(email, "admin", "system:env") || user;
  }
  return user;
}

// ---- reset tokens (stored HASHED, single-use, expiring) ----
export function setResetToken(email, token) {
  const expiry = new Date(Date.now() + config.resetTokenTtlSec * 1000).toISOString();
  mutateUser(email, (u) => ({ ...u, resetTokenHash: hashToken(token), resetTokenExpiry: expiry }));
  return expiry;
}
export function consumeResetToken(email, token) {
  const user = findByEmail(email);
  if (!user || !user.resetTokenHash) return false;
  const valid =
    user.resetTokenHash === hashToken(token) &&
    user.resetTokenExpiry &&
    new Date(user.resetTokenExpiry).getTime() > Date.now();
  // Always clear on any attempt (single-use / no reuse).
  mutateUser(email, (u) => {
    const next = { ...u };
    delete next.resetTokenHash;
    delete next.resetTokenExpiry;
    return next;
  });
  return valid;
}

// ---- email verification tokens (stored HASHED, single-use, expiring) ----
export function setVerificationToken(email, token) {
  const expiry = new Date(Date.now() + config.verifyTokenTtlSec * 1000).toISOString();
  mutateUser(email, (u) => ({ ...u, verificationTokenHash: hashToken(token), verificationTokenExpiry: expiry }));
  return expiry;
}
export function consumeVerificationToken(email, token) {
  const user = findByEmail(email);
  if (!user || !user.verificationTokenHash) return false;
  const valid =
    user.verificationTokenHash === hashToken(token) &&
    user.verificationTokenExpiry &&
    new Date(user.verificationTokenExpiry).getTime() > Date.now();
  mutateUser(email, (u) => {
    const next = { ...u, emailVerified: valid ? true : u.emailVerified };
    delete next.verificationTokenHash;
    delete next.verificationTokenExpiry;
    return next;
  });
  return valid;
}

export default {
  sanitize, findByEmail, findByGoogleId, createFromGoogle, linkGoogle, touchLastLogin, migrateLegacyUsers,
  hashToken, storedCredential, needsPasswordMigration, createLocalUser, setPasswordHash, isLocked,
  recordFailedLogin, resetFailedLogins, unlockAccount, bumpTokenVersion, setEmailVerified, setRole,
  isConfiguredAdmin, elevateIfAdmin,
  setResetToken, consumeResetToken, setVerificationToken, consumeVerificationToken,
};
