// Promotions data layer. Same local-schema pattern as gallery.db.js.
// Holds admin-created promotional travel packages shown to visitors in the
// site-wide popup (e.g. "Kodaikanal 3 Days · 4 Nights"). Flat rows; the
// highlights list is a small bounded JSON array stored as TEXT.
import { randomUUID } from "crypto";
import { getDb } from "./sqlite.js";

/** Open the DB and ensure the promos table exists. */
function ensure() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS promos (
      id         TEXT PRIMARY KEY,
      title      TEXT NOT NULL,
      tagline    TEXT,
      duration   TEXT,
      price      TEXT,
      highlights TEXT,
      image_url  TEXT,
      active     INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

const toPublic = (row) => ({
  id: row.id,
  title: row.title,
  tagline: row.tagline || "",
  duration: row.duration || "",
  price: row.price || "",
  highlights: JSON.parse(row.highlights || "[]"),
  imageUrl: row.image_url || "",
  active: row.active === 1,
  createdAt: row.created_at,
});

/** All promos, newest first (admin view). */
export function listPromos() {
  const db = ensure();
  return db.prepare("SELECT * FROM promos ORDER BY rowid DESC").all().map(toPublic);
}

/** The newest ACTIVE promo (what the public popup shows), or null. */
export function getActivePromo() {
  const db = ensure();
  const row = db.prepare("SELECT * FROM promos WHERE active = 1 ORDER BY rowid DESC LIMIT 1").get();
  return row ? toPublic(row) : null;
}

/** Insert one promo. Returns the stored promo. */
export function insertPromo({ title, tagline, duration, price, highlights, imageUrl, active }) {
  const db = ensure();
  const id = `promo-${randomUUID().slice(0, 8)}`;
  const createdAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO promos (id, title, tagline, duration, price, highlights, image_url, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    String(title),
    tagline || null,
    duration || null,
    price || null,
    JSON.stringify(highlights || []),
    imageUrl || null,
    active === false ? 0 : 1,
    createdAt
  );
  return toPublic(db.prepare("SELECT * FROM promos WHERE id = ?").get(id));
}

/** Partial update (text fields, image, active toggle). Returns the promo or null. */
export function updatePromo(id, patch) {
  const db = ensure();
  const row = db.prepare("SELECT * FROM promos WHERE id = ?").get(String(id));
  if (!row) return null;
  const next = {
    title: patch.title !== undefined ? String(patch.title) : row.title,
    tagline: patch.tagline !== undefined ? patch.tagline || null : row.tagline,
    duration: patch.duration !== undefined ? patch.duration || null : row.duration,
    price: patch.price !== undefined ? patch.price || null : row.price,
    highlights: patch.highlights !== undefined ? JSON.stringify(patch.highlights || []) : row.highlights,
    image_url: patch.imageUrl !== undefined ? patch.imageUrl || null : row.image_url,
    active: patch.active !== undefined ? (patch.active ? 1 : 0) : row.active,
  };
  db.prepare(
    `UPDATE promos SET title = ?, tagline = ?, duration = ?, price = ?, highlights = ?, image_url = ?, active = ?
     WHERE id = ?`
  ).run(next.title, next.tagline, next.duration, next.price, next.highlights, next.image_url, next.active, String(id));
  return toPublic(db.prepare("SELECT * FROM promos WHERE id = ?").get(String(id)));
}

/** Delete one promo. Returns the removed promo (for image cleanup) or null. */
export function deletePromo(id) {
  const db = ensure();
  const row = db.prepare("SELECT * FROM promos WHERE id = ?").get(String(id));
  if (!row) return null;
  db.prepare("DELETE FROM promos WHERE id = ?").run(String(id));
  return toPublic(row);
}

export default { listPromos, getActivePromo, insertPromo, updatePromo, deletePromo };
