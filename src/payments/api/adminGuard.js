import { createHash, timingSafeEqual } from "crypto";
import { config } from "../config/payment.config.js";

/**
 * Payment admin guard. Uses the PAYMENT module's own resolved token
 * (config.adminToken = NOTIF_ADMIN_TOKEN || PAYMENT_ADMIN_TOKEN) — fixing the
 * dead-wiring where the shared notifications guard only ever saw NOTIF_ADMIN_TOKEN.
 *
 *   - Constant-time token comparison (SHA-256 digests + timingSafeEqual).
 *   - Fails CLOSED unless explicitly NODE_ENV=development.
 */
const isDevelopment = process.env.NODE_ENV === "development";
const digest = (s) => createHash("sha256").update(String(s)).digest();

function tokensMatch(provided, expected) {
  if (!provided || !expected) return false;
  return timingSafeEqual(digest(provided), digest(expected));
}

export function paymentAdminGuard(req, res, next) {
  if (!config.adminToken) {
    if (!isDevelopment) {
      return res.status(503).json({
        error: "Payment admin API disabled: set NOTIF_ADMIN_TOKEN or PAYMENT_ADMIN_TOKEN (required outside NODE_ENV=development)",
      });
    }
    console.warn("[payments] admin API UNPROTECTED (NODE_ENV=development) — set a token to require x-admin-token");
    return next();
  }
  if (!tokensMatch(req.get("x-admin-token"), config.adminToken)) {
    return res.status(401).json({ error: "Unauthorized: invalid or missing x-admin-token" });
  }
  return next();
}

export default paymentAdminGuard;
