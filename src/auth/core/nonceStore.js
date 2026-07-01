import { randomUUID, timingSafeEqual } from "crypto";
import { config } from "../config/auth.config.js";

/**
 * One-time nonce/state store for OAuth replay protection.
 *
 *  - issue() mints a cryptographically-random nonce with a TTL.
 *  - consume(nonce) validates it timing-safely and BURNS it (single use), so a
 *    captured id token cannot be replayed with the same nonce.
 *
 * In-memory by default (zero-infra). For multi-instance deployments, back this
 * with Redis behind the same interface. Expired entries are swept lazily.
 */
const store = new Map(); // nonce -> expiresAt(ms) (insertion-ordered)
const MAX_NONCES = 50000; // hard cap to bound memory (M1: /nonce spam DoS)

function sweep() {
  const now = Date.now();
  for (const [k, exp] of store) if (exp <= now) store.delete(k);
}

export function issueNonce() {
  sweep();
  // Bound memory: if still at capacity after sweeping expired entries, evict the
  // oldest (FIFO) so an attacker spamming /nonce cannot exhaust the heap.
  while (store.size >= MAX_NONCES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
  const nonce = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  store.set(nonce, Date.now() + config.nonceTtlSec * 1000);
  return nonce;
}

/** Validate + burn a nonce. @returns {boolean} */
export function consumeNonce(nonce) {
  if (!nonce) return false;
  sweep();
  // constant-time membership check across stored keys
  let matchedKey = null;
  const nb = Buffer.from(String(nonce));
  for (const k of store.keys()) {
    const kb = Buffer.from(k);
    if (kb.length === nb.length && timingSafeEqual(kb, nb)) {
      matchedKey = k;
      break;
    }
  }
  if (!matchedKey) return false;
  const exp = store.get(matchedKey);
  store.delete(matchedKey); // burn (single-use)
  return exp > Date.now();
}

/** test/debug only */
export function _size() {
  return store.size;
}

export default { issueNonce, consumeNonce };
