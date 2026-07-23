import express from "express";
import { requireRole } from "../auth/rbac/middleware.js";
import { Roles } from "../auth/rbac/roles.js";
import { upload } from "../uploads/index.js";
import {
  getVehicles,
  getVehicleById,
  getAdminVehicles,
  createVehicle,
  updateVehicle,
  deleteVehicle,
  uploadVehicleMedia,
  releaseHold,
} from "../controllers/vehicle.controller.js";

const router = express.Router();

// Public: browse the fleet + availability.
//   GET /          -> vehicles with { totalUnits, heldCount, available }
//   GET /:id       -> one vehicle with availability
// Admin (requireRole ADMIN): manage inventory, media, and free held units.
//   GET    /admin                        -> vehicles + the bookings holding each unit
//   POST   /                             -> create a vehicle
//   PATCH  /:id                          -> edit a vehicle (incl. totalUnits)
//   DELETE /:id                          -> delete a vehicle
//   POST   /:id/media                    -> upload photos/videos (multipart "files")
//   POST   /holds/:bookingId/release     -> free the vehicle unit held by a booking
router.get("/", getVehicles);
router.get("/admin", requireRole(Roles.ADMIN), getAdminVehicles);
router.post("/", requireRole(Roles.ADMIN), createVehicle);
router.post("/holds/:bookingId/release", requireRole(Roles.ADMIN), releaseHold);
router.post("/:id/media", requireRole(Roles.ADMIN), upload.array("files", 10), uploadVehicleMedia);
router.get("/:id", getVehicleById);
router.patch("/:id", requireRole(Roles.ADMIN), updateVehicle);
router.delete("/:id", requireRole(Roles.ADMIN), deleteVehicle);

// Turn multer/upload errors (bad type, too large) into a clean 400 JSON body.
router.use((err, _req, res, _next) => {
  res.status(400).json({ error: err?.message || "Upload failed" });
});

export default router;
