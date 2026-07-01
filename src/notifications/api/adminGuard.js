import { createHash, timingSafeEqual } from "crypto";
import config from "../config/notification.config.js";

/**
 * Lightweight, self-contained guard for the notification admin API. Independent
 * of the app's existing (placeholder) auth so this module is self-protecting.
 *
 *   - Requires header `x-admin-token` to equal NOTIF_ADMIN_TOKEN.
 *   - Comparison is CONSTANT-TIME (timingSafeEqual over SHA-256 digests) to
 *     prevent byte-by-byte token brute-forcing via response timing.
 *   - Fails CLOSED unless explicitly in development: if NOTIF_ADMIN_TOKEN is
 *     unset, access is allowed ONLY when NODE_ENV === "development" (with a
 *     loud warning); in production or any unset/ambiguous NODE_ENV it is denied.
 */
const isDevelopment = process.env.NODE_ENV === "development";

const digest = (s) => createHash("sha256").update(String(s)).digest();

function tokensMatch(provided, expected) {
  if (!provided || !expected) return false;
  // Equal-length digests make timingSafeEqual safe and hide length differences.
  return timingSafeEqual(digest(provided), digest(expected));
}

export function adminGuard(req, res, next) {
  if (!config.adminToken) {
    if (!isDevelopment) {
      return res.status(503).json({
        error:
          "Notification admin API disabled: set NOTIF_ADMIN_TOKEN (required outside NODE_ENV=development)",
      });
    }
    console.warn(
      "[notifications] admin API is UNPROTECTED (NODE_ENV=development) — set NOTIF_ADMIN_TOKEN to require an x-admin-token header"
    );
    return next();
  }
  if (!tokensMatch(req.get("x-admin-token"), config.adminToken)) {
    return res.status(401).json({ error: "Unauthorized: invalid or missing x-admin-token" });
  }
  return next();
}

export default adminGuard;
