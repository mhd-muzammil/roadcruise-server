import {
  listPackages, listActivePackages, insertPackage, updatePackage, deletePackage, getPackage, PAYMENT_MODES,
} from "../db/packages.db.js";
import { mediaType, publicUrl, removeUploadedFile } from "../uploads/index.js";

const clip = (v, n) => (v === undefined || v === null ? undefined : String(v).slice(0, n));

/** Accepts a JSON array or newline-separated text; max 12 lines x 120 chars. */
function parseList(raw) {
  if (raw === undefined) return undefined;
  let list = raw;
  if (typeof raw === "string") {
    try { list = JSON.parse(raw); } catch { list = raw.split(/\r?\n/); }
  }
  if (!Array.isArray(list)) return [];
  return list.map((h) => String(h).trim().slice(0, 120)).filter(Boolean).slice(0, 12);
}

function imageFromUpload(req, res) {
  const f = req.file;
  if (!f) return undefined;
  if (mediaType(f) !== "image") {
    removeUploadedFile(publicUrl(f));
    res.status(400).json({ error: "Package media must be an image" });
    return null;
  }
  return publicUrl(f);
}

function readFields(body) {
  const b = body || {};
  const f = {
    name: clip(b.name, 120)?.trim(),
    tagline: clip(b.tagline, 160),
    duration: clip(b.duration, 60),
    price: clip(b.price, 40),
    rating: clip(b.rating, 5),
    reviewsCount: b.reviewsCount === undefined || b.reviewsCount === "" ? undefined : Math.max(0, parseInt(b.reviewsCount, 10) || 0),
    inclusions: parseList(b.inclusions),
    exclusions: parseList(b.exclusions),
    paymentMode: b.paymentMode,
    advancePercent: b.advancePercent === undefined || b.advancePercent === "" ? undefined : Number(b.advancePercent),
  };
  if (b.active !== undefined) f.active = b.active === true || String(b.active) === "true";
  return f;
}

const badMode = (f) => f.paymentMode !== undefined && !PAYMENT_MODES.includes(f.paymentMode);

/** GET /api/packages — active packages (public; feeds Tours & Travels). */
export const getPublicPackages = (_req, res) => {
  try { res.json(listActivePackages()); }
  catch (e) { console.error("[packages] list failed:", e.message); res.status(500).json({ error: "Could not load packages." }); }
};

/** GET /api/packages/all — every package (admin). */
export const getAdminPackages = (_req, res) => {
  try { res.json(listPackages()); }
  catch (e) { console.error("[packages] admin list failed:", e.message); res.status(500).json({ error: "Could not load packages." }); }
};

export const createPackage = (req, res) => {
  const f = readFields(req.body);
  if (!f.name) return res.status(400).json({ error: "Package name is required" });
  if (badMode(f)) return res.status(400).json({ error: "Payment mode must be online, offline or partial" });
  const imageUrl = imageFromUpload(req, res);
  if (imageUrl === null) return;
  res.status(201).json(insertPackage({ ...f, imageUrl: imageUrl || clip(req.body?.imageUrl, 500) }));
};

export const patchPackage = (req, res) => {
  const f = readFields(req.body);
  if (f.name !== undefined && !f.name) return res.status(400).json({ error: "Package name is required" });
  if (badMode(f)) return res.status(400).json({ error: "Payment mode must be online, offline or partial" });
  const imageUrl = imageFromUpload(req, res);
  if (imageUrl === null) return;
  const before = getPackage(req.params.id);
  if (!before) {
    if (imageUrl) removeUploadedFile(imageUrl);
    return res.status(404).json({ error: "Package not found" });
  }
  const updated = updatePackage(req.params.id, { ...f, ...(imageUrl ? { imageUrl } : {}) });
  if (imageUrl && before.imageUrl && before.imageUrl !== imageUrl) removeUploadedFile(before.imageUrl);
  res.json(updated);
};

export const removePackage = (req, res) => {
  const removed = deletePackage(req.params.id);
  if (!removed) return res.status(404).json({ error: "Package not found" });
  removeUploadedFile(removed.imageUrl);
  res.json({ message: "Package deleted", id: req.params.id });
};
