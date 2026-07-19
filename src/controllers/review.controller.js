import { listApprovedReviews, insertReview } from "../db/reviews.db.js";

const MAX_RETURNED = 50;

// Replace ASCII control characters (0x00-0x1F, 0x7F) with spaces. Written as a
// code-point filter (not a regex class) to keep the source free of escapes.
const stripControlChars = (s) => {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0);
    out += c < 32 || c === 127 ? " " : ch;
  }
  return out;
};

// Sanitize free text: remove anything tag-like, drop stray angle brackets and
// control chars, collapse whitespace. React escapes on render anyway — this is
// defense-in-depth so no markup is ever stored.
const sanitize = (v) =>
  stripControlChars(String(v ?? ""))
    .replace(/<[^>]*>/g, " ")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();

// Obvious link spam: protocols, www., or bare domain.tld mentions.
const URL_RE =
  /(https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|net|org|info|biz|io|co|in|ly|me|app|site|online|shop|store|xyz)\b)/i;

/**
 * GET /api/reviews
 * Public. Approved reviews, newest first, capped at 50. Plain array (same
 * style as GET /api/bookings).
 */
export const getReviews = (_req, res) => {
  try {
    res.json(listApprovedReviews(MAX_RETURNED));
  } catch (e) {
    console.error("[reviews] list failed:", e.message);
    res.status(500).json({ error: "Could not load reviews." });
  }
};

/**
 * POST /api/reviews
 * Public (guest) submission — same trust model as the contact form, plus a
 * per-IP rate limit applied in the route. Body: { name, role?, rating, text }.
 * Validation: name 2-60 chars, optional role <= 60 chars, integer rating 1-5,
 * text 10-600 chars, HTML stripped, link spam rejected.
 */
export const createReview = (req, res) => {
  const name = sanitize(req.body?.name);
  const role = sanitize(req.body?.role).slice(0, 60);
  const rating = Number(req.body?.rating);
  const text = sanitize(req.body?.text);

  if (name.length < 2 || name.length > 60) {
    return res.status(400).json({ error: "Please enter your name (2-60 characters)." });
  }
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: "Please choose a star rating from 1 to 5." });
  }
  if (text.length < 10 || text.length > 600) {
    return res.status(400).json({ error: "Your review must be between 10 and 600 characters." });
  }
  if (URL_RE.test(text) || URL_RE.test(name) || URL_RE.test(role)) {
    return res.status(400).json({ error: "Links are not allowed in reviews." });
  }

  try {
    const review = insertReview({ name, role, rating, text });
    return res.status(201).json({ review });
  } catch (e) {
    console.error("[reviews] insert failed:", e.message);
    return res.status(500).json({ error: "Could not save your review. Please try again." });
  }
};
