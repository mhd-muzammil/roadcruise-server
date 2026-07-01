import { createHmac, timingSafeEqual, randomUUID } from "crypto";
import { config } from "../config/auth.config.js";

/**
 * Minimal HS256 JWT-like session token. This is the ADDITIVE "ERP JWT" — the
 * existing email/password login issues no token, so we do not retrofit it there;
 * Google login returns the same user payload PLUS this token for future use.
 *
 * Signature comparison is timing-safe. Tokens carry iat/exp/jti.
 */
const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlJson = (obj) => b64url(JSON.stringify(obj));
const fromB64url = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

function sign(data, secret) {
  return createHmac("sha256", secret).update(data).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Issue a signed session token for a user. */
export function signToken(claims = {}, { ttlSec = config.tokenTtlSec } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  // Respect a caller-provided jti (refresh-token rotation binds a specific jti to
  // the session); only generate one when absent. iat/exp are always authoritative.
  const payload = { ...claims, iat: now, exp: now + ttlSec };
  if (!payload.jti) payload.jti = randomUUID();
  const head = b64urlJson(header);
  const body = b64urlJson(payload);
  const sig = sign(`${head}.${body}`, config.jwtSecret);
  return `${head}.${body}.${sig}`;
}

/**
 * Verify + decode a token. @returns {{valid, payload?, reason?}}
 * Validates signature (timing-safe) and expiry.
 */
export function verifyToken(token) {
  if (!token || typeof token !== "string") return { valid: false, reason: "missing" };
  const parts = token.split(".");
  if (parts.length !== 3) return { valid: false, reason: "malformed" };
  const [head, body, sig] = parts;
  // Pin the algorithm to prevent alg-confusion / "none" downgrade attacks. H2.
  let header;
  try {
    header = JSON.parse(fromB64url(head));
  } catch {
    return { valid: false, reason: "bad_header" };
  }
  if (header.alg !== "HS256") return { valid: false, reason: "bad_alg" };
  const expected = sign(`${head}.${body}`, config.jwtSecret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { valid: false, reason: "bad_signature" };
  let payload;
  try {
    payload = JSON.parse(fromB64url(body));
  } catch {
    return { valid: false, reason: "bad_payload" };
  }
  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) {
    return { valid: false, reason: "expired" };
  }
  return { valid: true, payload };
}

/**
 * Issue a short-lived ACCESS token. Carries identity + role + tokenVersion so a
 * tokenVersion bump (logout-all / password change) invalidates it immediately.
 */
export function signAccessToken({ email, role, tokenVersion = 0, sid }) {
  return signToken(
    { sub: email, email, role, tokenVersion, sid, type: "access" },
    { ttlSec: config.accessTtlSec }
  );
}

/**
 * Issue a long-lived REFRESH token bound to a session (sid) with a rotating jti.
 * The session stores the current jti; a presented refresh whose jti != the
 * session's current jti is a replay (reuse) and triggers session revocation.
 */
export function signRefreshToken({ email, tokenVersion = 0, sid, jti }) {
  return signToken(
    { sub: email, email, tokenVersion, sid, jti, type: "refresh" },
    { ttlSec: config.refreshTtlSec }
  );
}

/** Verify + require a specific token type. @returns {{valid, payload?, reason?}} */
export function verifyTyped(token, expectedType) {
  const res = verifyToken(token);
  if (!res.valid) return res;
  if (res.payload.type !== expectedType) return { valid: false, reason: "wrong_type" };
  return res;
}

export default { signToken, verifyToken, signAccessToken, signRefreshToken, verifyTyped };
