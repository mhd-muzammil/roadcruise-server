import express from "express";
import {
  getBookings, createBooking, quoteTrip, cancelBooking, modifyBooking, getBookingInvoice,
  updateBooking, closeTrip, deleteBooking, exportBookings,
} from "../controllers/booking.controller.js";
import { requireAuth, requireRole } from "../auth/rbac/middleware.js";
import { Roles } from "../auth/rbac/roles.js";
import { rateLimit } from "../auth/core/rateLimiter.js";

const router = express.Router();

// SECURITY: bookings are no longer open to the public.
//   GET  /             -> any signed-in user (admins see all; customers see own)
//   POST /quote        -> public: server-priced quotes for a trip search
//   POST /             -> any signed-in user (must be logged in to book)
//   PATCH /:id/cancel  -> any signed-in user; controller enforces ownership
//                         (customer cancels own; staff+ cancels any)
//   PATCH /:id/modify  -> any signed-in user; controller enforces ownership
//                         (customer edits own trip details; staff+ edits any)
//   GET  /:id/invoice  -> any signed-in user; controller enforces ownership
//   PATCH /:id/close   -> admin only: record actual km -> post-trip invoice
//   PATCH/DELETE /:id  -> admin only (manage/cancel/delete a booking)
router.get("/export.xlsx", requireRole(Roles.ADMIN), exportBookings);
router.post("/quote", rateLimit({ windowMs: 60 * 1000, max: 60, name: "booking-quote" }), quoteTrip);
router.get("/", requireAuth, getBookings);
router.post("/", requireAuth, createBooking);
router.patch("/:id/cancel", requireAuth, cancelBooking);
router.patch("/:id/modify", requireAuth, modifyBooking);
router.get("/:id/invoice", requireAuth, getBookingInvoice);
router.patch("/:id/close", requireRole(Roles.ADMIN), closeTrip);
router.patch("/:id", requireRole(Roles.ADMIN), updateBooking);
router.delete("/:id", requireRole(Roles.ADMIN), deleteBooking);

export default router;
