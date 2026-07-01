import oauthRoutes from "./api/auth.routes.js";
import { config, validateEnv, googleMode } from "./config/auth.config.js";
import { getAuthService } from "./core/AuthService.js";

/**
 * ============================================================================
 *  ENTERPRISE AUTH MODULE — Google OAuth 2.0 (additive, non-breaking)
 * ============================================================================
 *
 * Extends the existing email/password auth WITHOUT modifying it. Provider-
 * agnostic (EmailPassword + Google today; Microsoft/Apple/GitHub/Facebook
 * pluggable). Verifies Google ID tokens server-side, finds/creates/links the
 * ERP user, and returns the SAME user-payload shape as the existing login (plus
 * an additive session token). Reuses the notification engine for new-user events.
 *
 * Usage in app bootstrap (after the existing authRoutes mount):
 *   import authOAuth from "./auth/index.js";
 *   authOAuth.init(app);   // mounts the additive /api/auth/* OAuth routes
 */
function init(app) {
  if (!config.enabled) {
    console.log("[auth/oauth] DISABLED via OAUTH_ENABLED=false");
    return null;
  }
  const { ok, errors, warnings } = validateEnv();
  warnings.forEach((w) => console.warn(`[auth/oauth] ${w}`));
  if (!ok) {
    errors.forEach((e) => console.warn(`[auth/oauth] env: ${e}`));
    // FAIL CLOSED in production: never boot in mock mode or with a default
    // signing secret (would allow forged tokens / auth bypass). C1/H2.
    if (config.isProduction) {
      throw new Error(`[auth/oauth] refusing to start in production: ${errors.join("; ")}`);
    }
  }

  getAuthService();
  if (app) app.use("/api/auth", oauthRoutes);
  console.log(`[auth/oauth] ready — google mode=${googleMode()}`);
  return getAuthService();
}

export { init, getAuthService };
export default { init, getAuthService };
