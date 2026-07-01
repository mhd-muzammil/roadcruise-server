import { scrypt, randomBytes, timingSafeEqual } from "crypto";
import { promisify } from "util";
import { config } from "../config/auth.config.js";

/**
 * PasswordHasher — pluggable, self-describing password hashing with transparent
 * legacy migration.
 *
 * Format: "<algo>$<params>" so verify() and needsRehash() can route to the right
 * verifier and detect legacy/plaintext records:
 *   scrypt$N$r$p$<saltB64>$<hashB64>
 *   argon2$<argon2-encoded>            (when the argon2 package is installed)
 *   bcrypt$<bcrypt-hash>               (when the bcryptjs/bcrypt package is installed)
 *   plain$<value>                      (INTERNAL marker for legacy plaintext — never written)
 *
 * DEFAULT = scrypt (Node built-in, zero native deps, memory-hard). Set
 * AUTH_PASSWORD_ALGO=argon2|bcrypt to prefer those (lazy-loaded); if the package
 * is missing we fall back to scrypt so the app never breaks.
 *
 * Security: constant-time comparison, per-hash random salt, never logs secrets.
 */
const scryptAsync = promisify(scrypt);
const SCRYPT_N = 16384; // CPU/memory cost
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const KEYLEN = 32;

const b64 = (buf) => buf.toString("base64");
const fromB64 = (s) => Buffer.from(s, "base64");

async function scryptHash(password) {
  const salt = randomBytes(16);
  const dk = await scryptAsync(password, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p });
  return `scrypt$${SCRYPT_N}$${SCRYPT_r}$${SCRYPT_p}$${b64(salt)}$${b64(dk)}`;
}

async function scryptVerify(password, stored) {
  const [, N, r, p, saltB64, hashB64] = stored.split("$");
  const salt = fromB64(saltB64);
  const expected = fromB64(hashB64);
  const dk = await scryptAsync(password, salt, expected.length, { N: +N, r: +r, p: +p });
  return dk.length === expected.length && timingSafeEqual(dk, expected);
}

async function tryLoad(pkg) {
  try {
    return (await import(pkg)).default ?? (await import(pkg));
  } catch {
    return null;
  }
}

/** Hash a password with the configured (or default) algorithm. */
export async function hashPassword(password) {
  const algo = config.passwordAlgo;
  if (algo === "argon2") {
    const argon2 = await tryLoad("argon2");
    if (argon2) return `argon2$${await argon2.hash(password, { type: argon2.argon2id })}`;
    console.warn("[auth] AUTH_PASSWORD_ALGO=argon2 but 'argon2' not installed — using scrypt");
  } else if (algo === "bcrypt") {
    const bcrypt = (await tryLoad("bcrypt")) || (await tryLoad("bcryptjs"));
    if (bcrypt) return `bcrypt$${await bcrypt.hash(password, 12)}`;
    console.warn("[auth] AUTH_PASSWORD_ALGO=bcrypt but bcrypt not installed — using scrypt");
  }
  return scryptHash(password);
}

/**
 * Verify a password against a stored value. Supports the self-describing hash
 * formats AND legacy PLAINTEXT (a stored value with no recognized "algo$" prefix
 * is treated as plaintext for transparent migration). Constant-time where possible.
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(password, stored) {
  if (stored == null) return false;
  const s = String(stored);
  if (s.startsWith("scrypt$")) return scryptVerify(password, s);
  if (s.startsWith("argon2$")) {
    const argon2 = await tryLoad("argon2");
    if (!argon2) return false;
    return argon2.verify(s.slice("argon2$".length), password);
  }
  if (s.startsWith("bcrypt$")) {
    const bcrypt = (await tryLoad("bcrypt")) || (await tryLoad("bcryptjs"));
    if (!bcrypt) return false;
    return bcrypt.compare(password, s.slice("bcrypt$".length));
  }
  // Legacy plaintext: constant-time compare, then caller migrates on success.
  const a = Buffer.from(password);
  const b = Buffer.from(s);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** True if the stored value is legacy plaintext (no recognized hash prefix). */
export function isLegacyPlaintext(stored) {
  if (stored == null) return false;
  const s = String(stored);
  return !s.startsWith("scrypt$") && !s.startsWith("argon2$") && !s.startsWith("bcrypt$");
}

export default { hashPassword, verifyPassword, isLegacyPlaintext };
