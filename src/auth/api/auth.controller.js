import { getAuthService } from "../core/AuthService.js";
import { issueNonce, consumeNonce } from "../core/nonceStore.js";
import { config, googleMode, publicGoogleClientId } from "../config/auth.config.js";
import { sanitize } from "../core/userService.js";
import { permissionsFor } from "../rbac/roles.js";

const service = () => getAuthService();
const reqCtx = (req) => ({ ip: req.ip, userAgent: req.get("user-agent") });
const mapErr = (res, e, fallback) => {
  const status = e.status || (e.code === "INVALID_TOKEN" ? 401 : 500);
  if (status >= 500) console.error("[auth] error:", e.message);
  return res.status(status).json({ error: e.message || fallback });
};

// GET /api/auth/google/config — public, frontend bootstrap (no secrets)
export const googleConfig = (_req, res) => {
  res.json({
    enabled: config.enabled,
    mode: googleMode(), // "google" | "mock"
    clientId: publicGoogleClientId(), // null in mock mode
  });
};

// GET /api/auth/nonce — issue a one-time nonce for replay protection
export const getNonce = (_req, res) => {
  res.json({ nonce: issueNonce(), ttl: config.nonceTtlSec });
};

// POST /api/auth/google — verify Google ID token, login/create/link, return user
// body: { idToken, nonce? }
export const googleLogin = async (req, res) => {
  if (!config.enabled) return res.status(503).json({ error: "OAuth is disabled" });
  const { idToken, nonce } = req.body || {};
  if (!idToken) return res.status(400).json({ error: "idToken is required" });

  // Replay protection. A nonce is MANDATORY in production (the GIS button always
  // sends one); dev/mock may omit it. When present it must be one we issued and
  // not yet used, and the token's nonce claim must match (checked in the provider). H1.
  if (config.isProduction && !nonce) {
    return res.status(400).json({ error: "nonce is required" });
  }
  if (nonce !== undefined && !consumeNonce(nonce)) {
    return res.status(400).json({ error: "Invalid or expired nonce" });
  }

  try {
    const result = await service().authenticateWithGoogle({ idToken, nonce });
    // Return the SAME user-payload shape as existing login, plus an additive
    // token. Frontend stores `user` in localStorage exactly as before.
    res.status(200).json({ ...result.user, token: result.token, firstLogin: result.firstLogin, linked: result.linked });
  } catch (e) {
    if (e.code === "INVALID_TOKEN") return res.status(401).json({ error: e.message });
    if (e.code === "LINK_REQUIRED") return res.status(409).json({ error: e.message });
    if (e.code === "CONFIG") return res.status(503).json({ error: e.message });
    console.error("[auth] google login error:", e.message);
    res.status(500).json({ error: "Authentication failed" });
  }
};

// ---- Enterprise session/token endpoints ----

// POST /api/auth/refresh  { refreshToken }
export const refresh = async (req, res) => {
  try {
    const r = await service().refresh({ refreshToken: req.body?.refreshToken, ...reqCtx(req) });
    res.json(r);
  } catch (e) {
    mapErr(res, e, "Refresh failed");
  }
};

// GET /api/auth/me  (requireAuth)
export const me = (req, res) => {
  const user = req.auth.user;
  res.json({ ...sanitize(user), permissions: permissionsFor(user.role), sessionId: req.auth.sid });
};

// POST /api/auth/logout  (requireAuth) — current session
export const logout = async (req, res) => {
  await service().logout({ sid: req.auth.sid, email: req.auth.email, ...reqCtx(req) });
  res.json({ ok: true });
};

// POST /api/auth/logout-all  (requireAuth) — every device
export const logoutAll = async (req, res) => {
  const r = await service().logoutAll({ email: req.auth.email, ...reqCtx(req) });
  res.json(r);
};

// GET /api/auth/sessions  (requireAuth)
export const listSessions = (req, res) => {
  res.json({ sessions: service().listSessions(req.auth.email, req.auth.sid) });
};

// DELETE /api/auth/sessions/:sid  (requireAuth) — revoke one of my sessions
export const revokeSession = async (req, res) => {
  try {
    await service().revokeSession({ email: req.auth.email, sid: req.params.sid, actor: req.auth.email, ...reqCtx(req) });
    res.json({ ok: true });
  } catch (e) {
    mapErr(res, e, "Revoke failed");
  }
};

// ---- Password recovery + email verification (public, rate-limited) ----

// POST /api/auth/forgot-password  { email }
export const forgotPassword = async (req, res) => {
  await service().requestPasswordReset({ email: req.body?.email, ...reqCtx(req) });
  // Always 200 — never reveal whether the account exists.
  res.json({ ok: true, message: "If an account exists, a reset link has been sent." });
};

// POST /api/auth/reset-password  { email, token, newPassword }
export const resetPassword = async (req, res) => {
  try {
    const { email, token, newPassword } = req.body || {};
    await service().resetPassword({ email, token, newPassword, ...reqCtx(req) });
    res.json({ ok: true, message: "Password updated. Please sign in again." });
  } catch (e) {
    mapErr(res, e, "Reset failed");
  }
};

// POST /api/auth/verify-email  { email, token }   (also accepts query params)
export const verifyEmail = async (req, res) => {
  try {
    const email = req.body?.email || req.query.email;
    const token = req.body?.token || req.query.token;
    await service().verifyEmail({ email, token, ...reqCtx(req) });
    res.json({ ok: true, message: "Email verified." });
  } catch (e) {
    mapErr(res, e, "Verification failed");
  }
};

// POST /api/auth/resend-verification  { email }
export const resendVerification = async (req, res) => {
  await service().resendVerification({ email: req.body?.email, ...reqCtx(req) });
  res.json({ ok: true, message: "If the account needs verification, an email has been sent." });
};

export default {
  googleConfig, getNonce, googleLogin,
  refresh, me, logout, logoutAll, listSessions, revokeSession,
  forgotPassword, resetPassword, verifyEmail, resendVerification,
};
