import {
  insertBooking,
  listBookings,
  listBookingsByEmail,
  getBookingById,
  patchBooking,
  removeBooking,
} from "../utils/db.js";
import {
  notifyBookingCreated,
  notifyBookingConfirmed,
  notifyBookingCancelled,
  notifyBookingRescheduled,
  notifyDriverAssigned,
  notifyAdminBookingUnpaid,
  notifyAdminBookingCancelled,
  notifyAdminBookingModified,
} from "../notifications/integration/hooks.js";
import { roleAtLeast, Roles } from "../auth/rbac/roles.js";
import { getPaymentService } from "../payments/index.js";
import { config as paymentConfig } from "../payments/config/payment.config.js";
import { getPaymentRepository } from "../payments/repository/PaymentRepository.js";
import notifConfig from "../notifications/config/notification.config.js";
import { isVehicleAvailable } from "../services/availability.js";

// Customer-facing booking reference in the RDZ### shape (RDZ001, RDZ002, …).
// Sequential: continue from the highest existing RDZ number so references never
// collide and read cleanly. Legacy RC-BK-#### ids are ignored by the scan.
// Share of the fare collected online on the "advance" payment plan (20% now,
// balance to the driver). Keep in sync with the checkout page's display copy.
const ADVANCE_RATE = 0.2;

const newBookingId = () => {
  let max = 0;
  for (const b of listBookings()) {
    const m = /^RDZ(\d+)$/.exec(b.id || "");
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `RDZ${String(max + 1).padStart(3, "0")}`;
};

/**
 * GET /api/bookings
 * Admins/staff see every booking; a customer sees only their own. Requires a
 * valid token (req.auth is attached by requireAuth).
 */
export const getBookings = (req, res) => {
  const { role, email } = req.auth;
  const bookings = roleAtLeast(role, Roles.STAFF) ? listBookings() : listBookingsByEmail(email);
  res.json(bookings);
};

/**
 * POST /api/bookings
 * Create a booking for the signed-in user. The booking is NOT auto-confirmed:
 *   - "online"  -> status "PendingPayment"; a payment order is created and the
 *                  checkout params are returned. The booking only becomes
 *                  "Approved" after the payment is verified server-side
 *                  (payments module -> bookingBridge.confirmBooking).
 *   - "arrival" -> status "Pending"; an admin approves it manually later.
 */
export const createBooking = async (req, res) => {
  const {
    fromDate, toDate, tripType, item, fare, paymentMethod, paymentMode, phone, name,
    // Context-specific details from the vehicle / package / general forms.
    category, pickup, drop, vehicle, vehicleId, packageName, passengers, pickupTime, notes,
    // Trip-planner extras: paymentPlan "advance" pays a 20% deposit online (the
    // balance goes to the driver); distance/duration come from the route quote.
    paymentPlan, distanceKm, durationMin,
  } = req.body || {};

  if (!fromDate || !toDate || !item) {
    return res.status(400).json({ error: "Missing required booking details (item, fromDate, toDate)" });
  }
  // Fare is authoritative for the amount charged — it must be a real positive
  // number. We no longer silently invent a default (that could under/over-charge).
  const amount = Number(fare);
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: "A valid fare is required" });
  }
  // Vehicle availability: a concrete fleet vehicle can be booked only while a
  // unit is free. "No preference"/package bookings send no vehicleId and are
  // never blocked. Held units free automatically once the trip's end date
  // passes (or earlier, via cancellation / an admin release).
  if (vehicleId && !isVehicleAvailable(vehicleId)) {
    return res.status(409).json({ error: "This vehicle is already booked — please choose another." });
  }

  const paymentsEnabled = paymentConfig.enabled;
  const wantsOnline = (paymentMode || "online") !== "arrival";
  const online = wantsOnline && paymentsEnabled;

  // Advance (partial) payment: the deposit is computed HERE, never taken from
  // the client, so a tampered request can't shrink what gets charged. The
  // payment module charges advanceAmount when > 0, else the full fare.
  const plan = online && paymentPlan === "advance" ? "advance" : "full";
  const advanceAmount = plan === "advance" ? Math.max(1, Math.round(amount * ADVANCE_RATE)) : 0;

  const posInt = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  };

  const booking = {
    id: newBookingId(),
    customerEmail: req.auth.email, // owner — used for access control + "my bookings"
    name: name || req.auth.user?.name || req.auth.email,
    phone: phone || req.auth.user?.phone || "",
    fromDate,
    toDate,
    tripType: tripType || "Round-trip",
    item,
    fare: amount,
    // Deposit plan (0 advanceAmount = pay in full). balance = fare - advance is
    // collected by the driver; both amounts ride along into notifications.
    paymentPlan: plan,
    advanceAmount,
    // Route estimate captured at booking time (trip-planner flow; null for the
    // classic modal, which has no distance data).
    distanceKm: posInt(distanceKm),
    durationMin: posInt(durationMin),
    status: online ? "PendingPayment" : "Pending",
    paymentMethod:
      paymentMethod || (online ? (plan === "advance" ? "Online (20% advance)" : "Online") : "Pay on arrival"),
    driver: "None",
    // Context-specific details (persisted so both customer + admin notifications,
    // including the post-payment ones emitted by the payment module, can show
    // them). `vehicle` is the vehicle name for a vehicle booking, or the
    // preferred vehicle for a package; `packageName` names the chosen package.
    category: category || "general",
    pickup: pickup || "",
    drop: drop || "",
    vehicle: vehicle || "",
    // Concrete fleet vehicle this booking holds a unit of (null for
    // package/"no preference"). The unit frees automatically after `toDate`;
    // `vehicleReleased` lets an admin free it earlier — see services/availability.js.
    vehicleId: vehicleId || null,
    vehicleReleased: false,
    packageName: packageName || "",
    passengers: passengers || "",
    pickupTime: pickupTime || "",
    notes: notes || "",
    createdAt: new Date().toISOString(),
  };

  insertBooking(booking);

  if (online) {
    try {
      const { checkout } = await getPaymentService().createOrderForBooking({
        bookingId: booking.id,
        customerId: req.auth.email,
      });
      // 201 Created. The frontend uses `checkout` to open the payment widget.
      // Customer (invoice + confirmation) and admin (WhatsApp) notifications are
      // sent AFTER the payment is verified server-side (payments module ->
      // emitPaymentSucceeded) — nothing is sent here yet.
      return res.status(201).json({ booking, payment: "required", checkout });
    } catch (e) {
      // Payments misconfigured/unavailable: downgrade to a manual-approval
      // "Pending" booking so nothing is lost, acknowledge the customer, and
      // alert the admin to follow up.
      const pending = { ...booking, status: "Pending", paymentMethod: "Pay on arrival" };
      patchBooking(booking.id, { status: "Pending", paymentMethod: "Pay on arrival" });
      console.error("[booking] could not create payment order:", e.message);
      notifyBookingCreated(pending);
      notifyAdminBookingUnpaid(pending);
      return res.status(201).json({
        booking: pending,
        payment: "unavailable",
        warning: "Online payment is not available right now — your booking is pending manual confirmation.",
      });
    }
  }

  // Pay-on-arrival: acknowledge the customer, and alert the admin (WhatsApp) to
  // contact them and collect payment manually.
  notifyBookingCreated(booking);
  notifyAdminBookingUnpaid(booking);
  return res.status(201).json({ booking, payment: "on_arrival" });
};

/**
 * PATCH /api/bookings/:id  (admin only)
 * Update status / assign a driver. Emits lifecycle notifications only on a real
 * transition. Payment-success notifications are owned by the payment module, so
 * an admin "Approved" here just confirms the booking (e.g. a pay-on-arrival one).
 */
export const updateBooking = (req, res) => {
  const { id } = req.params;
  const { status, driver } = req.body || {};

  const existing = getBookingById(id);
  if (!existing) return res.status(404).json({ error: "Booking not found" });

  const patch = {};
  if (status !== undefined) patch.status = status;
  if (driver !== undefined) patch.driver = driver;

  const { booking: updated } = patchBooking(id, patch);

  if (status !== undefined && status !== existing.status) {
    if (status === "Approved") notifyBookingConfirmed(updated);
    else if (status === "Cancelled") {
      notifyBookingCancelled(updated);      // customer: "your booking is cancelled"
      notifyAdminBookingCancelled(updated); // business inbox: free the vehicle / refund
    }
  }
  if (driver !== undefined && driver !== existing.driver && driver !== "None") {
    notifyDriverAssigned(updated);
  }

  res.json(updated);
};

/**
 * PATCH /api/bookings/:id/cancel
 * Self-service cancellation. A customer may cancel THEIR OWN booking; staff/admins
 * may cancel any booking. Cancelling flips the status to "Cancelled", which also
 * frees the held vehicle unit automatically (availability skips Cancelled bookings
 * — see services/availability.js), and emails the customer. Idempotent: cancelling
 * an already-cancelled booking just returns it without sending a second email.
 */
export const cancelBooking = (req, res) => {
  const { id } = req.params;
  const { role, email } = req.auth;

  const existing = getBookingById(id);
  if (!existing) return res.status(404).json({ error: "Booking not found" });

  // Ownership: a customer can only cancel their own booking; staff+ can cancel any.
  const isOwner = existing.customerEmail === email;
  if (!isOwner && !roleAtLeast(role, Roles.STAFF)) {
    return res.status(403).json({ error: "You can only cancel your own bookings" });
  }

  // Already cancelled -> idempotent no-op so a double-click never emails twice.
  if (existing.status === "Cancelled") return res.json(existing);
  // A finished trip can't be cancelled.
  if (existing.status === "Completed") {
    return res.status(409).json({ error: "A completed booking cannot be cancelled" });
  }

  const { booking: updated } = patchBooking(id, { status: "Cancelled" });
  notifyBookingCancelled(updated);      // customer: "your booking is cancelled"
  notifyAdminBookingCancelled(updated); // business inbox: free the vehicle / refund
  res.json(updated);
};

/**
 * PATCH /api/bookings/:id/modify
 * Self-service trip modification from "My Bookings". A customer may edit THEIR
 * OWN booking; staff/admins may edit any. Only trip details are editable —
 * never the fare, vehicle, payment plan or status (those change what was paid
 * for). Cancelled/Completed bookings can't be modified. On a real change the
 * customer gets a "booking rescheduled" notification and the business inbox is
 * alerted so staff can re-check the schedule.
 */
const EDITABLE_FIELDS = ["fromDate", "toDate", "pickup", "drop", "passengers", "pickupTime", "notes"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const modifyBooking = (req, res) => {
  const { id } = req.params;
  const { role, email } = req.auth;

  const existing = getBookingById(id);
  if (!existing) return res.status(404).json({ error: "Booking not found" });

  const isOwner = existing.customerEmail === email;
  if (!isOwner && !roleAtLeast(role, Roles.STAFF)) {
    return res.status(403).json({ error: "You can only modify your own bookings" });
  }
  if (existing.status === "Cancelled") {
    return res.status(409).json({ error: "A cancelled booking cannot be modified" });
  }
  if (existing.status === "Completed") {
    return res.status(409).json({ error: "A completed booking cannot be modified" });
  }

  const body = req.body || {};
  const patch = {};
  for (const field of EDITABLE_FIELDS) {
    if (body[field] === undefined) continue;
    const value = String(body[field]).trim().slice(0, 500);
    if (value !== String(existing[field] ?? "")) patch[field] = value;
  }

  if (patch.fromDate !== undefined || patch.toDate !== undefined) {
    const fromDate = patch.fromDate ?? existing.fromDate;
    const toDate = patch.toDate ?? existing.toDate;
    if (!DATE_RE.test(fromDate) || !DATE_RE.test(toDate)) {
      return res.status(400).json({ error: "Trip dates must be valid dates (YYYY-MM-DD)" });
    }
    if (toDate < fromDate) {
      return res.status(400).json({ error: "The trip end date cannot be before the start date" });
    }
  }

  // Nothing actually changed -> idempotent no-op, no notifications.
  if (Object.keys(patch).length === 0) return res.json(existing);

  const { booking: updated } = patchBooking(id, patch);
  notifyBookingRescheduled(updated);   // customer: "your booking was updated"
  notifyAdminBookingModified(updated); // business inbox: re-check the schedule
  res.json(updated);
};

/** DELETE /api/bookings/:id  (admin only) */
export const deleteBooking = (req, res) => {
  const removed = removeBooking(req.params.id);
  if (!removed) return res.status(404).json({ error: "Booking not found" });
  res.json({ message: "Booking deleted successfully", id: req.params.id });
};

/**
 * GET /api/bookings/:id/invoice
 * Downloadable invoice for the customer — the same document the invoice email
 * carries, rendered as a self-contained, print-friendly HTML page (browser
 * "Print → Save as PDF" gives a PDF). Owner-only (staff+ can fetch any). Works
 * for paid AND unpaid bookings: unpaid ones show the balance due.
 */
export const getBookingInvoice = (req, res) => {
  const { id } = req.params;
  const { role, email } = req.auth;

  const booking = getBookingById(id);
  if (!booking) return res.status(404).json({ error: "Booking not found" });

  const isOwner = booking.customerEmail === email;
  if (!isOwner && !roleAtLeast(role, Roles.STAFF)) {
    return res.status(403).json({ error: "You can only download your own invoices" });
  }

  // The paid payment (if any) supplies the real invoice/receipt numbers and the
  // gateway reference. Missing payment records must never block the download.
  let payment = null;
  try {
    const payments = getPaymentRepository().findByBookingId(id);
    payment =
      payments.find((p) => ["captured", "paid", "partially_refunded", "refunded"].includes(p.status)) ||
      null;
  } catch (e) {
    console.error("[booking] invoice payment lookup failed:", e.message);
  }

  const html = renderInvoiceHtml(booking, payment);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="RoadCruise-Invoice-${booking.id}.html"`);
  res.send(html);
};

// ---- invoice rendering ------------------------------------------------------

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const inr = (n) => `₹${Number(n || 0).toLocaleString("en-IN")}`;

const STATUS_LABELS = {
  Approved: "Confirmed",
  PendingPayment: "Awaiting payment",
  Pending: "Pending confirmation",
  Cancelled: "Cancelled",
  Completed: "Completed",
};

function renderInvoiceHtml(booking, payment) {
  const brand = notifConfig.branding;
  const invoiceNumber = payment?.invoiceNumber || `RC-INV-${booking.id}`;
  const paidAmount = payment ? Number(payment.amount || 0) : 0;
  const fare = Number(booking.fare || 0);
  const balance = Math.max(0, fare - paidAmount);
  const statusLabel = STATUS_LABELS[booking.status] || booking.status;
  const isPackage = booking.category === "package" || booking.packageName;

  const detail = (label, value) =>
    value
      ? `<tr><td class="dl">${esc(label)}</td><td class="dv">${esc(value)}</td></tr>`
      : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Invoice ${esc(invoiceNumber)} — ${esc(brand.companyName)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; background: #f4f4f5; color: #18181b; padding: 24px 12px; }
  .sheet { max-width: 640px; margin: 0 auto; background: #fff; border-radius: 14px; overflow: hidden; border: 1px solid #e4e4e7; }
  .head { background: #0f0f12; color: #fff; padding: 26px 30px; display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
  .brand { font-size: 22px; font-weight: 700; color: #d4af37; }
  .brand small { display: block; font-size: 11px; font-weight: 400; color: #a1a1aa; margin-top: 3px; }
  .doc { text-align: right; }
  .doc h1 { font-size: 14px; letter-spacing: 3px; text-transform: uppercase; color: #fff; }
  .doc p { font-size: 11px; color: #a1a1aa; margin-top: 4px; }
  .body { padding: 26px 30px; }
  .meta { display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 20px; }
  .meta h2 { font-size: 10px; text-transform: uppercase; letter-spacing: 1.5px; color: #a1a1aa; margin-bottom: 5px; }
  .meta p { font-size: 13px; line-height: 1.55; }
  .badge { display: inline-block; font-size: 11px; font-weight: 700; padding: 4px 10px; border-radius: 999px; background: #fef3c7; color: #92400e; }
  .badge.paid { background: #dcfce7; color: #166534; }
  .badge.cancelled { background: #fee2e2; color: #991b1b; }
  table.details { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
  table.details td { padding: 8px 10px; font-size: 13px; border-bottom: 1px solid #f4f4f5; }
  td.dl { color: #71717a; width: 38%; }
  td.dv { font-weight: 600; }
  table.amounts { width: 100%; border-collapse: collapse; background: #fafafa; border-radius: 10px; overflow: hidden; }
  table.amounts td { padding: 9px 14px; font-size: 13px; }
  table.amounts td:last-child { text-align: right; font-weight: 600; }
  table.amounts tr.total td { border-top: 2px solid #d4af37; font-size: 15px; font-weight: 700; }
  .pay { margin-top: 14px; font-size: 12px; color: #71717a; }
  .foot { padding: 18px 30px; border-top: 1px solid #f4f4f5; font-size: 11px; color: #a1a1aa; line-height: 1.6; }
  .print-btn { display: block; width: 100%; margin-top: 22px; padding: 12px; background: #d4af37; color: #0f0f12; font-weight: 700; font-size: 13px; border: 0; border-radius: 10px; cursor: pointer; }
  @media print {
    body { background: #fff; padding: 0; }
    .sheet { border: 0; border-radius: 0; max-width: none; }
    .print-btn { display: none; }
  }
</style>
</head>
<body>
<div class="sheet">
  <div class="head">
    <div class="brand">${esc(brand.companyName)}<small>${esc(brand.websiteUrl)}</small></div>
    <div class="doc">
      <h1>Invoice</h1>
      <p>${esc(invoiceNumber)}${payment?.receiptNumber ? ` · Receipt ${esc(payment.receiptNumber)}` : ""}</p>
      <p>Issued ${new Date().toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</p>
    </div>
  </div>
  <div class="body">
    <div class="meta">
      <div>
        <h2>Billed to</h2>
        <p><strong>${esc(booking.name || "—")}</strong><br/>${esc(booking.customerEmail || "")}${booking.phone ? `<br/>${esc(booking.phone)}` : ""}</p>
      </div>
      <div>
        <h2>Booking</h2>
        <p><strong>${esc(booking.id)}</strong><br/>
        <span class="badge ${paidAmount > 0 ? "paid" : booking.status === "Cancelled" ? "cancelled" : ""}">${esc(statusLabel)}</span></p>
      </div>
    </div>

    <table class="details">
      ${detail("Service", booking.item)}
      ${isPackage ? detail("Package", booking.packageName) : ""}
      ${detail(isPackage ? "Vehicle preference" : "Vehicle", booking.vehicle)}
      ${detail("Trip type", booking.tripType)}
      ${detail("Trip dates", `${booking.fromDate} → ${booking.toDate}`)}
      ${detail("Pickup", booking.pickup)}
      ${detail("Drop", booking.drop)}
      ${detail("Pickup time", booking.pickupTime)}
      ${detail("Passengers", booking.passengers)}
      ${booking.distanceKm ? detail("Distance (est.)", `${booking.distanceKm} km`) : ""}
    </table>

    <table class="amounts">
      <tr><td>Trip fare</td><td>${inr(fare)}</td></tr>
      ${paidAmount > 0 ? `<tr><td>Paid online${payment?.gateway ? ` (${esc(payment.gateway)})` : ""}</td><td>− ${inr(paidAmount)}</td></tr>` : ""}
      <tr class="total"><td>${paidAmount > 0 ? (balance > 0 ? "Balance to driver" : "Balance") : "Balance due"}</td><td>${inr(balance)}</td></tr>
    </table>

    <p class="pay">
      Payment: ${esc(booking.paymentMethod || "—")}${payment?.gatewayPaymentId ? ` · Ref ${esc(payment.gatewayPaymentId)}` : ""}
    </p>

    <button class="print-btn" onclick="window.print()">Print / Save as PDF</button>
  </div>
  <div class="foot">
    ${esc(brand.companyName)} · ${esc(brand.supportPhone)} · ${esc(brand.supportEmail)}<br/>
    This is a computer-generated invoice for booking ${esc(booking.id)} and does not require a signature.
  </div>
</div>
</body>
</html>`;
}
