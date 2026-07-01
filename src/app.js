import express from "express";
import cors from "cors";
import authRoutes from "./routes/auth.routes.js";
import bookingRoutes from "./routes/booking.routes.js";
import notifications from "./notifications/index.js";
import payments from "./payments/index.js";
import authOAuth from "./auth/index.js";

const app = express();

app.use(cors());
// Capture the raw request body alongside normal JSON parsing. Existing routes
// are unaffected (they still receive parsed req.body); the payment webhook uses
// req.rawBody for HMAC signature verification. Additive, non-breaking.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// API Mount points
app.use("/api/auth", authRoutes);
app.use("/api/bookings", bookingRoutes);

// Google OAuth 2.0 (additive, non-breaking): mounts extra /api/auth/* routes
// (/google, /nonce, /google/config) alongside the existing login/register.
authOAuth.init(app);

// Enterprise Notification & Communication module (additive, non-breaking):
// mounts /api/notifications and starts the async notification engine.
notifications.init(app);

// Enterprise Payment module (additive, non-breaking): mounts /api/payments.
// Initialized AFTER notifications so payment events can emit into the engine.
payments.init(app);

export default app;
