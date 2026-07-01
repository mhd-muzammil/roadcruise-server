import { verifyTyped } from "../core/token.js";
import { config } from "../config/auth.config.js";
import { findByEmail } from "../core/userService.js";
import { findById as findSession, isActive } from "../core/sessionStore.js";
import { hasPermission, roleAtLeast } from "./roles.js";

/**
 * RBAC middleware. Applied to the NEW enterprise auth endpoints. It is NOT
 * retrofitted onto the existing booking/payment routes (the current tokenless
 * frontend would break) — it's ready for adoption when those clients send tokens.
 *
 *   requireAuth        -> validates the Bearer access token + session + tokenVersion,
 *                         attaches req.auth = { email, role, sid, user }.
 *   requireRole(min)   -> requires at least the given role rank.
 *   requirePermission  -> requires a specific permission from the RBAC matrix.
 *   optionalAuth       -> attaches req.auth if a valid token is present, else continues.
 */
function extractToken(req) {
  const h = req.get("authorization") || "";
  if (h.startsWith("Bearer ")) return h.slice(7).trim();
  return req.body?.accessToken || req.query?.access_token || null;
}

export function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: "Authentication required" });
  const { valid, payload, reason } = verifyTyped(token, "access");
  if (!valid) return res.status(401).json({ error: `Invalid token: ${reason}` });

  const user = findByEmail(payload.email);
  if (!user) return res.status(401).json({ error: "User no longer exists" });
  // tokenVersion mismatch => token was revoked (logout-all / password change).
  if ((user.tokenVersion || 0) !== (payload.tokenVersion || 0)) {
    return res.status(401).json({ error: "Token revoked" });
  }
  // Session must still be active (supports remote/admin revoke).
  if (payload.sid) {
    const session = findSession(payload.sid);
    if (!session || !isActive(session)) return res.status(401).json({ error: "Session revoked or expired" });
  }
  req.auth = { email: user.email, role: user.role, sid: payload.sid, user };
  next();
}

export function requireRole(minRole) {
  return [
    requireAuth,
    (req, res, next) => {
      if (!roleAtLeast(req.auth.role, minRole)) {
        return res.status(403).json({ error: "Insufficient role" });
      }
      next();
    },
  ];
}

export function requirePermission(permission) {
  return [
    requireAuth,
    (req, res, next) => {
      if (!hasPermission(req.auth.role, permission)) {
        return res.status(403).json({ error: `Missing permission: ${permission}` });
      }
      next();
    },
  ];
}

export function optionalAuth(req, _res, next) {
  const token = extractToken(req);
  if (token) {
    const { valid, payload } = verifyTyped(token, "access");
    if (valid) {
      const user = findByEmail(payload.email);
      if (user && (user.tokenVersion || 0) === (payload.tokenVersion || 0)) {
        req.auth = { email: user.email, role: user.role, sid: payload.sid, user };
      }
    }
  }
  next();
}

export default { requireAuth, requireRole, requirePermission, optionalAuth };
