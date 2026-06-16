import express from "express";
import cors from "cors";
import authRoutes from "./routes/auth.routes.js";
import bookingRoutes from "./routes/booking.routes.js";

const app = express();

app.use(cors());
app.use(express.json());

// API Mount points
app.use("/api/auth", authRoutes);
app.use("/api/bookings", bookingRoutes);

export default app;
