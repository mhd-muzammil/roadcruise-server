import { Channels } from "../config/events.js";

/**
 * Lenient recipient validation/normalization performed at fan-out time. Invalid
 * recipients are skipped (with an audit record) rather than sent — preventing
 * provider errors and bad/abusive addresses from entering the queue.
 *
 * Intentionally permissive (this ERP stores phones like "+91 98765 43210"):
 *   - email: basic RFC-ish shape check.
 *   - sms/whatsapp: strip to digits, require 10–15 (E.164-ish), normalize.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateRecipient(channel, value) {
  if (value == null || value === "") return { ok: false, reason: "empty" };
  const v = String(value).trim();

  if (channel === Channels.EMAIL) {
    if (v.length > 254 || !EMAIL_RE.test(v)) return { ok: false, reason: "invalid_email" };
    return { ok: true, normalized: v.toLowerCase() };
  }

  // sms / whatsapp -> phone
  const digits = v.replace(/[^\d]/g, "");
  if (digits.length < 10 || digits.length > 15) return { ok: false, reason: "invalid_phone" };
  // Preserve a leading + if present, else return digits.
  const normalized = v.startsWith("+") ? `+${digits}` : digits;
  return { ok: true, normalized };
}

export default validateRecipient;
