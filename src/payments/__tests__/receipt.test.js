import { test } from "node:test";
import assert from "node:assert/strict";

import { generateInvoice, generateReceipt, buildQrData } from "../receipts/ReceiptService.js";

const samplePayment = {
  paymentId: "RC-PAY-RCPTTEST",
  bookingId: "RC-BK-9182",
  gateway: "mock",
  gatewayPaymentId: "pay_mock_rcpt",
  invoiceNumber: "RC-INV-9182",
  receiptNumber: "RC-RCPT-ABC123",
  currency: "INR",
  amount: 2400,
  tax: 200,
  discount: 100,
  paymentMethod: "Card",
  status: "paid",
  capturedAt: "2026-06-30T10:00:00.000Z",
};

const sampleBooking = {
  id: "RC-BK-9182",
  name: "Mohamed Vaseem",
  phone: "+91 98765 43210",
  item: "BMW 5 Series",
  fromDate: "2026-06-20",
  toDate: "2026-06-25",
  fare: 2400,
};

test("buildQrData contains the paymentId and key fields", () => {
  const qr = buildQrData(samplePayment);
  assert.equal(typeof qr, "string");
  assert.ok(qr.includes(`pid=${samplePayment.paymentId}`));
  assert.ok(qr.includes(`booking=${samplePayment.bookingId}`));
  assert.ok(qr.includes(`amt=${samplePayment.amount}`));
  assert.ok(qr.includes(`inv=${samplePayment.invoiceNumber}`));
});

test("generateInvoice computes subtotal + tax - discount = total", () => {
  const inv = generateInvoice(samplePayment, sampleBooking);
  assert.equal(inv.type, "invoice");
  assert.equal(inv.invoiceNumber, "RC-INV-9182");
  assert.equal(inv.receiptNumber, "RC-RCPT-ABC123");
  assert.equal(inv.amounts.subtotal, 2400);
  assert.equal(inv.amounts.tax, 200);
  assert.equal(inv.amounts.discount, 100);
  assert.equal(inv.amounts.total, 2400 + 200 - 100); // 2500
  assert.equal(inv.amounts.currency, "INR");
  // qrData embedded and carries the paymentId
  assert.ok(inv.qrData.includes(samplePayment.paymentId));
  // renderings present
  assert.ok(inv.html.includes("Invoice"));
  assert.ok(inv.text.includes("RC-INV-9182"));
});

test("generateInvoice falls back to booking.fare for subtotal when amount absent", () => {
  const { amount, ...noAmount } = samplePayment;
  const inv = generateInvoice({ ...noAmount, tax: 0, discount: 0 }, sampleBooking);
  assert.equal(inv.amounts.subtotal, sampleBooking.fare);
  assert.equal(inv.amounts.total, sampleBooking.fare);
});

test("generateReceipt total reflects subtotal + tax - discount and embeds paymentId", () => {
  const rcpt = generateReceipt(samplePayment, sampleBooking);
  assert.equal(rcpt.type, "payment_receipt");
  assert.equal(rcpt.receiptNumber, "RC-RCPT-ABC123");
  assert.equal(rcpt.amount, 2400 + 200 - 100); // 2500
  assert.equal(rcpt.currency, "INR");
  assert.equal(rcpt.gateway, "mock");
  assert.ok(rcpt.qrData.includes(samplePayment.paymentId));
  assert.equal(rcpt.paidAt, samplePayment.capturedAt);
  assert.ok(rcpt.text.includes("RC-RCPT-ABC123"));
});
