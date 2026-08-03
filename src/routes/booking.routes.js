import express from "express";
import {
  getBookings, createBooking, cancelBooking, modifyBooking,
  updateBooking, deleteBooking,
} from "../controllers/booking.controller.js";
import { requireAuth, requireRole } from "../auth/rbac/middleware.js";
import { Roles } from "../auth/rbac/roles.js";

const router = express.Router();

// SECURITY: bookings are no longer open to the public.
//   GET  /             -> any signed-in user (admins see all; customers see own)
//   POST /             -> any signed-in user (must be logged in to book)
//   PATCH /:id/cancel  -> any signed-in user; controller enforces ownership
//                         (customer cancels own; staff+ cancels any)
//   PATCH /:id/modify  -> any signed-in user; controller enforces ownership
//                         (customer edits own trip details; staff+ edits any)
//   PATCH/DELETE /:id  -> admin only (manage/cancel/delete a booking)
router.get("/", requireAuth, getBookings);
router.post("/", requireAuth, createBooking);
router.patch("/:id/cancel", requireAuth, cancelBooking);
router.patch("/:id/modify", requireAuth, modifyBooking);
router.patch("/:id", requireRole(Roles.ADMIN), updateBooking);
router.delete("/:id", requireRole(Roles.ADMIN), deleteBooking);

export default router;
