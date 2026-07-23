import { listGallery, insertGalleryItem, deleteGalleryItem } from "../db/gallery.db.js";
import { mediaType, publicUrl, removeUploadedFile } from "../uploads/index.js";

/** GET /api/gallery — public list of admin-uploaded media, newest first. */
export const getGallery = (_req, res) => {
  try {
    res.json(listGallery());
  } catch (e) {
    console.error("[gallery] list failed:", e.message);
    res.status(500).json({ error: "Could not load the gallery." });
  }
};

/** POST /api/gallery — upload one or more media files (admin, multipart "files"). */
export const createGallery = (req, res) => {
  const files = req.files || [];
  if (files.length === 0) return res.status(400).json({ error: "No files uploaded" });
  const caption = (req.body?.caption || "").toString().slice(0, 200);
  const created = files.map((f) =>
    insertGalleryItem({ type: mediaType(f), url: publicUrl(f), caption })
  );
  res.status(201).json(created);
};

/** DELETE /api/gallery/:id — remove a media item + its file (admin). */
export const deleteGallery = (req, res) => {
  const removed = deleteGalleryItem(req.params.id);
  if (!removed) return res.status(404).json({ error: "Media not found" });
  removeUploadedFile(removed.url);
  res.json({ message: "Media deleted", id: req.params.id });
};

export default { getGallery, createGallery, deleteGallery };
