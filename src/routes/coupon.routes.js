import express from "express";
import { requireAuth, requireRole } from "../auth/rbac/middleware.js";
import { Roles } from "../auth/rbac/roles.js";
import { rateLimit } from "../auth/core/rateLimiter.js";
import {
  getCoupons, createCoupon, patchCoupon, removeCoupon, applyCouponPreview,
} from "../controllers/coupon.controller.js";

const router = express.Router();

// Coupon codes.
//   POST   /apply -> signed in: preview a code's discount at checkout
//                    (rate-limited so codes can't be brute-forced)
//   GET    /      -> admin: every coupon with its usage count
//   POST   /      -> admin: create
//   PATCH  /:id   -> admin: edit / toggle active
//   DELETE /:id   -> admin: remove
router.post("/apply", requireAuth, rateLimit({ windowMs: 60 * 1000, max: 15, name: "coupon-apply" }), applyCouponPreview);
router.get("/", requireRole(Roles.ADMIN), getCoupons);
router.post("/", requireRole(Roles.ADMIN), createCoupon);
router.patch("/:id", requireRole(Roles.ADMIN), patchCoupon);
router.delete("/:id", requireRole(Roles.ADMIN), removeCoupon);

export default router;
