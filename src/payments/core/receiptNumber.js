import { randomUUID } from "crypto";

/**
 * Human-readable, collision-resistant document numbers. Format keeps a stable
 * prefix + a compact unique suffix. The invoice number is derived from the
 * bookingId where possible so finance can correlate without a lookup.
 */
const suffix = () => randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase();

export const generateReceiptNumber = () => `RC-RCPT-${suffix()}`;

export const generateInvoiceNumber = (bookingId) => {
  const base = String(bookingId || "").replace(/^RC-BK-/, "");
  return base ? `RC-INV-${base}` : `RC-INV-${suffix()}`;
};

export const generatePaymentId = () => `RC-PAY-${suffix()}`;
