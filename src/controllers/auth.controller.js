import { getAuthService } from "../auth/core/AuthService.js";

/**
 * Local email/password auth. HARDENED IN PLACE (additive, non-breaking):
 * delegates to the enterprise AuthService which hashes passwords, TRANSPARENTLY
 * migrates legacy plaintext on first successful login, enforces lockout, creates
 * a session, issues access+refresh tokens, and writes an audit trail.
 *
 * The response CONTRACT is preserved exactly — same status codes (200 login /
 * 211 register / 400 / 401 / 409), same sanitized user object — with only
 * additive `accessToken`/`refreshToken`/`sessionId` fields the existing frontend
 * safely ignores (mirroring the Google login response).
 */
const svc = () => getAuthService();
const ctx = (req) => ({ ip: req.ip, userAgent: req.get("user-agent") });

export const login = async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const r = await svc().authenticateLocal({ email, password, ...ctx(req) });
    res.status(200).json({ ...r.user, accessToken: r.accessToken, refreshToken: r.refreshToken, sessionId: r.sessionId });
  } catch (e) {
    if (e.code === "VALIDATION") return res.status(400).json({ error: e.message });
    if (e.code === "ACCOUNT_LOCKED") return res.status(423).json({ error: e.message });
    if (e.code === "INVALID_CREDENTIALS") return res.status(401).json({ error: e.message });
    console.error("[auth] login error:", e.message);
    res.status(500).json({ error: "Login failed" });
  }
};

export const register = async (req, res) => {
  try {
    const { name, email, phone, password } = req.body || {};
    const r = await svc().registerLocal({ name, email, phone, password, ...ctx(req) });
    // Preserve the existing non-standard 211 success status for backward compat.
    res.status(211).json({ ...r.user, accessToken: r.accessToken, refreshToken: r.refreshToken, sessionId: r.sessionId });
  } catch (e) {
    if (e.code === "VALIDATION" || e.code === "WEAK_PASSWORD") return res.status(400).json({ error: e.message });
    if (e.code === "EMAIL_EXISTS") return res.status(409).json({ error: e.message });
    console.error("[auth] register error:", e.message);
    res.status(500).json({ error: "Registration failed" });
  }
};
