import express from "express";
import { paymentAdminGuard as adminGuard } from "./adminGuard.js";
import * as ctrl from "./payment.controller.js";

/**
 * Payment API. Mounted at /api/payments by the module facade.
 *
 *  Public / customer-facing (consistent with the existing open booking API):
 *    GET  /api/payments/config                 checkout config (no secrets)
 *    POST /api/payments/orders                 create/reuse a gateway order { bookingId }
 *    POST /api/payments/verify                 verify checkout signature + capture (Razorpay/mock)
 *    POST /api/payments/webhook                gateway webhook (signature-verified, not token)
 *    POST /api/payments/phonepe/callback       PhonePe S2S callback (X-VERIFY, confirms via Status API)
 *    GET  /api/payments/phonepe/return         PhonePe browser return (confirms via Status API)
 *
 *  Admin (x-admin-token via the shared notifications adminGuard):
 *    GET  /api/payments                        list/search/paginate
 *    GET  /api/payments/:paymentId             detail + transactions + audit
 *    POST /api/payments/:paymentId/refund      refund (full/partial)
 *    POST /api/payments/:paymentId/retry       re-create order for a failed payment
 *    GET  /api/payments/:paymentId/receipt     invoice/receipt document
 */
const router = express.Router();

// Public / customer + gateway
router.get("/config", ctrl.getConfig);
router.post("/orders", ctrl.createOrder);
router.post("/verify", ctrl.verify);
// Mock-only preview helper (returns a signed checkout result for the demo flow).
router.post("/mock/checkout", ctrl.simulateCheckout);
router.post("/webhook", ctrl.webhook);

// PhonePe redirect-gateway endpoints (signature-verified / status-confirmed).
router.post("/phonepe/callback", ctrl.phonepeCallback);
router.get("/phonepe/return", ctrl.phonepeReturn);
router.post("/phonepe/return", ctrl.phonepeReturn);

// Admin
router.get("/", adminGuard, ctrl.list);
router.get("/:paymentId", adminGuard, ctrl.getOne);
router.post("/:paymentId/refund", adminGuard, ctrl.refund);
router.post("/:paymentId/retry", adminGuard, ctrl.retry);
router.get("/:paymentId/receipt", adminGuard, ctrl.receipt);

export default router;
