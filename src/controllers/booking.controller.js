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
import { getPackage } from "../db/packages.db.js";
import { getVehicle, listVehicles } from "../db/vehicles.db.js";
import { buildTableWorkbook } from "../notifications/broadcast/consentExport.js";
import {
  TRIP_TYPES, GST_RATE_PERCENT, STOP_TRIP_TYPES, MAX_STOPS,
  quotePackage, quoteVehicleIndicative, quoteEstimate, quoteTripClosure,
} from "../services/pricing.js";
import { normalizeTrip, daysForTrip, routeForTrip, quoteTripVehicle } from "../services/tripQuote.js";
import {
  formatINR, pricingOf, stopLabels, rentalLabel, distanceLabel, balanceDue, finalTotal,
} from "../services/bookingView.js";

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
 * POST /api/bookings/quote  (public)
 * Server-priced quotes for every vehicle that can serve a trip-planner search.
 * The results page renders these, and createBooking re-prices with the same
 * code, so the amount shown is the amount charged.
 */
export const quoteTrip = async (req, res) => {
  const { trip, error } = normalizeTrip(req.body?.trip);
  if (error) return res.status(400).json({ error });

  const route = await routeForTrip(trip);
  const quotes = listVehicles()
    .map((v) => {
      const q = quoteTripVehicle(v, trip, route);
      return q && { vehicleId: v.id, ...q };
    })
    .filter(Boolean);
  res.json({ route, days: daysForTrip(trip), gstRate: GST_RATE_PERCENT, advanceRate: ADVANCE_RATE, quotes });
};

/**
 * Price a booking request. Every amount comes from server-side data — the
 * trip-planner route + vehicle rates, an admin package price, or a vehicle's
 * listed local-package rate. Only a booking with no server-side rate at all
 * (a general enquiry with no vehicle) records the client's estimate, and such
 * bookings are never charged online.
 * Returns { priced, trip, route, vehicleRec } or { status, error }.
 */
async function priceBookingRequest(body, pkg) {
  const { trip: rawTrip, vehicleId, fare } = body;

  if (rawTrip) {
    const { trip, error } = normalizeTrip(rawTrip);
    if (error) return { status: 400, error };
    const vehicleRec = vehicleId ? getVehicle(vehicleId) : null;
    if (!vehicleRec || !vehicleRec.active) return { status: 400, error: "Please choose a vehicle for this trip." };
    const route = await routeForTrip(trip);
    const priced = quoteTripVehicle(vehicleRec, trip, route);
    if (!priced) return { status: 400, error: "This vehicle can't be booked for this trip type." };
    return { priced, trip, route, vehicleRec };
  }

  if (pkg) {
    const priced = quotePackage(pkg);
    if (priced) return { priced };
  }
  // A trip-planner checkout from a browser still running the pre-server-pricing
  // bundle sends a route estimate but no `trip`. It can't be re-priced, so keep
  // the fare the customer was shown as a team-confirmed estimate (never charged
  // online) instead of mis-pricing it at the vehicle's local-package rate.
  const legacyPlannerFare = body.distanceKm !== undefined && Number(fare) > 0;
  const vehicleRec = vehicleId && !legacyPlannerFare ? getVehicle(vehicleId) : null;
  if (vehicleRec) {
    const priced = quoteVehicleIndicative(vehicleRec);
    if (priced) return { priced, vehicleRec };
  }
  const amount = Number(fare);
  if (!Number.isFinite(amount) || amount <= 0) return { status: 400, error: "A valid fare is required" };
  return { priced: quoteEstimate(amount) };
}

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
  const body = req.body || {};
  const {
    tripType, paymentMethod, paymentMode, phone, name,
    // Context-specific details from the vehicle / package / general forms.
    category, pickup, drop, vehicle, vehicleId, packageName, passengers, pickupTime, notes,
    // paymentPlan "advance" pays a deposit online (the balance goes to the driver).
    paymentPlan, distanceKm, durationMin,
    // Admin-managed package being booked (decides the allowed payment mode).
    packageId,
  } = body;

  // Trip-planner bookings carry a structured `trip`; dates and the item come
  // from it. The classic booking form sends them directly.
  if (!body.trip && (!body.fromDate || !body.toDate || !body.item)) {
    return res.status(400).json({ error: "Missing required booking details (item, fromDate, toDate)" });
  }
  // Vehicles are never blocked for availability: the business can always
  // arrange a vehicle, so every configured vehicle stays bookable. Held units
  // are still tracked for the admin's fleet view (services/availability.js).

  // A package's admin-chosen payment mode overrides whatever the client sent:
  //   offline -> never charged online; online -> always paid in full online;
  //   partial -> always the package's advance percentage online.
  const pkg = packageId ? getPackage(packageId) : null;
  if (packageId && !pkg) return res.status(404).json({ error: "This package is no longer available." });
  let reqMode = paymentMode;
  let reqPlan = paymentPlan;
  let advanceRate = ADVANCE_RATE;
  if (pkg) {
    if (pkg.paymentMode === "offline") reqMode = "arrival";
    else if (pkg.paymentMode === "online") { reqMode = "online"; reqPlan = "full"; }
    else { reqMode = "online"; reqPlan = "advance"; advanceRate = pkg.advancePercent / 100; }
  }

  const quote = await priceBookingRequest(body, pkg);
  if (quote.error) return res.status(quote.status).json({ error: quote.error });
  const { priced, trip, route, vehicleRec } = quote;
  // The GST-inclusive total is what's charged; payments, analytics and the
  // invoice all read it from `fare`.
  const amount = priced.pricing.total;
  const estimateOnly = priced.pricing.source === "estimate";

  const paymentsEnabled = paymentConfig.enabled;
  const wantsOnline = (reqMode || "online") !== "arrival";
  // An unpriced estimate is confirmed by the team first — never charged online.
  const online = wantsOnline && paymentsEnabled && !estimateOnly;

  // Advance (partial) payment: the deposit is computed HERE, never taken from
  // the client, so a tampered request can't shrink what gets charged. The
  // payment module charges advanceAmount when > 0, else the full fare.
  const plan = online && reqPlan === "advance" ? "advance" : "full";
  const advanceAmount = plan === "advance" ? Math.max(1, Math.round(amount * advanceRate)) : 0;
  const defaultMethod = online
    ? (plan === "advance" ? `Online (${Math.round(advanceRate * 100)}% advance)` : "Online")
    : "Pay on arrival";

  const posInt = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  };

  const text = (v, max = 500) => String(v ?? "").trim().slice(0, max);

  const booking = {
    id: newBookingId(),
    customerEmail: req.auth.email, // owner — used for access control + "my bookings"
    name: name || req.auth.user?.name || req.auth.email,
    phone: phone || req.auth.user?.phone || "",
    fromDate: trip ? trip.date : body.fromDate,
    toDate: trip ? (trip.type === "roundtrip" ? trip.returnDate : trip.date) : body.toDate,
    tripType: trip ? TRIP_TYPES[trip.type] : tripType || "Round-trip",
    // Trip-planner trip type key (airport/oneway/roundtrip/hourly); null for
    // the classic form.
    tripKind: trip ? trip.type : null,
    item: trip ? vehicleRec.name : body.item,
    // GST-inclusive total payable (= pricing.total).
    fare: amount,
    // Itemised breakdown — lines, subtotal, GST, total — rendered verbatim by
    // My Bookings, the admin log, notifications and the invoice.
    pricing: priced.pricing,
    inclusions: priced.included || [],
    exclusions: priced.excluded || [],
    // Deposit plan (0 advanceAmount = pay in full). balance = fare - advance is
    // collected by the driver; both amounts ride along into notifications.
    paymentPlan: plan,
    advanceAmount,
    // Route captured at booking time. Trip-planner bookings use the server's
    // own route (through every stop); the classic form has no distance data.
    distanceKm: route ? route.distanceKm : posInt(distanceKm),
    durationMin: route ? route.durationMin : posInt(durationMin),
    // Intermediate stops, in travel order: [{ label, lat, lon }].
    stops: trip ? trip.stops : [],
    // Hourly rental package actually booked: { key, label, hours, kms }.
    rental: priced.rental || null,
    days: trip ? daysForTrip(trip) : null,
    returnTime: trip ? trip.returnTime : "",
    status: online ? "PendingPayment" : "Pending",
    // Package bookings: the label always reflects the admin-set mode.
    paymentMethod: pkg || !online ? defaultMethod : paymentMethod || defaultMethod,
    driver: "None",
    // Context-specific details (persisted so both customer + admin notifications,
    // including the post-payment ones emitted by the payment module, can show
    // them). `vehicle` is the vehicle name for a vehicle booking, or the
    // preferred vehicle for a package; `packageName` names the chosen package.
    category: trip ? "vehicle" : category || "general",
    pickup: trip ? trip.pickup.label : text(pickup),
    drop: trip ? trip.drop?.label || "" : text(drop),
    vehicle: trip ? vehicleRec.name : vehicle || "",
    // Concrete fleet vehicle this booking holds a unit of (null for
    // package/"no preference"). The unit frees automatically after `toDate`;
    // `vehicleReleased` lets an admin free it earlier — see services/availability.js.
    vehicleId: vehicleRec ? vehicleRec.id : vehicleId || null,
    vehicleReleased: false,
    packageName: packageName || "",
    passengers: passengers || "",
    pickupTime: trip ? trip.time : pickupTime || "",
    notes: text(notes, 1000),
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
 * Update status / assign the cab + driver. Emits lifecycle notifications only on
 * a real transition. Payment-success notifications are owned by the payment
 * module, so an admin "Approved" here just confirms the booking (e.g. a
 * pay-on-arrival one).
 *
 * `assignment` = { cabNumber, vehicleType, driverName, driverPhone, paymentMode }
 * is what the customer sees on My Bookings. `driver` mirrors driverName so the
 * notification templates ({{driver}}) keep working unchanged. `assignment: null`
 * unassigns.
 */
const ASSIGNMENT_FIELDS = { cabNumber: 20, vehicleType: 60, driverName: 80, driverPhone: 20, paymentMode: 40 };

function cleanAssignment(raw) {
  if (!raw || typeof raw !== "object") return { error: "Invalid assignment" };
  const out = {};
  for (const [k, max] of Object.entries(ASSIGNMENT_FIELDS)) out[k] = String(raw[k] ?? "").trim().slice(0, max);
  out.cabNumber = out.cabNumber.toUpperCase();
  if (!out.driverName) return { error: "Driver name is required" };
  if (!out.cabNumber) return { error: "Cab number is required" };
  if (out.driverPhone && !/^\+?[0-9\s-]{10,15}$/.test(out.driverPhone)) {
    return { error: "Enter a valid driver phone number" };
  }
  return { assignment: out };
}

export const updateBooking = (req, res) => {
  const { id } = req.params;
  const { status, driver, assignment } = req.body || {};

  const existing = getBookingById(id);
  if (!existing) return res.status(404).json({ error: "Booking not found" });

  const patch = {};
  if (status !== undefined) patch.status = status;
  if (driver !== undefined) patch.driver = driver;
  if (assignment === null) {
    patch.assignment = null;
    patch.driver = "None";
  } else if (assignment !== undefined) {
    const { assignment: clean, error } = cleanAssignment(assignment);
    if (error) return res.status(400).json({ error });
    patch.assignment = { ...clean, assignedAt: new Date().toISOString() };
    patch.driver = clean.driverName;
  }

  const { booking: updated } = patchBooking(id, patch);

  if (status !== undefined && status !== existing.status) {
    if (status === "Approved") notifyBookingConfirmed(updated);
    else if (status === "Cancelled") {
      notifyBookingCancelled(updated);      // customer: "your booking is cancelled"
      notifyAdminBookingCancelled(updated); // business inbox: free the vehicle / refund
    }
  }
  if (patch.driver !== undefined && patch.driver !== existing.driver && patch.driver !== "None") {
    notifyDriverAssigned(updated);
  }

  res.json(updated);
};

/**
 * PATCH /api/bookings/:id/close  (admin only)
 * Close a finished trip with its actual odometer km. Anything beyond the km the
 * booked fare covered is billed at the per-km rate (+ GST), along with optional
 * extra charges and tolls/parking; the result is stored as `tripClosure` and
 * the booking becomes "Completed". The original `pricing` stays untouched — it
 * is the pre-invoice; booked fare + tripClosure is the post-trip invoice.
 * Closing again replaces the previous closure (corrections).
 *
 * body: { actualKm, includedKm?, extraKmRate?, otherAmount?, otherLabel?, tolls? }
 */
export const closeTrip = (req, res) => {
  const { id } = req.params;
  const body = req.body || {};

  const existing = getBookingById(id);
  if (!existing) return res.status(404).json({ error: "Booking not found" });
  if (existing.status === "Cancelled") {
    return res.status(409).json({ error: "A cancelled booking cannot be closed" });
  }

  const actualKm = Number(body.actualKm);
  if (!Number.isFinite(actualKm) || actualKm <= 0) {
    return res.status(400).json({ error: "Enter the actual km driven" });
  }

  const p = existing.pricing || {};
  const vehicleRec = existing.vehicleId ? getVehicle(existing.vehicleId) : null;
  const isHourly = existing.tripKind === "hourly" || !!existing.rental?.kms;
  const pick = (v, fallback) => (v === undefined || v === null || v === "" ? fallback : Number(v));

  const includedKm = pick(
    body.includedKm,
    Number(p.billKm) || Number(existing.rental?.kms) || Number(existing.distanceKm) || 0
  );
  // Hourly rentals bill the excess at the vehicle's local "extra km" tariff;
  // trips at the per-km rate they were priced with.
  const defaultRate = isHourly
    ? Number(vehicleRec?.localPricing?.extraKm) || Number(p.perKm) || 0
    : Number(p.perKm) || Number(vehicleRec?.outstationRate) || 0;
  const extraKmRate = pick(body.extraKmRate, defaultRate);
  if (![includedKm, extraKmRate].every((n) => Number.isFinite(n) && n >= 0)) {
    return res.status(400).json({ error: "Included km and rate must be valid numbers" });
  }
  if (actualKm > includedKm && extraKmRate <= 0) {
    return res.status(400).json({ error: "Enter the extra km rate (₹/km) for this trip" });
  }

  const closure = quoteTripClosure({
    includedKm, actualKm, extraKmRate,
    otherAmount: body.otherAmount,
    otherLabel: String(body.otherLabel ?? "").slice(0, 80),
    tolls: body.tolls,
  });
  const tripClosure = { ...closure, closedAt: new Date().toISOString(), closedBy: req.auth?.email || "" };

  const { booking: updated } = patchBooking(id, { tripClosure, status: "Completed" });
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

// Stops are editable where the booking supports them: outstation trip-planner
// bookings, and classic-form vehicle bookings (no tripKind). Airport, hourly
// and package bookings have no stops.
const stopsEditable = (b) =>
  STOP_TRIP_TYPES.includes(b.tripKind) || (!b.tripKind && b.category !== "package" && !b.packageName);

/**
 * Edited stop labels -> stored stops. A stop whose label is unchanged keeps its
 * coordinates; a typed-in one is stored as a label only. Returns
 * { stops } or { error }.
 */
function cleanStops(raw, existing) {
  if (!Array.isArray(raw)) return { error: "Stops must be a list" };
  const labels = raw
    .map((s) => String((typeof s === "string" ? s : s?.label) ?? "").trim().slice(0, 200))
    .filter(Boolean);
  if (labels.length > MAX_STOPS) return { error: `You can add up to ${MAX_STOPS} stops` };
  const known = new Map(
    (Array.isArray(existing.stops) ? existing.stops : [])
      .map((s) => (typeof s === "string" ? { label: s } : s))
      .filter((s) => s?.label)
      .map((s) => [s.label, s])
  );
  return { stops: labels.map((label) => known.get(label) || { label }) };
}

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

  if (body.stops !== undefined) {
    const { stops, error } = cleanStops(body.stops, existing);
    if (error) return res.status(400).json({ error });
    if (stops.length && !stopsEditable(existing)) {
      return res.status(400).json({ error: "Stops can't be added to this type of booking" });
    }
    if (stops.map((x) => x.label).join("\n") !== stopLabels(existing).join("\n")) patch.stops = stops;
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

  // Pre-invoice = the booked (estimated) fare; post-invoice = the final bill
  // after the trip, including extra km. Defaults to the latest one available.
  const requested = String(req.query?.type || "").toLowerCase();
  const kind = requested === "pre" || requested === "post" ? requested : booking.tripClosure ? "post" : "pre";
  if (kind === "post" && !booking.tripClosure) {
    return res.status(409).json({ error: "The final invoice is available once the trip is completed" });
  }

  const html = renderInvoiceHtml(booking, payment, kind);
  const fileTag = kind === "post" ? "Final-Invoice" : "Pre-Invoice";
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="RoadCruise-${fileTag}-${booking.id}.html"`);
  res.send(html);
};

// ---- invoice rendering ------------------------------------------------------

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const STATUS_LABELS = {
  Approved: "Confirmed",
  PendingPayment: "Awaiting payment",
  Pending: "Pending confirmation",
  Cancelled: "Cancelled",
  Completed: "Completed",
};

function renderInvoiceHtml(booking, payment, kind = "pre") {
  const brand = notifConfig.branding;
  const isPost = kind === "post" && !!booking.tripClosure;
  const closure = isPost ? booking.tripClosure : null;
  const baseNumber = payment?.invoiceNumber || `RC-INV-${booking.id}`;
  const invoiceNumber = isPost ? `${baseNumber}-F` : baseNumber;
  const docTitle = isPost ? "FINAL INVOICE" : "PRE-INVOICE";
  const pricing = pricingOf(booking);
  const bookedTotal = Number(pricing.total || booking.fare || 0);
  const total = isPost ? finalTotal(booking) : bookedTotal;
  const paidAmount = payment ? Number(payment.amount || 0) : 0;
  const balance = Math.max(0, Math.round((total - paidAmount) * 100) / 100);
  const statusLabel = STATUS_LABELS[booking.status] || booking.status;
  const paymentStatus = paidAmount <= 0 ? "Unpaid" : balance > 0 ? "Partially paid" : "Paid";
  const isPackage = booking.category === "package" || booking.packageName;
  const stops = stopLabels(booking);
  const rental = rentalLabel(booking);
  const legalName = brand.legalName || brand.companyName;
  // "https://roadcruise.in" -> "www.roadcruise.in"
  const websiteLabel = String(brand.websiteUrl || "")
    .replace(/^https?:\/\//i, "")
    .replace(/\/$/, "")
    .replace(/^(?!www\.)/i, "www.");
  const logo = brand.logoUrl || `${String(brand.websiteUrl || "").replace(/\/$/, "")}/logo.png`;
  const dateLabel = (d) => {
    const t = Date.parse(String(d || "").length === 10 ? `${d}T00:00:00` : d);
    return Number.isFinite(t)
      ? new Date(t).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
      : esc(d || "");
  };
  const timeLabel = (t) => {
    const [h, m] = String(t || "").split(":").map(Number);
    if (!Number.isFinite(h)) return t || "";
    return `${h % 12 || 12}:${String(m || 0).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
  };

  const kv = (label, value) =>
    value ? `<div class="kv"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>` : "";

  const travelDates =
    booking.fromDate && booking.toDate && booking.toDate !== booking.fromDate
      ? `${dateLabel(booking.fromDate)} – ${dateLabel(booking.toDate)}`
      : dateLabel(booking.fromDate);

  const routeHtml = [
    { kind: "Pickup", label: booking.pickup },
    ...stops.map((s, i) => ({ kind: `Stop ${i + 1}`, label: s })),
    { kind: "Drop", label: booking.drop },
  ]
    .filter((p) => p.label)
    .map((p) => `<li><span class="rk">${esc(p.kind)}</span><span class="rl">${esc(p.label)}</span></li>`)
    .join("");

  const lineRows = pricing.lines
    .map(
      (l) => `<tr><td><strong>${esc(l.label)}</strong>${l.detail ? `<small>${esc(l.detail)}</small>` : ""}</td><td class="num">${formatINR(l.amount)}</td></tr>`
    )
    .join("");
  const hasGst = pricing.gstAmount != null;

  const kmN = (n) => `${Number(n || 0).toLocaleString("en-IN")} km`;
  const closureRows = closure
    ? closure.lines
        .map(
          (l) => `<tr><td><strong>${esc(l.label)}</strong>${l.detail ? `<small>${esc(l.detail)}</small>` : ""}</td><td class="num">${formatINR(l.amount)}</td></tr>`
        )
        .join("")
    : "";

  // Post-trip invoice: booked fare first, then the extra charges block.
  const itemsHtml = isPost
    ? `<table class="items">
      <thead><tr><th>Booked fare</th><th class="num">Amount</th></tr></thead>
      <tbody>${lineRows}
        ${hasGst ? `<tr><td>GST @ ${esc(pricing.gstRate)}%</td><td class="num">${formatINR(pricing.gstAmount)}</td></tr>` : ""}
        <tr class="sub"><td><strong>Booked total</strong></td><td class="num"><strong>${formatINR(bookedTotal)}</strong></td></tr>
      </tbody>
    </table>
    <table class="items" style="margin-top:18px">
      <thead><tr><th>Post-trip charges</th><th class="num">Amount</th></tr></thead>
      <tbody>${closureRows || `<tr><td>No extra km or charges — trip within the booked limits</td><td class="num">${formatINR(0)}</td></tr>`}
        ${closure.gstAmount > 0 ? `<tr><td>GST @ ${esc(closure.gstRate)}% on extra charges</td><td class="num">${formatINR(closure.gstAmount)}</td></tr>` : ""}
        <tr class="sub"><td><strong>Post-trip total</strong></td><td class="num"><strong>${formatINR(closure.total)}</strong></td></tr>
      </tbody>
    </table>`
    : `<table class="items">
      <thead><tr><th>Description</th><th class="num">Amount</th></tr></thead>
      <tbody>${lineRows}</tbody>
    </table>`;

  const totalsTop = isPost
    ? `<div class="kv"><span>Booked total</span><strong>${formatINR(bookedTotal)}</strong></div>
      <div class="kv"><span>Post-trip charges</span><strong>${formatINR(closure.total)}</strong></div>`
    : hasGst
      ? `<div class="kv"><span>Subtotal</span><strong>${formatINR(pricing.subtotal)}</strong></div>
      <div class="kv"><span>GST @ ${esc(pricing.gstRate)}%</span><strong>${formatINR(pricing.gstAmount)}</strong></div>`
      : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${isPost ? "Final Invoice" : "Pre-Invoice"} ${esc(invoiceNumber)} — ${esc(brand.companyName)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: "Segoe UI", Arial, Helvetica, sans-serif; background: #f4f4f5; color: #18181b; padding: 24px 12px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .sheet { max-width: 794px; margin: 0 auto; background: #fff; border: 1px solid #e4e4e7; border-radius: 12px; overflow: hidden; }
  .bar { height: 6px; background: linear-gradient(90deg, #b8912a, #d4af37, #b8912a); }
  .head { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; flex-wrap: wrap; padding: 28px 36px 22px; border-bottom: 1px solid #f0f0f1; }
  .co img { height: 44px; display: block; margin-bottom: 10px; }
  .co h2 { font-size: 17px; letter-spacing: .2px; }
  .co p { font-size: 11.5px; color: #52525b; line-height: 1.6; }
  .doc { text-align: right; }
  .doc h1 { font-size: 26px; letter-spacing: 6px; color: #b8912a; font-weight: 700; }
  .doc p { font-size: 12px; color: #52525b; margin-top: 4px; }
  .doc p strong { color: #18181b; }
  .section { padding: 22px 36px; }
  .section + .section { padding-top: 0; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  .card { border: 1px solid #ececee; border-radius: 10px; padding: 14px 16px; }
  h3 { font-size: 10px; text-transform: uppercase; letter-spacing: 1.6px; color: #a1a1aa; margin-bottom: 10px; font-weight: 700; }
  .kv { display: flex; justify-content: space-between; gap: 12px; font-size: 12.5px; padding: 4px 0; }
  .kv span { color: #71717a; }
  .kv strong { text-align: right; font-weight: 600; }
  .badge { display: inline-block; font-size: 10.5px; font-weight: 700; padding: 3px 9px; border-radius: 999px; background: #fef3c7; color: #92400e; }
  .badge.ok { background: #dcfce7; color: #166534; }
  .badge.no { background: #fee2e2; color: #991b1b; }
  ol.route { list-style: none; position: relative; margin-top: 2px; }
  ol.route li { display: grid; grid-template-columns: 64px 1fr; gap: 10px; font-size: 12.5px; padding: 5px 0 5px 16px; position: relative; }
  ol.route li::before { content: ""; position: absolute; left: 0; top: 10px; width: 8px; height: 8px; border-radius: 50%; background: #d4af37; }
  ol.route li:not(:last-child)::after { content: ""; position: absolute; left: 3.5px; top: 20px; bottom: -6px; width: 1px; background: #e4cf8a; }
  .rk { color: #71717a; font-size: 11px; text-transform: uppercase; letter-spacing: .6px; padding-top: 1px; }
  .rl { font-weight: 600; }
  table.items { width: 100%; border-collapse: collapse; }
  table.items th { font-size: 10px; text-transform: uppercase; letter-spacing: 1.4px; color: #a1a1aa; text-align: left; padding: 0 0 8px; border-bottom: 2px solid #18181b; }
  table.items th.num, td.num { text-align: right; white-space: nowrap; }
  table.items td { font-size: 13px; padding: 11px 0; border-bottom: 1px solid #f0f0f1; vertical-align: top; }
  table.items td small { display: block; font-size: 11.5px; color: #71717a; margin-top: 2px; }
  table.items tr.sub td { border-bottom: 0; background: #fafafa; }
  .note { margin: 0 36px 18px; padding: 10px 14px; border-radius: 10px; background: #fefce8; border: 1px solid #fde68a; font-size: 11.5px; color: #713f12; line-height: 1.5; }
  .totals { margin-left: auto; width: 320px; max-width: 100%; margin-top: 10px; }
  .totals .kv { padding: 6px 0; font-size: 13px; }
  .totals .grand { border-top: 2px solid #d4af37; margin-top: 6px; padding-top: 10px; font-size: 16px; }
  .totals .grand span, .totals .grand strong { color: #18181b; font-weight: 800; }
  .totals .muted strong { font-weight: 500; }
  .notes { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  .notes ul { list-style: none; font-size: 12px; color: #3f3f46; line-height: 1.55; }
  .notes li::before { content: "•"; color: #b8912a; margin-right: 6px; }
  .foot { padding: 18px 36px 26px; border-top: 1px solid #f0f0f1; font-size: 11px; color: #71717a; line-height: 1.6; text-align: center; }
  .print-btn { display: block; margin: 0 36px 26px; width: calc(100% - 72px); padding: 12px; background: #d4af37; color: #18181b; font-weight: 700; font-size: 13px; border: 0; border-radius: 10px; cursor: pointer; }
  @media (max-width: 620px) {
    .head, .section, .foot { padding-left: 18px; padding-right: 18px; }
    .cols, .notes { grid-template-columns: 1fr; }
    .doc { text-align: left; }
    .print-btn { margin: 0 18px 22px; width: calc(100% - 36px); }
  }
  @page { size: A4; margin: 8mm 10mm; }
  /* Print: one A4 sheet. Same layout as on screen, tighter spacing and type. */
  @media print {
    body { background: #fff; padding: 0; font-size: 11px; }
    .sheet { border: 0; border-radius: 0; max-width: none; }
    .print-btn { display: none; }
    .bar { height: 4px; }
    .head { padding: 10px 4px 10px; gap: 12px; }
    .co img { height: 34px; margin-bottom: 6px; }
    .co h2 { font-size: 14px; }
    .co p { font-size: 10.5px; line-height: 1.45; }
    .doc h1 { font-size: 20px; letter-spacing: 5px; }
    .doc p { font-size: 10.5px; margin-top: 2px; }
    .section { padding: 8px 4px; }
    .cols, .notes { grid-template-columns: 1fr 1fr; gap: 10px; }
    .card { padding: 8px 12px; border-radius: 8px; }
    h3 { margin-bottom: 4px; font-size: 9px; }
    .kv { font-size: 11px; padding: 1.5px 0; }
    .badge { font-size: 9.5px; padding: 1px 7px; }
    ol.route li { font-size: 11px; padding: 2px 0 2px 16px; }
    ol.route li::before { top: 6px; }
    ol.route li:not(:last-child)::after { top: 15px; bottom: -3px; }
    table.items th { padding-bottom: 4px; }
    table.items td { font-size: 11.5px; padding: 5px 0; }
    table.items td small { font-size: 10px; margin-top: 1px; }
    .totals { margin-top: 4px; }
    .totals .kv { padding: 2px 0; font-size: 11.5px; }
    .totals .grand { font-size: 14px; margin-top: 3px; padding-top: 5px; }
    .notes ul { font-size: 10.5px; line-height: 1.4; }
    .foot { padding: 8px 4px 0; font-size: 9.5px; }
    .sheet, .card, table.items tr, .totals { break-inside: avoid; }
  }
</style>
</head>
<body>
<div class="sheet">
  <div class="bar"></div>
  <div class="head">
    <div class="co">
      <img src="${esc(logo)}" alt="${esc(brand.companyName)}" onerror="this.style.display='none'" />
      <h2>${esc(legalName)}</h2>
      <p>${esc(brand.address || "")}<br/>
      ${esc(brand.supportPhone)}<br/>
      ${esc(brand.supportEmail)}<br/>
      ${esc(websiteLabel)}
      ${brand.gstin ? `<br/><strong>GSTIN:</strong> ${esc(brand.gstin)}` : ""}</p>
    </div>
    <div class="doc">
      <h1>${docTitle}</h1>
      <p>Invoice No. <strong>${esc(invoiceNumber)}</strong></p>
      ${payment?.receiptNumber ? `<p>Receipt No. <strong>${esc(payment.receiptNumber)}</strong></p>` : ""}
      <p>Invoice Date <strong>${dateLabel(new Date().toISOString())}</strong></p>
      <p>Booking ID <strong>${esc(booking.id)}</strong></p>
    </div>
  </div>

  <div class="section cols">
    <div class="card">
      <h3>Billed To</h3>
      ${kv("Name", booking.name || "—")}
      ${kv("Phone", booking.phone)}
      ${kv("Email", /@phone\.invalid$/.test(booking.customerEmail || "") ? "" : booking.customerEmail)}
    </div>
    <div class="card">
      <h3>Booking</h3>
      ${kv("Booking date", booking.createdAt ? dateLabel(booking.createdAt) : "")}
      <div class="kv"><span>Booking status</span><strong><span class="badge ${booking.status === "Cancelled" ? "no" : booking.status === "Approved" || booking.status === "Completed" ? "ok" : ""}">${esc(statusLabel)}</span></strong></div>
      <div class="kv"><span>Payment status</span><strong><span class="badge ${paymentStatus === "Paid" ? "ok" : ""}">${esc(paymentStatus)}</span></strong></div>
      ${kv("Payment method", booking.paymentMethod)}
    </div>
  </div>

  <div class="section cols">
    <div class="card">
      <h3>Trip Details</h3>
      ${kv("Trip type", booking.tripType)}
      ${isPackage ? kv("Package", booking.packageName) : ""}
      ${kv(isPackage ? "Vehicle preference" : "Vehicle", booking.vehicle || booking.item)}
      ${kv("Travel date", travelDates)}
      ${kv("Pickup time", timeLabel(booking.pickupTime))}
      ${kv("Rental duration", rental)}
      ${kv("Distance (est.)", distanceLabel(booking))}
      ${Number(booking.days) > 1 ? kv("Number of days", String(booking.days)) : ""}
      ${kv("Passengers", booking.passengers)}
    </div>
    <div class="card">
      <h3>Route</h3>
      ${routeHtml ? `<ol class="route">${routeHtml}</ol>` : `<p style="font-size:12.5px;color:#71717a">—</p>`}
      ${closure ? `<h3 style="margin-top:12px">Trip Km</h3>
      ${kv("Km included in fare", kmN(closure.includedKm))}
      ${kv("Actual km driven", kmN(closure.actualKm))}
      ${kv("Extra km", closure.extraKm > 0 ? `${kmN(closure.extraKm)} @ ₹${closure.extraKmRate}/km` : "None")}` : ""}
    </div>
  </div>

  <div class="section">
    ${itemsHtml}
    <div class="totals">
      ${totalsTop}
      <div class="kv grand"><span>${isPost ? "Final total" : "Estimated total"}</span><strong>${formatINR(total)}</strong></div>
      ${paidAmount > 0 ? `<div class="kv muted"><span>Paid online${payment?.gateway ? ` (${esc(payment.gateway)})` : ""}</span><strong>− ${formatINR(paidAmount)}</strong></div>` : ""}
      <div class="kv"><span>${paidAmount > 0 && balance > 0 ? "Balance to driver" : "Balance due"}</span><strong>${formatINR(balance)}</strong></div>
      ${payment?.gatewayPaymentId ? `<div class="kv muted"><span>Payment ref.</span><strong>${esc(payment.gatewayPaymentId)}</strong></div>` : ""}
    </div>
  </div>

  ${(booking.inclusions?.length || booking.exclusions?.length) ? `<div class="section notes">
    ${booking.inclusions?.length ? `<div class="card"><h3>Included</h3><ul>${booking.inclusions.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : "<div></div>"}
    ${booking.exclusions?.length ? `<div class="card"><h3>Not Included</h3><ul>${booking.exclusions.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
  </div>` : ""}

  <div class="note">${isPost
    ? `Final invoice for the completed trip${booking.tripClosure?.closedAt ? ` (closed ${dateLabel(booking.tripClosure.closedAt)})` : ""}. Extra km is billed on the actual odometer reading beyond the km included in the booked fare.`
    : `This is a pre-invoice for the booked fare. Travel beyond the included km, extra hours, tolls and parking are billed on the final invoice after the trip.`}</div>

  <button class="print-btn" onclick="window.print()">Print / Save as PDF</button>
  <div class="foot">
    Thank you for travelling with ${esc(legalName)}.<br/>
    This is a computer-generated ${isPost ? "final invoice" : "pre-invoice"} for booking ${esc(booking.id)} and does not require a signature.
  </div>
</div>
</body>
</html>`;
}

// Cells starting with = + - @ are executed as formulas by Excel; customer-typed
// fields (name, notes, locations) are untrusted, so neutralise them.
const safeCell = (v) => {
  if (typeof v === "number") return v;
  const s = String(v ?? "");
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
};

const EXPORT_COLUMNS = [
  "Booking Ref", "Created At", "Status", "Customer Name", "Phone", "Email",
  "Booking Type", "Item / Package", "Trip Type", "Vehicle", "Pickup", "Stops", "Drop",
  "From Date", "To Date", "Pickup Time", "Rental Duration", "Distance", "Passengers",
  "Subtotal (INR)", "GST (INR)", "Total (INR)", "Advance (INR)", "Balance (INR)", "Payment Method",
  "Driver", "Driver Phone", "Cab No", "Cab Type", "Payment Mode (driver)",
  "Actual Km", "Extra Km", "Post-trip Charges (INR)", "Final Total (INR)", "Notes",
];

/**
 * GET /api/bookings/export.xlsx  (admin only)
 * Every booking as an Excel workbook, newest first.
 */
export const exportBookings = (_req, res) => {
  const rows = [...listBookings()]
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .map((b) => {
      const p = pricingOf(b);
      return [
        b.id, b.createdAt, b.status, b.name, b.phone, b.customerEmail,
        b.category, b.packageName || b.item, b.tripType, b.vehicle, b.pickup, stopLabels(b).join(" → "), b.drop,
        b.fromDate, b.toDate, b.pickupTime, rentalLabel(b), distanceLabel(b), b.passengers,
        p.subtotal, p.gstAmount ?? "", p.total, Number(b.advanceAmount) || 0, balanceDue(b),
        b.paymentMethod, b.driver === "None" ? "" : b.driver,
        b.assignment?.driverPhone || "", b.assignment?.cabNumber || "", b.assignment?.vehicleType || "",
        b.assignment?.paymentMode || "",
        b.tripClosure?.actualKm ?? "", b.tripClosure?.extraKm ?? "", b.tripClosure?.total ?? "",
        finalTotal(b), b.notes,
      ].map(safeCell);
    });
  const buf = buildTableWorkbook("Bookings", EXPORT_COLUMNS, rows);
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="roadcruise-bookings-${stamp}.xlsx"`);
  res.setHeader("X-Export-Rows", String(rows.length));
  res.send(buf);
};
