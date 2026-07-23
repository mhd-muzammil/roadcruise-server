// Gallery data layer. Same local-schema pattern as reviews.db.js / vehicles.db.js.
// Holds admin-uploaded media (photos + videos) shown on the public /gallery page.
// Flat rows (no flexible document shape), so real columns instead of a JSON blob.
import { randomUUID } from "crypto";
import { getDb } from "./sqlite.js";

/** Open the DB and ensure the gallery table exists. */
function ensure() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS gallery (
      id         TEXT PRIMARY KEY,
      type       TEXT NOT NULL DEFAULT 'image',
      url        TEXT NOT NULL,
      caption    TEXT,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

const toPublic = (row) => ({
  id: row.id,
  type: row.type,
  url: row.url,
  caption: row.caption || "",
  createdAt: row.created_at,
});

/** All gallery items, newest first. */
export function listGallery() {
  const db = ensure();
  return db.prepare("SELECT * FROM gallery ORDER BY rowid DESC").all().map(toPublic);
}

/** Insert one media item. type is "image" | "video". Returns the stored item. */
export function insertGalleryItem({ type, url, caption }) {
  const db = ensure();
  const id = `gal-${randomUUID().slice(0, 8)}`;
  const createdAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO gallery (id, type, url, caption, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run(id, type === "video" ? "video" : "image", String(url), caption || null, createdAt);
  return toPublic(db.prepare("SELECT * FROM gallery WHERE id = ?").get(id));
}

/** Delete one media item. Returns the removed row (for file cleanup) or null. */
export function deleteGalleryItem(id) {
  const db = ensure();
  const row = db.prepare("SELECT * FROM gallery WHERE id = ?").get(String(id));
  if (!row) return null;
  db.prepare("DELETE FROM gallery WHERE id = ?").run(String(id));
  return toPublic(row);
}

export default { listGallery, insertGalleryItem, deleteGalleryItem };
