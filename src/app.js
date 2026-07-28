import express from "express";
import cors from "cors";
import authRoutes from "./routes/auth.routes.js";
import bookingRoutes from "./routes/booking.routes.js";
import contactRoutes from "./routes/contact.routes.js";
import reviewRoutes from "./routes/review.routes.js";
import vehicleRoutes from "./routes/vehicle.routes.js";
import galleryRoutes from "./routes/gallery.routes.js";
import promoRoutes from "./routes/promo.routes.js";
import { UPLOAD_DIR, UPLOAD_ROUTE } from "./uploads/index.js";
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
app.use("/api/contact", contactRoutes);
app.use("/api/reviews", reviewRoutes);
app.use("/api/vehicles", vehicleRoutes);
app.use("/api/gallery", galleryRoutes);
app.use("/api/promos", promoRoutes);

// Serve admin-uploaded media (vehicle photos/videos + gallery). Read-only static
// mount; files live on durable storage under DATA_DIR/uploads (see uploads/index.js).
app.use(UPLOAD_ROUTE, express.static(UPLOAD_DIR, { maxAge: "7d", fallthrough: false }));

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
