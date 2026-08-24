/** The Airtel Upload Consent workbook: shape, selection and date format. */
const { consentRows, buildConsentWorkbook, toDltDate, CONSENT_COLUMNS } =
  await import("../src/notifications/broadcast/consentExport.js");
const { deflateRawSync, inflateRawSync } = await import("zlib");

let pass = 0, fail = 0;
const check = (l, c, x = "") => { if (c) { pass++; console.log(`  ok   ${l}`); } else { fail++; console.log(`  FAIL ${l} ${x}`); } };

console.log("\n1. dd/mm/yyyy, zero-padded (the only format Airtel's header accepts)");
check("pads single digits", toDltDate("2026-01-05T10:00:00.000Z") === "05/01/2026", toDltDate("2026-01-05T10:00:00.000Z"));
check("day comes first, not month", toDltDate("2026-08-24T05:00:00.000Z").startsWith("24/"), toDltDate("2026-08-24T05:00:00.000Z"));
check("garbage yields empty, not 'Invalid Date'", toDltDate(undefined) === "");

console.log("\n2. only affirmative consent is uploaded");
const users = [
  { phone: "6380422961",      marketingOptIn: true,  marketingConsentAt: "2026-08-24T05:31:00Z" },
  { phone: "+91 91234 56780", marketingOptIn: true,  marketingConsentAt: "2026-01-05T10:00:00Z" },
  { phone: "9999999999",      marketingOptIn: false, marketingConsentAt: "2026-08-24T05:31:00Z" },
  { phone: "9888888888" },                                    // never asked
  { phone: "",                marketingOptIn: true,  marketingConsentAt: "2026-08-24T05:31:00Z" },
  { phone: "12345",           marketingOptIn: true,  marketingConsentAt: "2026-08-24T05:31:00Z" },
];
const rows = consentRows(users, { brand: "BRAND" });
check("opted-in only", rows.length === 2, String(rows.length));
check("normalises +91 to bare 10 digits", rows[1].phone === "9123456780", rows[1].phone);
check("drops unusable numbers", !rows.some((r) => r.phone.length !== 10));
check("carries the configured brand", rows.every((r) => r.brand === "BRAND"));
check("defaults mode/language", rows[0].mode === "SMS" && rows[0].language === "English");

console.log("\n3. the file is a real xlsx");
const buf = buildConsentWorkbook(rows);
check("ZIP magic", buf.slice(0, 2).toString() === "PK");
check("end-of-central-directory present", buf.slice(-22).readUInt32LE(0) === 0x06054b50);
check("under Airtel's 5MB cap", buf.length < 5 * 1024 * 1024);

// Walk the local headers, inflate each part, prove the sheet round-trips.
const parts = {};
let off = 0;
while (buf.readUInt32LE(off) === 0x04034b50) {
  const nameLen = buf.readUInt16LE(off + 26), extraLen = buf.readUInt16LE(off + 28);
  const compSize = buf.readUInt32LE(off + 18);
  const name = buf.slice(off + 30, off + 30 + nameLen).toString();
  const start = off + 30 + nameLen + extraLen;
  parts[name] = inflateRawSync(buf.slice(start, start + compSize)).toString();
  off = start + compSize;
}
check("has all five OOXML parts", Object.keys(parts).length === 5, Object.keys(parts).join(","));
const sheet = parts["xl/worksheets/sheet1.xml"];
check("sheet part present", !!sheet);
for (const col of CONSENT_COLUMNS) check(`header "${col.slice(0, 22)}…" written`, sheet.includes(col));
check("a data row round-trips", sheet.includes("6380422961") && sheet.includes("24/08/2026"));
check("row count = header + rows", (sheet.match(/<row /g) || []).length === rows.length + 1);

console.log("\n4. empty consent list still yields a valid file (header only)");
const empty = buildConsentWorkbook([]);
check("valid zip", empty.slice(0, 2).toString() === "PK");
check("header row only", (inflateRawSync(
  (() => { let o = 0; while (empty.readUInt32LE(o) === 0x04034b50) {
    const nl = empty.readUInt16LE(o + 26), el = empty.readUInt16LE(o + 28), cs = empty.readUInt32LE(o + 18);
    const nm = empty.slice(o + 30, o + 30 + nl).toString(); const st = o + 30 + nl + el;
    if (nm === "xl/worksheets/sheet1.xml") return empty.slice(st, st + cs);
    o = st + cs; } return Buffer.alloc(0); })()
).toString().match(/<row /g) || []).length === 1);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
