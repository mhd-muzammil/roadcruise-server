import { config } from "../config/auth.config.js";

/**
 * Password strength policy. Enforced on register + password reset (NOT on login,
 * so legacy users with weak passwords can still log in and be migrated). Rules
 * are configurable via env; defaults require a reasonably strong password.
 */
const COMMON = new Set(["password", "12345678", "qwerty123", "admin123", "password1", "letmein1"]);

export function validatePassword(password) {
  const p = String(password || "");
  const errors = [];
  const pol = config.passwordPolicy;

  if (p.length < pol.minLength) errors.push(`at least ${pol.minLength} characters`);
  if (pol.maxLength && p.length > pol.maxLength) errors.push(`at most ${pol.maxLength} characters`);
  if (pol.requireUppercase && !/[A-Z]/.test(p)) errors.push("an uppercase letter");
  if (pol.requireLowercase && !/[a-z]/.test(p)) errors.push("a lowercase letter");
  if (pol.requireNumber && !/[0-9]/.test(p)) errors.push("a number");
  if (pol.requireSpecial && !/[^A-Za-z0-9]/.test(p)) errors.push("a special character");
  if (COMMON.has(p.toLowerCase())) errors.push("a less common password (this one is easily guessed)");

  return {
    ok: errors.length === 0,
    errors,
    message: errors.length ? `Password must contain ${errors.join(", ")}.` : null,
  };
}

export default validatePassword;
