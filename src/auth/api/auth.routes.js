import express from "express";
import * as ctrl from "./auth.controller.js";
import { requireAuth } from "../rbac/middleware.js";
import { loginLimiter, sensitiveLimiter } from "../core/rateLimiter.js";

/**
 * Additive auth routes, mounted at /api/auth ALONGSIDE the existing login/register
 * router (which is now hardened in-place). Express chains routers on the same
 * mount path, so these coexist.
 *
 *   Google OAuth:
 *     GET  /api/auth/google/config
 *     GET  /api/auth/nonce
 *     POST /api/auth/google
 *   Tokens / sessions:
 *     POST /api/auth/refresh                 rotate refresh -> new access+refresh
 *     GET  /api/auth/me                       (auth) current user + permissions
 *     POST /api/auth/logout                   (auth) revoke current session
 *     POST /api/auth/logout-all               (auth) revoke all sessions (bumps tokenVersion)
 *     GET  /api/auth/sessions                 (auth) list my active sessions
 *     DELETE /api/auth/sessions/:sid          (auth) revoke one of my sessions
 *   Recovery / verification (rate-limited):
 *     POST /api/auth/forgot-password
 *     POST /api/auth/reset-password
 *     POST /api/auth/verify-email
 *     POST /api/auth/resend-verification
 */
const router = express.Router();

// Google OAuth
router.get("/google/config", ctrl.googleConfig);
router.get("/nonce", ctrl.getNonce);
router.post("/google", loginLimiter(), ctrl.googleLogin);

// Tokens / sessions
router.post("/refresh", loginLimiter(), ctrl.refresh);
router.get("/me", requireAuth, ctrl.me);
router.post("/logout", requireAuth, ctrl.logout);
router.post("/logout-all", requireAuth, ctrl.logoutAll);
router.get("/sessions", requireAuth, ctrl.listSessions);
router.delete("/sessions/:sid", requireAuth, ctrl.revokeSession);

// Recovery / verification
router.post("/forgot-password", sensitiveLimiter(), ctrl.forgotPassword);
router.post("/reset-password", sensitiveLimiter(), ctrl.resetPassword);
router.post("/verify-email", sensitiveLimiter(), ctrl.verifyEmail);
router.post("/resend-verification", sensitiveLimiter(), ctrl.resendVerification);

export default router;
