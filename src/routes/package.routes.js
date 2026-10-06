import express from "express";
import { requireRole } from "../auth/rbac/middleware.js";
import { Roles } from "../auth/rbac/roles.js";
import { upload } from "../uploads/index.js";
import {
  getPublicPackages, getAdminPackages, createPackage, patchPackage, removePackage,
} from "../controllers/package.controller.js";

const router = express.Router();

//   GET    /      -> active packages (public — Tours & Travels page)
//   GET    /all   -> every package (admin)
//   POST   /      -> create (admin; multipart, optional "image")
//   PATCH  /:id   -> edit / toggle active / payment mode (admin)
//   DELETE /:id   -> remove (admin)
router.get("/", getPublicPackages);
router.get("/all", requireRole(Roles.ADMIN), getAdminPackages);
router.post("/", requireRole(Roles.ADMIN), upload.single("image"), createPackage);
router.patch("/:id", requireRole(Roles.ADMIN), upload.single("image"), patchPackage);
router.delete("/:id", requireRole(Roles.ADMIN), removePackage);

router.use((err, _req, res, _next) => {
  res.status(400).json({ error: err?.message || "Upload failed" });
});

export default router;
