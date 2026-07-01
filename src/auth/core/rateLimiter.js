import { config } from "../config/auth.config.js";

/**
 * Dependency-free in-memory sliding-window rate limiter (per key = ip+route).
 * Bounds brute-force / abuse on auth endpoints. For multi-instance deployments,
 * back this with Redis behind the same middleware contract.
 *
 * NOTE: this is per-IP request throttling; per-ACCOUNT lockout (failed-attempt
 * counting + temporary lock) is enforced separately on the user record in
 * userService — the two layers are complementary.
 */
const buckets = new Map(); // key -> number[] (timestamps)
let lastSweep = 0;

function sweep(now, windowMs) {
  if (now - lastSweep < windowMs) return;
  lastSweep = now;
  for (const [k, arr] of buckets) {
    const kept = arr.filter((t) => now - t < windowMs);
    if (kept.length) buckets.set(k, kept);
    else buckets.delete(k);
  }
}

export function rateLimit({ windowMs, max, name = "rl" }) {
  return function rateLimitMiddleware(req, res, next) {
    const now = Date.now();
    sweep(now, windowMs);
    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    const key = `${name}:${ip}`;
    const arr = (buckets.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) {
      const retryMs = windowMs - (now - arr[0]);
      res.set("Retry-After", String(Math.ceil(retryMs / 1000)));
      return res.status(429).json({ error: "Too many requests. Please slow down and try again shortly." });
    }
    arr.push(now);
    buckets.set(key, arr);
    next();
  };
}

export const loginLimiter = () => rateLimit({ windowMs: config.rateLimit.windowMs, max: config.rateLimit.maxLogin, name: "login" });
export const sensitiveLimiter = () => rateLimit({ windowMs: config.rateLimit.windowMs, max: config.rateLimit.maxSensitive, name: "sensitive" });

export default { rateLimit, loginLimiter, sensitiveLimiter };
