import express from "express";
import { requireRole } from "../auth/rbac/middleware.js";
import { Roles } from "../auth/rbac/roles.js";
import { consentRows, buildConsentWorkbook } from "../notifications/broadcast/consentExport.js";
import { readDb } from "../utils/db.js";

/**
 * Marketing-consent export for the Airtel DLT portal.
 *
 *   GET /api/consent/summary       how many customers have consented
 *   GET /api/consent/export.xlsx   that list, in Airtel's Upload Consent format
 *
 * DLT has no API for this — consent is uploaded by hand as a spreadsheet — so
 * the job here is to make the manual step one download and one upload, rather
 * than someone assembling phone numbers in Excel and getting a date format
 * wrong.
 *
 * Admin-only: this is the customer contact list.
 */
const router = express.Router();

// The Brand column must match the brand as registered on DLT. Left configurable
// because ours is currently unset there (templates show Brand DLT Id "-"), and
// guessing wrong means a rejected upload.
const brand = () => process.env.DLT_BRAND_NAME || process.env.COMPANY_NAME || "";

router.get("/summary", requireRole(Roles.ADMIN), (_req, res) => {
  // Report the DROPPED count, not just the usable one. "0 consented" is
  // indistinguishable between nobody opting in and everybody opting in without
  // a mobile number on file, and those need opposite fixes.
  const users = readDb().users || [];
  const optedIn = users.filter((u) => u && u.marketingOptIn === true);
  const rows = consentRows(users, { brand: brand() });
  res.json({
    consented: rows.length,
    optedIn: optedIn.length,
    droppedNoValidPhone: optedIn.length - rows.length,
    brand: brand(),
  });
});
router.get("/export.xlsx", requireRole(Roles.ADMIN), (_req, res) => {
  const rows = consentRows(undefined, { brand: brand() });
  const buf = buildConsentWorkbook(rows);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", 'attachment; filename="roadcruise-consent.xlsx"');
  // Announce the row count in a header so the admin UI can warn before someone
  // uploads an empty sheet and wonders why DLT still shows 0 Active.
  res.setHeader("X-Consent-Rows", String(rows.length));
  res.setHeader("X-Consent-OptedIn", String((readDb().users || []).filter((u) => u && u.marketingOptIn === true).length));
  res.send(buf);
});

export default router;
