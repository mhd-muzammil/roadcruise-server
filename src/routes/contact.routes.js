import express from "express";
import { notify } from "../notifications/index.js";
import { NotificationEvents } from "../notifications/config/events.js";

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clip = (v, max) => String(v ?? "").trim().slice(0, max);

/**
 * POST /api/contact
 * Public website "Contact Us" enquiry. Validates, then fires two notifications:
 *   - CONTACT_ENQUIRY -> the business inbox (staff act on it)
 *   - CONTACT_ACK     -> an acknowledgement back to the enquirer
 * Both are fire-and-forget; a notification hiccup never fails the request.
 */
router.post("/", (req, res) => {
  const name = clip(req.body?.name, 120);
  const email = clip(req.body?.email, 200);
  const phone = clip(req.body?.phone, 40);
  const subject = clip(req.body?.subject, 120) || "General Enquiry";
  const message = clip(req.body?.message, 4000);

  if (!name || !email || !message) {
    return res.status(400).json({ error: "Name, email and message are required." });
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: "Please provide a valid email address." });
  }

  const payload = { name, email, phone, subject, message };
  notify(NotificationEvents.CONTACT_ENQUIRY, payload, { actor: "contact-form" });
  notify(NotificationEvents.CONTACT_ACK, payload, { actor: "contact-form" });

  return res.status(202).json({ ok: true, message: "Enquiry received." });
});

export default router;
