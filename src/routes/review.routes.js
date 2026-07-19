import express from "express";
import { getReviews, createReview } from "../controllers/review.controller.js";
import { rateLimit } from "../auth/core/rateLimiter.js";

const router = express.Router();

// Public customer reviews shown on the homepage.
//   GET  / -> approved reviews, newest first (no auth — the page is public)
//   POST / -> guest submission; validated + sanitized in the controller and
//             throttled per IP (5 per 10 minutes) with the shared sliding-window
//             rate limiter used by the auth endpoints.
router.get("/", getReviews);
router.post("/", rateLimit({ windowMs: 10 * 60 * 1000, max: 5, name: "reviews" }), createReview);

export default router;
