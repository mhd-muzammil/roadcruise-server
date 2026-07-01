import { createHash } from "crypto";

/**
 * Idempotency key = deterministic digest of (event, channel, recipient, a
 * stable business key). Prevents duplicate sends when the same domain event is
 * emitted twice (retries, double-clicks, at-least-once upstream delivery).
 *
 * The repository enforces uniqueness on this key before enqueuing.
 */
export function idempotencyKey({ event, channel, recipient, businessKey }) {
  const basis = [event, channel, recipient || "", businessKey || ""].join("|");
  return "idk_" + createHash("sha256").update(basis).digest("hex").slice(0, 32);
}

export default idempotencyKey;
