import express from "express";
import { adminGuard } from "./adminGuard.js";
import * as ctrl from "./notification.controller.js";

/**
 * Admin/ERP notification API. Mounted at /api/notifications by the module
 * facade. Every route is protected by adminGuard (x-admin-token).
 *
 *   GET    /api/notifications                 list + search + paginate
 *   GET    /api/notifications/metrics         delivery/failure/queue metrics
 *   GET    /api/notifications/dead-letters     DLQ contents
 *   GET    /api/notifications/audit           audit trail (paginated)
 *   GET    /api/notifications/export          download full logs (JSON)
 *   GET    /api/notifications/:id             single record + its audit trail
 *   POST   /api/notifications/:id/retry       manually re-queue
 *   POST   /api/notifications/resend          re-emit an event { event, payload } | { fromNotificationId }
 */
const router = express.Router();

router.use(adminGuard);

router.get("/", ctrl.list);
router.get("/metrics", ctrl.getMetrics);
router.get("/dead-letters", ctrl.deadLetters);
router.get("/audit", ctrl.audit);
router.get("/export", ctrl.exportLogs);
router.post("/resend", ctrl.resend);
router.get("/:id", ctrl.getOne);
router.post("/:id/retry", ctrl.retry);

export default router;
