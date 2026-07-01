/**
 * Auth module configuration. Secrets ONLY from environment. Zero-infra default:
 * the Google ID-token verifier runs in MOCK mode (locally-signed tokens) so the
 * flow runs and tests pass with no Google credentials. Set GOOGLE_CLIENT_ID to
 * activate real google-auth-library verification.
 */
const bool = (v, def = false) =>
  v === undefined ? def : ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
const int = (v, def) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
};

export const config = {
  enabled: bool(process.env.OAUTH_ENABLED, true),

  // Google
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || null,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || null,
    callbackUrl: process.env.GOOGLE_CALLBACK_URL || null,
  },

  // Session token (additive, JWT-like HS256). Reuses JWT_SECRET if present.
  jwtSecret:
    process.env.JWT_SECRET || process.env.AUTH_SESSION_SECRET || "dev_auth_secret_change_me",
  tokenTtlSec: int(process.env.AUTH_TOKEN_TTL_SEC, 60 * 60 * 24 * 7), // 7 days

  // Mock verifier signing secret (dev/test only; deterministic mock id tokens).
  mockSecret: process.env.OAUTH_MOCK_SECRET || "oauth_mock_secret",

  // Account-linking policy: auto-link a Google login to an existing local
  // account ONLY when Google asserts the email is verified.
  autoLinkVerifiedEmail: bool(process.env.OAUTH_AUTOLINK, true),

  // Nonce/state replay-protection TTL.
  nonceTtlSec: int(process.env.OAUTH_NONCE_TTL_SEC, 600),

  isProduction: process.env.NODE_ENV === "production",
  defaultPhone: process.env.DEFAULT_USER_PHONE || "+91 99999 99999",

  // ---- Feature flags (enterprise hardening) ----
  flags: {
    auth: bool(process.env.AUTH_ENABLED, true),
    googleAuth: bool(process.env.GOOGLE_AUTH_ENABLED, true),
    emailVerification: bool(process.env.EMAIL_VERIFICATION_ENABLED, true),
    passwordReset: bool(process.env.PASSWORD_RESET_ENABLED, true),
    jwt: bool(process.env.JWT_ENABLED, true),
    refreshToken: bool(process.env.REFRESH_TOKEN_ENABLED, true),
  },

  // ---- Password hashing ----  scrypt (default) | argon2 | bcrypt (lazy)
  passwordAlgo: (process.env.AUTH_PASSWORD_ALGO || "scrypt").toLowerCase(),
  passwordPolicy: {
    minLength: int(process.env.PASSWORD_MIN_LENGTH, 8),
    maxLength: int(process.env.PASSWORD_MAX_LENGTH, 256), // cap to bound scrypt DoS

    requireUppercase: bool(process.env.PASSWORD_REQUIRE_UPPER, true),
    requireLowercase: bool(process.env.PASSWORD_REQUIRE_LOWER, true),
    requireNumber: bool(process.env.PASSWORD_REQUIRE_NUMBER, true),
    requireSpecial: bool(process.env.PASSWORD_REQUIRE_SPECIAL, true),
  },

  // ---- JWT access / refresh ----
  accessTtlSec: int(process.env.ACCESS_TOKEN_TTL_SEC, 60 * 15), // 15 min
  refreshTtlSec: int(process.env.REFRESH_TOKEN_TTL_SEC, 60 * 60 * 24 * 30), // 30 days

  // ---- Account lockout / brute-force ----
  lockout: {
    maxAttempts: int(process.env.AUTH_MAX_FAILED_ATTEMPTS, 5),
    lockMs: int(process.env.AUTH_LOCK_MS, 15 * 60 * 1000), // 15 min
    windowMs: int(process.env.AUTH_ATTEMPT_WINDOW_MS, 15 * 60 * 1000),
  },

  // ---- Rate limiting (per-IP sliding window) ----
  rateLimit: {
    windowMs: int(process.env.AUTH_RATE_WINDOW_MS, 60 * 1000),
    maxLogin: int(process.env.AUTH_RATE_MAX_LOGIN, 10),
    maxSensitive: int(process.env.AUTH_RATE_MAX_SENSITIVE, 5), // forgot/reset/verify
  },

  // ---- Reset / verification tokens ----
  resetTokenTtlSec: int(process.env.RESET_TOKEN_TTL_SEC, 60 * 30), // 30 min
  verifyTokenTtlSec: int(process.env.VERIFY_TOKEN_TTL_SEC, 60 * 60 * 24), // 24h

  // Base URL used to build reset/verification links in emails.
  appBaseUrl: process.env.APP_BASE_URL || "http://localhost:5173",
};

/** Active Google verification mode. */
export const googleMode = () => (config.google.clientId ? "google" : "mock");

/** Public Google client id for the frontend (safe to expose; never the secret). */
export const publicGoogleClientId = () => config.google.clientId || null;

/** Validate env for the selected mode. Never throws; returns {ok, errors, warnings}. */
export function validateEnv() {
  const errors = [];
  const warnings = [];
  if (googleMode() === "mock" && config.isProduction) {
    errors.push("GOOGLE_CLIENT_ID is required in production (mock Google verifier is disabled in prod)");
  }
  if (config.jwtSecret === "dev_auth_secret_change_me" && config.isProduction) {
    errors.push("JWT_SECRET must be set in production");
  }
  if (googleMode() === "mock") warnings.push("Google OAuth running in MOCK mode (no GOOGLE_CLIENT_ID)");
  return { ok: errors.length === 0, errors, warnings };
}

export default config;
