import { createHmac, timingSafeEqual } from "crypto";
import { AuthProvider } from "./AuthProvider.js";
import { config, googleMode } from "../config/auth.config.js";

/**
 * GoogleProvider — verifies a Google ID token SERVER-SIDE (never trusts the
 * frontend). Two modes:
 *
 *   - "google" (GOOGLE_CLIENT_ID set): real verification via google-auth-library
 *     (lazy-imported), which checks signature against Google's JWKS, audience,
 *     and expiry. We additionally enforce issuer, email_verified, and nonce.
 *   - "mock" (default, no creds): verifies a locally HMAC-signed token so the
 *     full flow runs and tests pass offline. mintMockIdToken() produces one.
 *
 * Validations enforced in BOTH modes: issuer, audience, expiry, email_verified,
 * and (when supplied) nonce — i.e. the security checks the spec requires.
 */
const GOOGLE_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const MOCK_ISS = "https://accounts.google.com";
const MOCK_AUD = "mock-google-client";

const b64url = (s) =>
  Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlJson = (o) => b64url(JSON.stringify(o));
const fromB64url = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
const mockSign = (data) =>
  createHmac("sha256", config.mockSecret).update(data).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export class GoogleProvider extends AuthProvider {
  get name() {
    return "google";
  }

  /** @param {{idToken:string, nonce?:string}} */
  async authenticate({ idToken, nonce } = {}) {
    if (!idToken) {
      const err = new Error("idToken is required");
      err.code = "INVALID_TOKEN";
      throw err;
    }
    const payload = googleMode() === "google" ? await this._verifyReal(idToken) : this._verifyMock(idToken);

    // Common, provider-enforced security checks.
    if (!GOOGLE_ISSUERS.has(payload.iss)) this._reject("bad_issuer");
    if (payload.email_verified !== true) this._reject("email_not_verified");
    if (nonce !== undefined && payload.nonce !== nonce) this._reject("nonce_mismatch");

    return {
      provider: "google",
      sub: payload.sub,
      email: String(payload.email || "").toLowerCase().trim(),
      emailVerified: payload.email_verified === true,
      name: payload.name || null,
      // Only accept https avatar URLs (block javascript:/data: XSS/SSRF vectors). M3.
      picture: typeof payload.picture === "string" && /^https:\/\//i.test(payload.picture) ? payload.picture : null,
    };
  }

  _reject(reason) {
    const err = new Error(`Google token rejected: ${reason}`);
    err.code = "INVALID_TOKEN";
    throw err;
  }

  async _verifyReal(idToken) {
    let OAuth2Client;
    try {
      ({ OAuth2Client } = await import("google-auth-library"));
    } catch {
      throw Object.assign(new Error("GOOGLE_CLIENT_ID set but 'google-auth-library' is not installed. Run: npm i google-auth-library"), { code: "CONFIG" });
    }
    const client = new OAuth2Client(config.google.clientId);
    let ticket;
    try {
      ticket = await client.verifyIdToken({ idToken, audience: config.google.clientId });
    } catch (e) {
      this._reject(`verify_failed:${e.message}`);
    }
    // verifyIdToken already validated signature, audience and expiry.
    return ticket.getPayload();
  }

  _verifyMock(idToken) {
    // Defense in depth: the mock verifier uses a public/default secret and must
    // NEVER run in production (the init() fail-closed check is the primary gate).
    if (config.isProduction) {
      const err = new Error("Mock Google verifier is disabled in production");
      err.code = "CONFIG";
      throw err;
    }
    const parts = String(idToken).split(".");
    if (parts.length !== 3) this._reject("malformed");
    const [head, body, sig] = parts;
    const expected = mockSign(`${head}.${body}`);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) this._reject("bad_signature");
    let payload;
    try {
      payload = JSON.parse(fromB64url(body));
    } catch {
      this._reject("bad_payload");
    }
    if (payload.aud !== MOCK_AUD) this._reject("bad_audience");
    if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) this._reject("expired");
    return payload;
  }
}

/**
 * Mint a mock Google ID token (dev/test only). Mirrors the claims a real Google
 * token carries so the verification path is exercised end-to-end offline.
 */
export function mintMockIdToken({ sub, email, name, picture, emailVerified = true, nonce, expSec = 3600 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlJson({ alg: "HS256", typ: "JWT", kid: "mock" });
  const payload = b64urlJson({
    iss: MOCK_ISS,
    aud: MOCK_AUD,
    sub: sub || "mock-sub-1",
    email,
    email_verified: emailVerified,
    name: name || null,
    picture: picture || null,
    nonce,
    iat: now,
    exp: now + expSec,
  });
  return `${header}.${payload}.${mockSign(`${header}.${payload}`)}`;
}

export default GoogleProvider;
