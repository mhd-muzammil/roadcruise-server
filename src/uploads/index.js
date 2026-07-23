// File-upload plumbing for admin-uploaded vehicle photos/videos and gallery media.
// Files land on durable storage under dataDir("uploads", …) — the same DATA_DIR
// convention the SQLite DB uses — and are served read-only by app.js at /uploads.
//
// Stored media is referenced by a RELATIVE path ("/uploads/<file>") so it is
// origin-agnostic: the Vercel client (a different origin than this API) prepends
// the API origin itself (see client mediaUrl helper). External URLs (e.g. the
// seed Pinterest images) are left untouched.
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import multer from "multer";
import { dataDir } from "../dataDir.js";

// Resolve + create the uploads directory once at module load.
export const UPLOAD_DIR = dataDir("uploads", path.resolve(process.cwd(), "src/config/uploads"));
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// The public route prefix app.js mounts express.static on.
export const UPLOAD_ROUTE = "/uploads";

const MIME_EXT = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/avif": ".avif",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
};

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    // Never trust the client filename. Derive a safe extension from the mimetype
    // (falling back to the original extension), and use a random unique base.
    const ext = MIME_EXT[file.mimetype] || path.extname(file.originalname).toLowerCase().slice(0, 8) || "";
    cb(null, `${Date.now()}-${randomUUID().slice(0, 8)}${ext}`);
  },
});

const fileFilter = (_req, file, cb) => {
  if (/^image\//.test(file.mimetype) || /^video\//.test(file.mimetype)) return cb(null, true);
  cb(new Error("Only image and video files are allowed"));
};

// 50 MB cap — comfortably covers photos and short promo clips.
export const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 50 * 1024 * 1024, files: 10 },
});

/** "image" | "video" from an uploaded file's mimetype. */
export const mediaType = (file) => (/^video\//.test(file.mimetype) ? "video" : "image");

/** Public relative URL for a stored file (e.g. "/uploads/172-ab.jpg"). */
export const publicUrl = (file) => `${UPLOAD_ROUTE}/${file.filename}`;

/** Best-effort delete of a stored file given its relative "/uploads/<name>" url. */
export function removeUploadedFile(relUrl) {
  try {
    if (!relUrl || !String(relUrl).startsWith(`${UPLOAD_ROUTE}/`)) return; // external URL — leave it
    const name = path.basename(String(relUrl));
    fs.unlinkSync(path.join(UPLOAD_DIR, name));
  } catch { /* already gone / non-fatal */ }
}

export default { upload, UPLOAD_DIR, UPLOAD_ROUTE, mediaType, publicUrl, removeUploadedFile };
