import express from "express";
import { requireRole } from "../auth/rbac/middleware.js";
import { Roles } from "../auth/rbac/roles.js";
import { upload } from "../uploads/index.js";
import { getGallery, createGallery, deleteGallery } from "../controllers/gallery.controller.js";

const router = express.Router();

// Public gallery of admin-uploaded photos + videos.
//   GET    /      -> all media, newest first (public)
//   POST   /      -> upload media (admin; multipart "files", optional "caption")
//   DELETE /:id   -> remove media (admin)
router.get("/", getGallery);
router.post("/", requireRole(Roles.ADMIN), upload.array("files", 10), createGallery);
router.delete("/:id", requireRole(Roles.ADMIN), deleteGallery);

// Clean 400 for multer/upload errors.
router.use((err, _req, res, _next) => {
  res.status(400).json({ error: err?.message || "Upload failed" });
});

export default router;
