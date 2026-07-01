import express from "express";
import { login, register } from "../controllers/auth.controller.js";
import { loginLimiter } from "../auth/core/rateLimiter.js";

const router = express.Router();

// Additive brute-force throttling (per-IP). Only returns 429 under abuse;
// normal traffic is unaffected. Account-level lockout is enforced separately.
router.post("/login", loginLimiter(), login);
router.post("/register", loginLimiter(), register);

export default router;
