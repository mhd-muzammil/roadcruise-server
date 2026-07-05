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
} from "../notifications/integration/hooks.js";
import { roleAtLeast, Roles } from "../auth/rbac/roles.js";
import { getPaymentService } from "../payments/index.js";
import { config as paymentConfig } from "../payments/config/payment.config.js";

// A short booking id, kept in the existing RC-BK-#### shape.
const newBookingId = () => `RC-BK-${Math.floor(1000 + Math.random() * 9000)}`;

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
  const { fromDate, toDate, tripType, item, fare, paymentMethod, paymentMode, phone, name } = req.body || {};

  if (!fromDate || !toDate || !item) {
    return res.status(400).json({ error: "Missing required booking details (item, fromDate, toDate)" });
  }
  // Fare is authoritative for the amount charged — it must be a real positive
  // number. We no longer silently invent a default (that could under/over-charge).
  const amount = Number(fare);
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: "A valid fare is required" });
  }

  const paymentsEnabled = paymentConfig.enabled;
  const wantsOnline = (paymentMode || "online") !== "arrival";
  const online = wantsOnline && paymentsEnabled;

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
    status: online ? "PendingPayment" : "Pending",
    paymentMethod: paymentMethod || (online ? "Online" : "Pay on arrival"),
    driver: "None",
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
    else if (status === "Cancelled") notifyBookingCancelled(updated);
  }
  if (driver !== undefined && driver !== existing.driver && driver !== "None") {
    notifyDriverAssigned(updated);
  }

  res.json(updated);
};

/** DELETE /api/bookings/:id  (admin only) */
export const deleteBooking = (req, res) => {
  const removed = removeBooking(req.params.id);
  if (!removed) return res.status(404).json({ error: "Booking not found" });
  res.json({ message: "Booking deleted successfully", id: req.params.id });
};
