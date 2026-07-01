import { randomUUID, randomBytes } from "crypto";
import { getProvider } from "../providers/index.js";
import { config } from "../config/auth.config.js";
import { signToken, signAccessToken, signRefreshToken, verifyTyped } from "./token.js";
import { hashPassword, verifyPassword } from "./password.js";
import { validatePassword } from "./passwordPolicy.js";
import {
  sanitize,
  findByEmail,
  findByGoogleId,
  createFromGoogle,
  createLocalUser,
  linkGoogle,
  touchLastLogin,
  storedCredential,
  needsPasswordMigration,
  setPasswordHash,
  isLocked,
  recordFailedLogin,
  resetFailedLogins,
  bumpTokenVersion,
  setResetToken,
  consumeResetToken,
  setVerificationToken,
  consumeVerificationToken,
} from "./userService.js";
import {
  createSession,
  findById as findSession,
  isActive as sessionActive,
  listForUser,
  publicView,
  rotateJti,
  revoke as revokeSessionRecord,
  revokeAllForUser,
} from "./sessionStore.js";
import { audit, AuditActions } from "./auditLog.js";
import { notify, NotificationEvents } from "../../notifications/index.js";
import { notifyCustomerRegistered } from "../../notifications/integration/hooks.js";

const authErr = (message, code, status = 400) => Object.assign(new Error(message), { code, status });

/**
 * AuthService — provider-agnostic authentication orchestrator. Knows nothing
 * about Google specifically beyond resolving the provider; the find/create/link
 * + token logic is identical for any future provider.
 */
export class AuthService {
  /**
   * Authenticate via Google ID token. Verifies server-side, then finds, links,
   * or creates the ERP user. Returns the SAME user-payload shape as the existing
   * login (plus an additive session token).
   * @returns {Promise<{user, token, firstLogin, linked}>}
   */
  async authenticateWithGoogle({ idToken, nonce, ip, userAgent } = {}) {
    // 1) Verify the token server-side (issuer/audience/expiry/email_verified/nonce).
    const profile = await getProvider("google").authenticate({ idToken, nonce });

    // 2) Resolve the user: by googleId first, then by (verified) email.
    let user = findByGoogleId(profile.sub);
    let firstLogin = false;
    let linked = false;

    if (!user) {
      const byEmail = findByEmail(profile.email);
      if (byEmail) {
        // Existing local account with the same VERIFIED email -> link, never duplicate.
        if (!config.autoLinkVerifiedEmail) {
          const err = new Error("An account with this email exists. Account linking is disabled.");
          err.code = "LINK_REQUIRED";
          throw err;
        }
        user = linkGoogle(byEmail, profile);
        linked = true;
      } else {
        // Brand-new user.
        user = createFromGoogle(profile);
        firstLogin = true;
        notifyCustomerRegistered(sanitize(user)); // reuse existing notification hook
      }
    } else {
      // Returning Google user.
      user = touchLastLogin(user.email) || user;
    }

    // 3) Issue tokens + create a session (same machinery as local login).
    const { accessToken, refreshToken, session } = await this._issueSession(user, {
      provider: "google",
      ip,
      userAgent,
    });
    await audit({
      action: AuditActions.GOOGLE_LOGIN,
      email: user.email,
      ip,
      userAgent,
      result: "ok",
      detail: { firstLogin, linked },
    });

    // `token` is kept for backward compatibility (== access token).
    return { user: sanitize(user), token: accessToken, accessToken, refreshToken, sessionId: session.sessionId, firstLogin, linked };
  }

  /** Shared: create a session + issue access/refresh tokens for a user. */
  async _issueSession(user, { provider = "local", ip, userAgent } = {}) {
    const jti = randomUUID();
    const session = await createSession({ userEmail: user.email, provider, ip, userAgent, refreshJti: jti });
    const accessToken = signAccessToken({
      email: user.email,
      role: user.role,
      tokenVersion: user.tokenVersion || 0,
      sid: session.sessionId,
    });
    const refreshToken = config.flags.refreshToken
      ? signRefreshToken({ email: user.email, tokenVersion: user.tokenVersion || 0, sid: session.sessionId, jti })
      : null;
    return { accessToken, refreshToken, session };
  }

  async _sendVerification(user) {
    const token = randomBytes(32).toString("hex");
    setVerificationToken(user.email, token);
    const verificationLink = `${config.appBaseUrl}/verify-email?email=${encodeURIComponent(user.email)}&token=${token}`;
    notify(
      NotificationEvents.EMAIL_VERIFICATION,
      { email: user.email, name: user.name, verificationLink },
      { actor: "auth-service" }
    );
    return token;
  }

  /**
   * Local email/password authentication with TRANSPARENT plaintext migration,
   * account lockout, session creation, token issuance, and audit logging.
   * Returns the SAME sanitized-user shape as the legacy login, plus tokens.
   */
  async authenticateLocal({ email, password, ip, userAgent } = {}) {
    if (!email || !password) throw authErr("Email and password are required", "VALIDATION", 400);
    const invalid = () => authErr("Invalid email or password", "INVALID_CREDENTIALS", 401);
    // Reject over-long passwords BEFORE hashing (bounds scrypt CPU/mem DoS). No
    // legitimate account has one — register/reset enforce the same max length.
    if (password.length > config.passwordPolicy.maxLength) throw invalid();
    const user = findByEmail(email);

    if (!user) {
      await audit({ action: AuditActions.LOGIN_FAILED, email, ip, userAgent, result: "no_user" });
      throw invalid();
    }
    if (isLocked(user)) {
      await audit({ action: AuditActions.LOGIN_LOCKED, email: user.email, ip, userAgent, result: "locked" });
      throw authErr("Account temporarily locked due to failed login attempts. Try again later.", "ACCOUNT_LOCKED", 423);
    }

    const ok = await verifyPassword(password, storedCredential(user));
    if (!ok) {
      const r = recordFailedLogin(user.email);
      await audit({ action: AuditActions.LOGIN_FAILED, email: user.email, ip, userAgent, result: "bad_password", detail: { attempts: r.failedLoginAttempts } });
      if (r.locked) await audit({ action: AuditActions.ACCOUNT_LOCKED, email: user.email, ip, userAgent, detail: { until: r.lockedUntil } });
      throw invalid();
    }

    // success
    resetFailedLogins(user.email);
    if (needsPasswordMigration(user)) {
      const hash = await hashPassword(password);
      setPasswordHash(user.email, hash, config.passwordAlgo, { migrated: true });
      await audit({ action: AuditActions.PASSWORD_MIGRATED, email: user.email, ip, userAgent, result: "ok" });
    }
    touchLastLogin(user.email);
    const fresh = findByEmail(user.email);
    const { accessToken, refreshToken, session } = await this._issueSession(fresh, { provider: "local", ip, userAgent });
    await audit({ action: AuditActions.LOGIN_SUCCESS, email: fresh.email, ip, userAgent, result: "ok", detail: { sid: session.sessionId } });
    return { user: sanitize(fresh), accessToken, refreshToken, sessionId: session.sessionId };
  }

  /** Register a new local user (hashed password, policy-enforced, verification email). */
  async registerLocal({ name, email, phone, password, ip, userAgent } = {}) {
    if (!name || !email || !password) throw authErr("Name, email and password are required", "VALIDATION", 400);
    const policy = validatePassword(password);
    if (!policy.ok) throw authErr(policy.message, "WEAK_PASSWORD", 400);
    if (findByEmail(email)) throw authErr("User with this email already exists", "EMAIL_EXISTS", 409);

    const hash = await hashPassword(password);
    const user = createLocalUser({ name, email, phone, passwordHash: hash, algo: config.passwordAlgo });

    notifyCustomerRegistered(sanitize(user));
    if (config.flags.emailVerification) await this._sendVerification(user);

    const { accessToken, refreshToken, session } = await this._issueSession(user, { provider: "local", ip, userAgent });
    await audit({ action: AuditActions.REGISTER, email: user.email, ip, userAgent, result: "ok" });
    return { user: sanitize(user), accessToken, refreshToken, sessionId: session.sessionId };
  }

  /** Rotate a refresh token: validate, detect reuse, issue new access+refresh. */
  async refresh({ refreshToken, ip, userAgent } = {}) {
    if (!config.flags.refreshToken) throw authErr("Refresh tokens are disabled", "DISABLED", 400);
    const { valid, payload, reason } = verifyTyped(refreshToken || "", "refresh");
    if (!valid) throw authErr(`Invalid refresh token: ${reason}`, "INVALID_TOKEN", 401);

    const user = findByEmail(payload.email);
    if (!user) throw authErr("User no longer exists", "INVALID_TOKEN", 401);
    if ((user.tokenVersion || 0) !== (payload.tokenVersion || 0)) throw authErr("Refresh token revoked", "REVOKED", 401);

    const session = findSession(payload.sid);
    if (!session || !sessionActive(session)) throw authErr("Session revoked or expired", "REVOKED", 401);

    // Reuse detection: the presented jti must equal the session's CURRENT jti.
    if (session.refreshJti !== payload.jti) {
      await revokeSessionRecord(session.sessionId, "reuse_detected");
      await audit({ action: AuditActions.TOKEN_REUSE_DETECTED, email: user.email, ip, userAgent, result: "revoked", detail: { sid: session.sessionId } });
      throw authErr("Refresh token reuse detected — session revoked", "TOKEN_REUSE", 401);
    }

    const newJti = randomUUID();
    await rotateJti(session.sessionId, newJti);
    const accessToken = signAccessToken({ email: user.email, role: user.role, tokenVersion: user.tokenVersion || 0, sid: session.sessionId });
    const newRefresh = signRefreshToken({ email: user.email, tokenVersion: user.tokenVersion || 0, sid: session.sessionId, jti: newJti });
    await audit({ action: AuditActions.TOKEN_REFRESHED, email: user.email, ip, userAgent, result: "ok", detail: { sid: session.sessionId } });
    return { accessToken, refreshToken: newRefresh };
  }

  async logout({ sid, email, ip, userAgent } = {}) {
    if (sid) await revokeSessionRecord(sid, "logout");
    await audit({ action: AuditActions.LOGOUT, email, ip, userAgent, result: "ok", detail: { sid } });
    return { ok: true };
  }

  async logoutAll({ email, ip, userAgent } = {}) {
    bumpTokenVersion(email); // invalidates every access/refresh token
    const count = await revokeAllForUser(email, "logout_all");
    await audit({ action: AuditActions.LOGOUT_ALL, email, ip, userAgent, result: "ok", detail: { revoked: count } });
    return { ok: true, revoked: count };
  }

  listSessions(email, currentSid) {
    return listForUser(email).map((s) => publicView(s, currentSid));
  }

  async revokeSession({ email, sid, actor = "user", isAdmin = false, ip, userAgent } = {}) {
    const session = findSession(sid);
    if (!session) throw authErr("Session not found", "NOT_FOUND", 404);
    if (!isAdmin && session.userEmail !== String(email).toLowerCase()) {
      throw authErr("Cannot revoke a session you do not own", "FORBIDDEN", 403);
    }
    await revokeSessionRecord(sid, actor);
    await audit({ action: AuditActions.SESSION_REVOKED, email: session.userEmail, ip, userAgent, actor, result: "ok", detail: { sid } });
    return { ok: true };
  }

  /** Forgot password — always returns ok (no account enumeration). */
  async requestPasswordReset({ email, ip, userAgent } = {}) {
    if (!config.flags.passwordReset) return { ok: true };
    const user = findByEmail(email);
    if (user) {
      const token = randomBytes(32).toString("hex");
      setResetToken(user.email, token);
      const resetLink = `${config.appBaseUrl}/reset-password?email=${encodeURIComponent(user.email)}&token=${token}`;
      notify(NotificationEvents.PASSWORD_RESET, { email: user.email, name: user.name, resetLink }, { actor: "auth-service" });
      await audit({ action: AuditActions.PASSWORD_RESET_REQUESTED, email: user.email, ip, userAgent, result: "ok" });
    }
    return { ok: true };
  }

  /** Reset password with a single-use token; revokes all existing sessions. */
  async resetPassword({ email, token, newPassword, ip, userAgent } = {}) {
    const policy = validatePassword(newPassword);
    if (!policy.ok) throw authErr(policy.message, "WEAK_PASSWORD", 400);
    if (!consumeResetToken(email, token)) {
      await audit({ action: AuditActions.PASSWORD_RESET_COMPLETED, email, ip, userAgent, result: "invalid_token" });
      throw authErr("Invalid or expired reset token", "INVALID_TOKEN", 400);
    }
    const hash = await hashPassword(newPassword);
    setPasswordHash(email, hash, config.passwordAlgo);
    bumpTokenVersion(email);
    await revokeAllForUser(email, "password_reset");
    await audit({ action: AuditActions.PASSWORD_RESET_COMPLETED, email, ip, userAgent, result: "ok" });
    return { ok: true };
  }

  async verifyEmail({ email, token, ip, userAgent } = {}) {
    if (!consumeVerificationToken(email, token)) {
      throw authErr("Invalid or expired verification token", "INVALID_TOKEN", 400);
    }
    await audit({ action: AuditActions.EMAIL_VERIFIED, email, ip, userAgent, result: "ok" });
    return { ok: true };
  }

  async resendVerification({ email, ip, userAgent } = {}) {
    const user = findByEmail(email);
    if (user && !user.emailVerified) {
      await this._sendVerification(user);
      await audit({ action: AuditActions.EMAIL_VERIFY_REQUESTED, email: user.email, ip, userAgent, result: "ok" });
    }
    return { ok: true };
  }
}

let instance = null;
export function getAuthService() {
  if (!instance) instance = new AuthService();
  return instance;
}

export default getAuthService;
