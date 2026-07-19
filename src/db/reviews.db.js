// Reviews data layer. Follows the sqlite.js pattern but keeps its schema local
// (CREATE TABLE IF NOT EXISTS on every access) so:
//   - sqlite.js stays untouched (it is shared with other features), and
//   - test suites that swap SQLITE_PATH to a fresh temp DB (testSupport.useTempDb)
//     always get the table re-created on demand — no stale module-level flag.
// Reviews are simple flat rows (no flexible document shape needed), so we use
// real columns instead of the JSON `data` column used by users/bookings.
import { getDb } from "./sqlite.js";

// The four long-standing testimonials previously hard-coded on the homepage.
// Seeded once, only when the table is empty, so the Reviews section is never
// blank on a fresh install. Seed avatars are kept; new submissions have none
// (the client renders an initial-letter avatar instead).
const SEED_REVIEWS = [
  {
    name: "Arvind Kumar",
    role: "Corporate Executive",
    rating: 5,
    avatar: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&q=80&w=120",
    text: "The Mercedes E-Class was impeccable. The driver was extremely professional, knew the routes perfectly, and made our executive business tour in Chennai completely hassle-free.",
    created_at: "2026-03-14T10:20:00.000Z",
  },
  {
    name: "Priya Menon",
    role: "Family Traveller",
    rating: 5,
    avatar: "https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&q=80&w=120",
    text: "Booked Kodaikanal package for family. Transparent pricing, excellent hotels, and hassle-free transit. The booking process was very smooth and transparent.",
    created_at: "2026-04-02T08:05:00.000Z",
  },
  {
    name: "Rakesh Iyer",
    role: "Regular Tourist",
    rating: 5,
    avatar: "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&q=80&w=120",
    text: "Extremely clean Innova Crysta. Very neat driver with proper uniform and tracking setup. Road Cruise definitely makes every journey feel like a true cruise.",
    created_at: "2026-05-11T16:45:00.000Z",
  },
  {
    name: "Divya Shankar",
    role: "Business Owner",
    rating: 5,
    avatar: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&q=80&w=120",
    text: "Amazing support desk. We needed to extend our Ooty tour by a day at midnight, and it was handled in minutes. The customer support is top-notch.",
    created_at: "2026-06-07T12:30:00.000Z",
  },
];

/** Open the DB, make sure the reviews table exists, and seed it when empty. */
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

  const { n } = db.prepare("SELECT COUNT(*) AS n FROM reviews").get();
  if (n === 0) {
    const ins = db.prepare(
      `INSERT INTO reviews (name, role, rating, text, avatar, approved, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)`
    );
    for (const r of SEED_REVIEWS) {
      ins.run(r.name, r.role, r.rating, r.text, r.avatar, r.created_at);
    }
  }
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
