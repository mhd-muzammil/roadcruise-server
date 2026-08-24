import { deflateRawSync } from "zlib";
import { readDb } from "../../utils/db.js";

/**
 * Build the Airtel DLT "Upload Consent" workbook from customers who opted in.
 *
 * Airtel accepts ONLY .xlsx here (max 5MB), and the columns below are copied
 * verbatim from their SampleConsent.xlsx, header text included, because the
 * importer matches on it.
 *
 * WHY A HAND-ROLLED WRITER: this server runs on four production dependencies and
 * a zero-infra rule. An Excel library, to emit one flat sheet of five columns,
 * would become the largest dependency in the project. A .xlsx is a ZIP of XML
 * parts and Node can produce both with zlib alone, so it is written here.
 *
 * Values use INLINE strings rather than a shared-string table: a list of phone
 * numbers has almost no repeated values, so the table would add a part and save
 * nothing.
 */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * Minimal ZIP writer. Entries carry a FIXED timestamp so the same consent list
 * always produces a byte-identical file — a re-download can then be diffed
 * against whatever was actually uploaded.
 */
function zip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const DOS_TIME = 0;
  const DOS_DATE = 33;

  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const body = Buffer.from(data, "utf8");
    const comp = deflateRawSync(body);
    const crc = crc32(body);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, comp);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(body.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + comp.length;
  }

  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, end]);
}

const esc = (v) =>
  String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Airtel column order, header text copied exactly from their sample file. */
export const CONSENT_COLUMNS = Object.freeze([
  "Phone Number",
  "Consent Acquisition Date (dd/mm/yyyy)",
  "Brand",
  "Communication Mode",
  "Language",
]);

/** ISO timestamp to dd/mm/yyyy, the only format that header accepts. */
export function toDltDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return p(d.getDate()) + "/" + p(d.getMonth() + 1) + "/" + d.getFullYear();
}

/**
 * The consent rows to upload: customers who affirmatively opted in AND have a
 * number to attach the consent to.
 *
 * Only marketingOptIn === true qualifies. An account that merely exists is not
 * consent, and uploading it would be filing a false record with the registrar.
 */
export function consentRows(users = readDb().users || [], opts = {}) {
  const brand = opts.brand || "";
  const mode = opts.mode || "SMS";
  const language = opts.language || "English";
  return users
    .filter((u) => u && u.marketingOptIn === true)
    .map((u) => ({
      phone: String(u.phone || "").replace(/\D/g, "").slice(-10),
      date: toDltDate(u.marketingConsentAt),
      brand,
      mode,
      language,
    }))
    .filter((r) => r.phone.length === 10);
}

const XMLDECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_PKGREL = "http://schemas.openxmlformats.org/package/2006/relationships";

/** Render consent rows as an Airtel-shaped .xlsx buffer. */
export function buildConsentWorkbook(rows) {
  const cols = ["A", "B", "C", "D", "E"];
  const cell = (col, n, value) =>
    '<c r="' + col + n + '" t="inlineStr"><is><t>' + esc(value) + "</t></is></c>";

  const header = '<row r="1">' + CONSENT_COLUMNS.map((h, i) => cell(cols[i], 1, h)).join("") + "</row>";
  const body = rows
    .map((r, i) => {
      const n = i + 2;
      const vals = [r.phone, r.date, r.brand, r.mode, r.language];
      return '<row r="' + n + '">' + vals.map((v, j) => cell(cols[j], n, v)).join("") + "</row>";
    })
    .join("");

  return zip([
    {
      name: "[Content_Types].xml",
      data:
        XMLDECL +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        "</Types>",
    },
    {
      name: "_rels/.rels",
      data:
        XMLDECL +
        '<Relationships xmlns="' + NS_PKGREL + '">' +
        '<Relationship Id="rId1" Type="' + NS_REL + '/officeDocument" Target="xl/workbook.xml"/>' +
        "</Relationships>",
    },
    {
      name: "xl/workbook.xml",
      data:
        XMLDECL +
        '<workbook xmlns="' + NS_MAIN + '" xmlns:r="' + NS_REL + '">' +
        '<sheets><sheet name="Consent" sheetId="1" r:id="rId1"/></sheets></workbook>',
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data:
        XMLDECL +
        '<Relationships xmlns="' + NS_PKGREL + '">' +
        '<Relationship Id="rId1" Type="' + NS_REL + '/worksheet" Target="worksheets/sheet1.xml"/>' +
        "</Relationships>",
    },
    {
      name: "xl/worksheets/sheet1.xml",
      data:
        XMLDECL +
        '<worksheet xmlns="' + NS_MAIN + '">' +
        "<sheetData>" + header + body + "</sheetData></worksheet>",
    },
  ]);
}

export default { consentRows, buildConsentWorkbook, toDltDate, CONSENT_COLUMNS };
