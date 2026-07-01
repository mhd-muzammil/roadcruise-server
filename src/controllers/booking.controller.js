import { readDb, writeDb } from "../utils/db.js";
import {
  notifyBookingCreated,
  notifyBookingConfirmed,
  notifyPaymentSuccessful,
  notifyBookingCancelled,
  notifyDriverAssigned,
} from "../notifications/integration/hooks.js";

export const getBookings = (req, res) => {
  const db = readDb();
  res.json(db.bookings);
};

export const createBooking = (req, res) => {
  const { name, phone, fromDate, toDate, tripType, item, fare, paymentMethod } = req.body;
  if (!name || !fromDate || !toDate || !item) {
    return res.status(400).json({ error: "Missing required booking details" });
  }

  const db = readDb();
  const newBooking = {
    id: `RC-BK-${Math.floor(1000 + Math.random() * 9000)}`,
    name,
    phone: phone || "+91 99999 99999",
    fromDate,
    toDate,
    tripType: tripType || "Round-trip",
    item,
    fare: Number(fare) || 2000,
    status: "Approved", // Default auto-approve
    paymentMethod: paymentMethod || "Card",
    driver: "None"
  };

  db.bookings.unshift(newBooking);
  writeDb(db);

  // Emit domain events to the notification engine (async, non-blocking).
  notifyBookingCreated(newBooking);
  if (newBooking.status === "Approved") {
    notifyPaymentSuccessful(newBooking);
    notifyBookingConfirmed(newBooking);
  }

  res.status(211).json(newBooking);
};

export const updateBooking = (req, res) => {
  const { id } = req.params;
  const { status, driver } = req.body;

  const db = readDb();
  const idx = db.bookings.findIndex(b => b.id === id);
  if (idx === -1) {
    return res.status(404).json({ error: "Booking not found" });
  }

  const prevStatus = db.bookings[idx].status;
  const prevDriver = db.bookings[idx].driver;

  if (status !== undefined) db.bookings[idx].status = status;
  if (driver !== undefined) db.bookings[idx].driver = driver;

  writeDb(db);
  const updated = db.bookings[idx];

  // Emit lifecycle events only on actual transitions.
  if (status !== undefined && status !== prevStatus) {
    if (status === "Approved") {
      notifyPaymentSuccessful(updated);
      notifyBookingConfirmed(updated);
    } else if (status === "Cancelled") {
      notifyBookingCancelled(updated);
    }
  }
  if (driver !== undefined && driver !== prevDriver && driver !== "None") {
    notifyDriverAssigned(updated);
  }

  res.json(updated);
};

export const deleteBooking = (req, res) => {
  const { id } = req.params;
  const db = readDb();
  const filtered = db.bookings.filter(b => b.id !== id);

  if (filtered.length === db.bookings.length) {
    return res.status(404).json({ error: "Booking not found" });
  }

  db.bookings = filtered;
  writeDb(db);
  res.json({ message: "Booking deleted successfully", id });
};
