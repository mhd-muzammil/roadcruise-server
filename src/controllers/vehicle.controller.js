import {
  listVehicles,
  getVehicle,
  insertVehicle,
  updateVehicle as updateVehicleRow,
  deleteVehicle as deleteVehicleRow,
} from "../db/vehicles.db.js";
import { getBookingById, patchBooking } from "../utils/db.js";
import { mediaType, publicUrl, removeUploadedFile } from "../uploads/index.js";
import {
  heldCounts,
  heldBookingsFor,
  withAvailability,
  listVehiclesWithAvailability,
} from "../services/availability.js";

/**
 * Vehicle inventory + availability. The availability model itself lives in
 * services/availability.js (shared with the booking controller). This controller
 * is the HTTP surface: public browse + admin CRUD/media/free.
 */

// ---- Public ----------------------------------------------------------------

/** GET /api/vehicles — public list with availability. */
export const getVehicles = (_req, res) => {
  try {
    res.json(listVehiclesWithAvailability());
  } catch (e) {
    console.error("[vehicles] list failed:", e.message);
    res.status(500).json({ error: "Could not load vehicles." });
  }
};

/** GET /api/vehicles/:id — public single vehicle with availability. */
export const getVehicleById = (req, res) => {
  const v = getVehicle(req.params.id);
  if (!v) return res.status(404).json({ error: "Vehicle not found" });
  res.json(withAvailability(v));
};

// ---- Admin -----------------------------------------------------------------

/** GET /api/vehicles/admin — admin list incl. the bookings holding each unit. */
export const getAdminVehicles = (_req, res) => {
  const held = heldCounts();
  const rows = listVehicles({ includeInactive: true }).map((v) => ({
    ...withAvailability(v, held),
    heldBookings: heldBookingsFor(v.id),
  }));
  res.json(rows);
};

/** POST /api/vehicles — create (admin). */
export const createVehicle = (req, res) => {
  try {
    const v = insertVehicle(req.body || {});
    res.status(201).json(withAvailability(v));
  } catch (e) {
    console.error("[vehicles] create failed:", e.message);
    res.status(500).json({ error: "Could not create vehicle." });
  }
};

/** PATCH /api/vehicles/:id — edit (admin). */
export const updateVehicle = (req, res) => {
  const v = updateVehicleRow(req.params.id, req.body || {});
  if (!v) return res.status(404).json({ error: "Vehicle not found" });
  res.json(withAvailability(v));
};

/** DELETE /api/vehicles/:id — remove (admin). Also cleans up any uploaded files. */
export const deleteVehicle = (req, res) => {
  const v = getVehicle(req.params.id);
  if (!v) return res.status(404).json({ error: "Vehicle not found" });
  [...(v.images || []), ...(v.videos || [])].forEach(removeUploadedFile);
  deleteVehicleRow(req.params.id);
  res.json({ message: "Vehicle deleted", id: req.params.id });
};

/** POST /api/vehicles/:id/media — upload photos/videos (admin, multipart "files"). */
export const uploadVehicleMedia = (req, res) => {
  const v = getVehicle(req.params.id);
  if (!v) return res.status(404).json({ error: "Vehicle not found" });
  const files = req.files || [];
  if (files.length === 0) return res.status(400).json({ error: "No files uploaded" });

  const images = [...(v.images || [])];
  const videos = [...(v.videos || [])];
  for (const f of files) {
    (mediaType(f) === "video" ? videos : images).push(publicUrl(f));
  }
  const updated = updateVehicleRow(req.params.id, { images, videos });
  res.status(201).json(withAvailability(updated));
};

/** POST /api/vehicles/holds/:bookingId/release — free a vehicle unit (admin). */
export const releaseHold = (req, res) => {
  const booking = getBookingById(req.params.bookingId);
  if (!booking) return res.status(404).json({ error: "Booking not found" });
  const { booking: updated } = patchBooking(req.params.bookingId, { vehicleReleased: true });
  res.json({ message: "Vehicle freed", booking: updated });
};

export default {
  getVehicles, getVehicleById, getAdminVehicles, createVehicle, updateVehicle,
  deleteVehicle, uploadVehicleMedia, releaseHold,
};
