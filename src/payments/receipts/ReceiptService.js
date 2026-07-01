import { config } from "../config/payment.config.js";

/**
 * ReceiptService — produces invoice / payment-receipt / booking-receipt
 * documents as structured data + an HTML rendering (email-safe inline styles)
 * and a plain-text rendering. QR is emitted as `qrData` (a payload string a
 * renderer/Razorpay can turn into an image) — image generation and PDF output
 * are registered EXTENSION POINTS (see generatePdf), kept dependency-free by
 * default so nothing breaks without pdfkit/qrcode installed.
 *
 * No UI changes: these documents are returned via the admin API / attached to
 * notifications; the frontend is untouched.
 */
const money = (n, cur = config.currency) =>
  `${cur === "INR" ? "₹" : cur + " "}${Number(n || 0).toLocaleString("en-IN")}`;

/** A stable, scannable QR payload (upgrade to an image via the qrcode pkg later). */
export function buildQrData(payment) {
  return [
    `RC-PAYMENT`,
    `pid=${payment.paymentId}`,
    `booking=${payment.bookingId}`,
    `amt=${payment.amount}`,
    `inv=${payment.invoiceNumber || ""}`,
    `rcpt=${payment.receiptNumber || ""}`,
  ].join("|");
}

function lineItems(payment, booking) {
  const subtotal = Number(payment.amount || booking?.fare || 0);
  const tax = Number(payment.tax || 0);
  const discount = Number(payment.discount || 0);
  const total = subtotal + tax - discount;
  return { subtotal, tax, discount, total };
}

/** Structured invoice document. */
export function generateInvoice(payment, booking = {}) {
  const { subtotal, tax, discount, total } = lineItems(payment, booking);
  const doc = {
    type: "invoice",
    invoiceNumber: payment.invoiceNumber,
    receiptNumber: payment.receiptNumber,
    issuedAt: new Date().toISOString(),
    company: brand(),
    customer: { name: booking.name, phone: booking.phone },
    booking: { id: payment.bookingId, item: booking.item, tripDates: tripDates(booking) },
    payment: {
      gateway: payment.gateway,
      gatewayPaymentId: payment.gatewayPaymentId,
      method: payment.paymentMethod,
      status: payment.status,
    },
    amounts: { subtotal, tax, discount, total, currency: payment.currency },
    qrData: buildQrData(payment),
  };
  doc.html = invoiceHtml(doc);
  doc.text = invoiceText(doc);
  return doc;
}

/** Structured payment receipt (proof of payment). */
export function generateReceipt(payment, booking = {}) {
  const { total } = lineItems(payment, booking);
  const doc = {
    type: "payment_receipt",
    receiptNumber: payment.receiptNumber,
    invoiceNumber: payment.invoiceNumber,
    paidAt: payment.capturedAt || new Date().toISOString(),
    customer: { name: booking.name, phone: booking.phone },
    amount: total,
    currency: payment.currency,
    gateway: payment.gateway,
    gatewayPaymentId: payment.gatewayPaymentId,
    qrData: buildQrData(payment),
  };
  doc.html = receiptHtml(doc);
  doc.text = `Receipt ${doc.receiptNumber}: ${money(doc.amount)} paid for booking ${payment.bookingId} via ${payment.gateway}.`;
  return doc;
}

// ---- helpers ----
const brand = () => ({ name: "Road Cruise" });
const tripDates = (b) => (b.fromDate && b.toDate ? `${b.fromDate} → ${b.toDate}` : b.fromDate || "");

function invoiceHtml(d) {
  return `<table style="width:100%;max-width:600px;font-family:Arial,sans-serif;border-collapse:collapse;">
  <tr><td style="font-size:18px;font-weight:700;color:#d4af37;">${d.company.name} — Invoice</td></tr>
  <tr><td style="font-size:12px;color:#71717a;">Invoice: ${d.invoiceNumber} · Receipt: ${d.receiptNumber || "—"}</td></tr>
  <tr><td style="padding-top:12px;font-size:13px;">Customer: <b>${d.customer.name || "—"}</b><br/>Booking: <b>${d.booking.id}</b> — ${d.booking.item || ""} (${d.booking.tripDates})</td></tr>
  <tr><td style="padding-top:12px;font-size:13px;">
    Subtotal: ${money(d.amounts.subtotal)}<br/>
    Tax: ${money(d.amounts.tax)}<br/>
    Discount: -${money(d.amounts.discount)}<br/>
    <b>Total: ${money(d.amounts.total)}</b>
  </td></tr>
  <tr><td style="padding-top:8px;font-size:11px;color:#a1a1aa;">Paid via ${d.payment.gateway} (${d.payment.gatewayPaymentId || "—"})</td></tr>
</table>`;
}
function invoiceText(d) {
  return `INVOICE ${d.invoiceNumber}
Customer: ${d.customer.name || "—"}
Booking: ${d.booking.id} (${d.booking.item || ""})
Total: ${money(d.amounts.total)} via ${d.payment.gateway}`;
}
function receiptHtml(d) {
  return `<table style="width:100%;max-width:600px;font-family:Arial,sans-serif;">
  <tr><td style="font-size:18px;font-weight:700;color:#16a34a;">Payment Receipt</td></tr>
  <tr><td style="font-size:12px;color:#71717a;">${d.receiptNumber} · ${new Date(d.paidAt).toLocaleString()}</td></tr>
  <tr><td style="padding-top:10px;font-size:15px;"><b>${money(d.amount)}</b> received from ${d.customer.name || "customer"}</td></tr>
  <tr><td style="font-size:11px;color:#a1a1aa;">${d.gateway} · ${d.gatewayPaymentId || "—"}</td></tr>
</table>`;
}

/**
 * EXTENSION POINT: PDF rendering. Lazy-loads pdfkit only when called; throws a
 * clear, actionable error if it's not installed. Wire into notifications as an
 * attachment once enabled.
 */
export async function generatePdf(doc) {
  let PDFDocument;
  try {
    PDFDocument = (await import("pdfkit")).default;
  } catch {
    throw new Error("PDF generation requires 'pdfkit'. Run: npm i pdfkit (then enable in ReceiptService).");
  }
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ size: "A4", margin: 50 });
    const chunks = [];
    pdf.on("data", (c) => chunks.push(c));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);
    pdf.fontSize(18).fillColor("#d4af37").text(`${brand().name} — ${doc.type}`, { align: "left" });
    pdf.moveDown().fontSize(11).fillColor("#000").text(doc.text || JSON.stringify(doc.amounts || {}, null, 2));
    pdf.end();
  });
}

export default { generateInvoice, generateReceipt, buildQrData, generatePdf };
