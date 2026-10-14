// Corporate (GST) billing details — what a business customer needs printed on
// a tax invoice so they can claim input tax credit: the registered company
// name, its GSTIN and its billing address. Stored on the user's profile (as
// the default) and copied onto each booking it was used for, so an old
// invoice never changes when the profile is edited later.

// 15 chars: 2-digit state code, 10-char PAN, entity no., "Z", check char.
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

// Our own registration's state (Tamil Nadu = 33). A customer GSTIN from the
// same state is billed CGST + SGST; any other state, IGST.
const HOME_STATE_CODE = "33";

export const isValidGstin = (v) => GSTIN_RE.test(String(v || "").trim().toUpperCase());

/**
 * Normalize user-entered billing details. Returns { billing } (null when every
 * field is empty — the customer doesn't want a GST invoice) or { error }.
 */
export function cleanBilling(raw) {
  if (raw === null || raw === undefined) return { billing: null };
  if (typeof raw !== "object") return { error: "Invalid GST details" };
  const companyName = String(raw.companyName ?? "").trim().slice(0, 120);
  const gstin = String(raw.gstin ?? "").replace(/\s+/g, "").toUpperCase().slice(0, 15);
  const address = String(raw.address ?? "").trim().slice(0, 300);
  if (!companyName && !gstin && !address) return { billing: null };
  if (!gstin) return { error: "Enter the company's GSTIN" };
  if (!isValidGstin(gstin)) return { error: "Enter a valid 15-character GSTIN (e.g. 33AALCK3303L1ZL)" };
  if (!companyName) return { error: "Enter the registered company name" };
  return { billing: { companyName, gstin, address } };
}

/**
 * How the GST on an invoice is split for a business customer: same state as
 * us -> half CGST + half SGST; another state -> all IGST. Returns null when
 * there is no customer GSTIN (B2C invoices show one combined GST line).
 */
export function gstSplit(gstin) {
  if (!isValidGstin(gstin)) return null;
  return String(gstin).slice(0, 2) === HOME_STATE_CODE ? "intra" : "inter";
}

export default { isValidGstin, cleanBilling, gstSplit };
