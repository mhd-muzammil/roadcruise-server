import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { JsonStore } from "../../notifications/repository/store.js";

/**
 * Immutable, append-only authentication audit trail. Records every security-
 * relevant event: login success/failure, password change/reset, logout, token
 * refresh/revoke, role changes, lockouts, suspicious activity. Entries are never
 * updated or deleted. NEVER stores passwords or token secrets.
 */
const AUTH_DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../data");
const store = new JsonStore("auth_audit.json", { entries: [] }, AUTH_DATA_DIR);

export const AuditActions = Object.freeze({
  LOGIN_SUCCESS: "login_success",
  LOGIN_FAILED: "login_failed",
  LOGIN_LOCKED: "login_locked",
  GOOGLE_LOGIN: "google_login",
  REGISTER: "register",
  PASSWORD_MIGRATED: "password_migrated",
  PASSWORD_CHANGED: "password_changed",
  PASSWORD_RESET_REQUESTED: "password_reset_requested",
  PASSWORD_RESET_COMPLETED: "password_reset_completed",
  EMAIL_VERIFY_REQUESTED: "email_verify_requested",
  EMAIL_VERIFIED: "email_verified",
  TOKEN_REFRESHED: "token_refreshed",
  TOKEN_REUSE_DETECTED: "token_reuse_detected",
  LOGOUT: "logout",
  LOGOUT_ALL: "logout_all",
  SESSION_REVOKED: "session_revoked",
  ROLE_CHANGED: "role_changed",
  ACCOUNT_LOCKED: "account_locked",
  ACCOUNT_UNLOCKED: "account_unlocked",
  SUSPICIOUS: "suspicious_activity",
});

export async function audit({ action, actor = "system", email = null, ip = null, userAgent = null, result = "ok", detail = null }) {
  const entry = {
    auditId: `AUD_${randomUUID()}`,
    at: new Date().toISOString(),
    action,
    actor,
    email: email ? String(email).toLowerCase() : null,
    ip,
    userAgent: userAgent ? String(userAgent).slice(0, 256) : null,
    result,
    detail,
  };
  await store.update((db) => db.entries.push(entry));
  return entry;
}

export function query({ email, action, limit = 200, offset = 0 } = {}) {
  let rows = store.read().entries;
  if (email) rows = rows.filter((e) => e.email === String(email).toLowerCase());
  if (action) rows = rows.filter((e) => e.action === action);
  rows = [...rows].sort((a, b) => (a.at < b.at ? 1 : -1));
  return { total: rows.length, items: rows.slice(offset, offset + limit) };
}

export default { audit, query, AuditActions };
