import {
  listPromos, getActivePromo as activePromo, insertPromo, updatePromo, deletePromo,
} from "../db/promos.db.js";
import { mediaType, publicUrl, removeUploadedFile } from "../uploads/index.js";
import { announceOffer } from "../notifications/broadcast/offerBroadcast.js";
import { notify } from "../notifications/index.js";

// Bounded field sizes — the popup is a compact card, not a CMS page.
const clip = (v, n) => (v === undefined || v === null ? undefined : String(v).slice(0, n));

/**
 * Normalize highlights from either a JSON array or a newline-separated string
 * (the admin form sends a textarea, one highlight per line). Max 6 × 90 chars.
 */
function parseHighlights(raw) {
  if (raw === undefined) return undefined;
  let list = raw;
  if (typeof raw === "string") {
    try { list = JSON.parse(raw); } catch { list = raw.split(/\r?\n/); }
  }
  if (!Array.isArray(list)) return [];
  return list.map((h) => String(h).trim().slice(0, 90)).filter(Boolean).slice(0, 6);
}

/** Accept the uploaded file only if it is an image; discard videos. */
function imageUrlFromUpload(req, res) {
  const f = req.file;
  if (!f) return undefined;
  if (mediaType(f) !== "image") {
    removeUploadedFile(publicUrl(f));
    res.status(400).json({ error: "Promotion media must be an image" });
    return null;
  }
  return publicUrl(f);
}

/** GET /api/promos/active — the newest active promo for the public popup (or null). */
export const getActivePromo = (_req, res) => {
  try {
    res.json(activePromo());
  } catch (e) {
    console.error("[promos] active failed:", e.message);
    res.status(500).json({ error: "Could not load promotions." });
  }
};

/** GET /api/promos — all promos, newest first (admin). */
export const getPromos = (_req, res) => {
  try {
    res.json(listPromos());
  } catch (e) {
    console.error("[promos] list failed:", e.message);
    res.status(500).json({ error: "Could not load promotions." });
  }
};

/** POST /api/promos — create a promo (admin; multipart with optional "image"). */
export const createPromo = (req, res) => {
  const title = clip(req.body?.title, 120)?.trim();
  if (!title) return res.status(400).json({ error: "Package title is required" });
  const imageUrl = imageUrlFromUpload(req, res);
  if (imageUrl === null) return; // rejected non-image upload
  const created = insertPromo({
    title,
    tagline: clip(req.body?.tagline, 160),
    duration: clip(req.body?.duration, 60),
    price: clip(req.body?.price, 40),
    highlights: parseHighlights(req.body?.highlights) || [],
    imageUrl,
    active: String(req.body?.active) !== "false",
  });
  res.status(201).json(created);
};

/** PATCH /api/promos/:id — edit fields / toggle active (admin; optional new "image"). */
export const patchPromo = (req, res) => {
  const imageUrl = imageUrlFromUpload(req, res);
  if (imageUrl === null) return;
  const patch = {
    title: clip(req.body?.title, 120),
    tagline: clip(req.body?.tagline, 160),
    duration: clip(req.body?.duration, 60),
    price: clip(req.body?.price, 40),
    highlights: parseHighlights(req.body?.highlights),
    imageUrl,
  };
  if (req.body?.active !== undefined) {
    patch.active = req.body.active === true || String(req.body.active) === "true";
  }
  const before = imageUrl ? listPromos().find((p) => p.id === req.params.id) : null;
  const updated = updatePromo(req.params.id, patch);
  if (!updated) {
    if (imageUrl) removeUploadedFile(imageUrl); // orphaned upload for a missing promo
    return res.status(404).json({ error: "Promotion not found" });
  }
  if (before?.imageUrl && before.imageUrl !== updated.imageUrl) removeUploadedFile(before.imageUrl);
  res.json(updated);
};

/** DELETE /api/promos/:id — remove a promo + its image file (admin). */
export const removePromo = (req, res) => {
  const removed = deletePromo(req.params.id);
  if (!removed) return res.status(404).json({ error: "Promotion not found" });
  removeUploadedFile(removed.imageUrl);
  res.json({ message: "Promotion deleted", id: req.params.id });
};

export default { getActivePromo, getPromos, createPromo, patchPromo, removePromo };

/**
 * POST /api/promos/:id/announce — tell existing customers about this package.
 *
 * Deliberately a SEPARATE, explicit action rather than a side effect of
 * publishing: creating a promo shows it in the site popup, which is free and
 * reversible, while announcing it spends money and lands on real handsets.
 * Fusing the two would make an admin typo cost an SMS to every customer.
 *
 * Safe to call twice — the engine dedupes on (event, channel, recipient, promo),
 * so a second click reaches nobody a second time.
 */
export const announcePromo = (req, res) => {
  const promo = listPromos().find((p) => p.id === req.params.id);
  if (!promo) return res.status(404).json({ error: "Promo not found" });
  const r = announceOffer({ promo, notify });
  res.status(202).json({
    ...r,
    note: "Email sends now. SMS is queued and will dead-letter until MSG91_OFFER_TEMPLATE_ID is set.",
  });
};
