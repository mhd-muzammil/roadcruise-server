import express from "express";
import { requireRole } from "../auth/rbac/middleware.js";
import { Roles } from "../auth/rbac/roles.js";
import { upload } from "../uploads/index.js";
import {
  getActivePromo, getPromos, createPromo, patchPromo, removePromo,
} from "../controllers/promo.controller.js";

const router = express.Router();

// Promotional travel packages shown in the site-wide popup.
//   GET    /active -> newest active promo, or null (public — feeds the popup)
//   GET    /       -> all promos, newest first (admin)
//   POST   /       -> create promo (admin; multipart, optional "image")
//   PATCH  /:id    -> edit / toggle active (admin; JSON or multipart)
//   DELETE /:id    -> remove promo + image (admin)
router.get("/active", getActivePromo);
router.get("/", requireRole(Roles.ADMIN), getPromos);
router.post("/", requireRole(Roles.ADMIN), upload.single("image"), createPromo);
router.patch("/:id", requireRole(Roles.ADMIN), upload.single("image"), patchPromo);
router.delete("/:id", requireRole(Roles.ADMIN), removePromo);

// Clean 400 for multer/upload errors.
router.use((err, _req, res, _next) => {
  res.status(400).json({ error: err?.message || "Upload failed" });
});

export default router;
