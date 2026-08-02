import express from "express";
import { searchPlaces, getRoute } from "../controllers/places.controller.js";
import { rateLimit } from "../auth/core/rateLimiter.js";

const router = express.Router();

// Public (the hero widget is used before sign-in), but rate-limited per IP so
// the free upstream providers (Photon/OSRM) are never hammered through us.
// 120/min comfortably covers debounced typing; scripts get a 429.
router.get("/search", rateLimit({ windowMs: 60 * 1000, max: 120, name: "places-search" }), searchPlaces);
router.get("/route", rateLimit({ windowMs: 60 * 1000, max: 60, name: "places-route" }), getRoute);

export default router;
