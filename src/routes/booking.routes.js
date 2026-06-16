import express from "express";
import { getBookings, createBooking, updateBooking, deleteBooking } from "../controllers/booking.controller.js";

const router = express.Router();

router.get("/", getBookings);
router.post("/", createBooking);
router.patch("/:id", updateBooking);
router.delete("/:id", deleteBooking);

export default router;
