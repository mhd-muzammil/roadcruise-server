// Reviews data layer. Follows the sqlite.js pattern but keeps its schema local
// (CREATE TABLE IF NOT EXISTS on every access) so:
//   - sqlite.js stays untouched (it is shared with other features), and
//   - test suites that swap SQLITE_PATH to a fresh temp DB (testSupport.useTempDb)
//     always get the table re-created on demand — no stale module-level flag.
// Reviews are simple flat rows (no flexible document shape needed), so we use
// real columns instead of the JSON `data` column used by users/bookings.
import { getDb } from "./sqlite.js";

// The four placeholder testimonials this table used to seed on first run.
// Seeding was removed (only genuine customer submissions are shown now), but
// databases that already ran the old seed still hold these rows — ensure()
// deletes them by their exact hard-coded (name, created_at) pairs, which no
// real submission can collide with (real created_at values carry live
// millisecond timestamps from new Date().toISOString()).
const LEGACY_SEED_KEYS = [
  ["Arvind Kumar", "2026-03-14T10:20:00.000Z"],
  ["Priya Menon", "2026-04-02T08:05:00.000Z"],
  ["Rakesh Iyer", "2026-05-11T16:45:00.000Z"],
  ["Divya Shankar", "2026-06-07T12:30:00.000Z"],
];

/** Open the DB, make sure the reviews table exists, and purge legacy seeds. */
function ensure() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS reviews (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT    NOT NULL,
      role       TEXT,
      rating     INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      text       TEXT    NOT NULL,
      avatar     TEXT,
      approved   INTEGER NOT NULL DEFAULT 1,
      created_at TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reviews_approved ON reviews(approved, id);
  `);

  const purge = db.prepare("DELETE FROM reviews WHERE name = ? AND created_at = ?");
  for (const [name, createdAt] of LEGACY_SEED_KEYS) purge.run(name, createdAt);
  return db;
}

const toPublic = (row) => ({
  id: row.id,
  name: row.name,
  role: row.role || "",
  rating: Number(row.rating),
  text: row.text,
  avatar: row.avatar || null,
  createdAt: row.created_at,
});

/** Approved reviews, newest first (insertion order), capped. Public shape. */
export function listApprovedReviews(limit = 50) {
  const db = ensure();
  return db
    .prepare("SELECT * FROM reviews WHERE approved = 1 ORDER BY id DESC LIMIT ?")
    .all(Number(limit))
    .map(toPublic);
}

/**
 * Insert one (already validated/sanitized) review. Approved by default — flip
 * the `approved` column to 0 to hide an entry without deleting it.
 * Returns the stored review in the public shape.
 */
export function insertReview({ name, role, rating, text }) {
  const db = ensure();
  const createdAt = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO reviews (name, role, rating, text, avatar, approved, created_at)
       VALUES (?, ?, ?, ?, NULL, 1, ?)`
    )
    .run(name, role || null, rating, text, createdAt);
  const row = db.prepare("SELECT * FROM reviews WHERE id = ?").get(info.lastInsertRowid);
  return toPublic(row);
}
