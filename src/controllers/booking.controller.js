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
  notifyDriverAssigned,
  notifyAdminBookingUnpaid,
  notifyAdminBookingCancelled,
} from "../notifications/integration/hooks.js";
import { roleAtLeast, Roles } from "../auth/rbac/roles.js";
import { getPaymentService } from "../payments/index.js";
import { config as paymentConfig } from "../payments/config/payment.config.js";
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

/** DELETE /api/bookings/:id  (admin only) */
export const deleteBooking = (req, res) => {
  const removed = removeBooking(req.params.id);
  if (!removed) return res.status(404).json({ error: "Booking not found" });
  res.json({ message: "Booking deleted successfully", id: req.params.id });
};
