// Tour packages data layer (Tours & Travels page). Same local-schema pattern as
// promos.db.js. Admin-managed; seeded once with the original hard-coded
// packages so the page is never empty on first deploy.
//
// payment_mode: "online"  -> customer must pay the full amount online
//               "offline" -> reserve now, pay in person (no online payment)
//               "partial" -> customer pays advance_percent online, rest later
import { randomUUID } from "crypto";
import { getDb } from "./sqlite.js";

export const PAYMENT_MODES = ["online", "offline", "partial"];

const SEED = [
  {
    name: "Kodaikanal Premium Package", tagline: "Escape to the Pristine Hills",
    duration: "2 Days · 1 Night", price: "4,999", rating: "4.9", reviewsCount: 142,
    imageUrl: "https://images.pexels.com/photos/26933686/pexels-photo-26933686.jpeg",
    inclusions: ["Selected 4★ Boutique Stay", "Private Transport (Dzire/SUV)", "Sightseeing & Local Guides", "Complimentary Breakfasts"],
  },
  {
    name: "Kerala Backwaters Cruise", tagline: "Unwind on Premium Houseboats",
    duration: "4 Days · 3 Nights", price: "12,999", rating: "4.8", reviewsCount: 98,
    imageUrl: "https://images.unsplash.com/photo-1593693397690-362cb9666fc2?auto=format&fit=crop&q=80&w=600",
    inclusions: ["Premium Houseboat Accommodation", "All Meals (Traditional Kerala)", "Alleppey & Kumarakom Tours", "Private Cochin Airport Pickup"],
  },
  {
    name: "Ooty Tea Garden Retreat", tagline: "Ride the Iconic Toy Train",
    duration: "3 Days · 2 Nights", price: "6,499", rating: "4.9", reviewsCount: 165,
    imageUrl: "https://images.unsplash.com/photo-1590050752117-238cb0fb12b1?auto=format&fit=crop&q=80&w=600",
    inclusions: ["Boutique Estate Resort Stay", "Toy Train First Class Tickets", "Tea Estate Sightseeing", "Local Driver Bata Included"],
  },
  {
    name: "Coorg Coffee Plantation Trek", tagline: "Mist, Waterfalls, & Trekking",
    duration: "3 Days · 2 Nights", price: "7,999", rating: "4.7", reviewsCount: 110,
    imageUrl: "https://images.pexels.com/photos/29535096/pexels-photo-29535096.jpeg",
    inclusions: ["Heritage Plantation Homestay", "Abbey & Iruppu Falls Sightseeing", "Guided Estate Trek & Tasting", "Private SUV Transport (Innova)"],
  },
];

function ensure() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS packages (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      tagline         TEXT,
      duration        TEXT,
      price           TEXT,
      rating          TEXT,
      reviews_count   INTEGER NOT NULL DEFAULT 0,
      inclusions      TEXT,
      exclusions      TEXT,
      image_url       TEXT,
      payment_mode    TEXT NOT NULL DEFAULT 'online',
      advance_percent INTEGER NOT NULL DEFAULT 20,
      active          INTEGER NOT NULL DEFAULT 1,
      created_at      TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS packages_seeded (done INTEGER);
  `);
  // One-time seed: only if never seeded, so deleting every package later does
  // not resurrect the defaults.
  const seeded = db.prepare("SELECT COUNT(*) AS n FROM packages_seeded").get().n > 0;
  if (!seeded) {
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM packages").get();
    if (n === 0) for (const p of SEED) insertWith(db, p);
    db.prepare("INSERT INTO packages_seeded (done) VALUES (1)").run();
  }
  return db;
}

const clampPct = (v) => Math.min(99, Math.max(1, Math.round(Number(v)) || 20));

function insertWith(db, p) {
  const id = `pkg-${randomUUID().slice(0, 8)}`;
  db.prepare(
    `INSERT INTO packages (id, name, tagline, duration, price, rating, reviews_count, inclusions, exclusions,
                           image_url, payment_mode, advance_percent, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, String(p.name), p.tagline || null, p.duration || null, p.price || null, p.rating || null,
    Number(p.reviewsCount) || 0, JSON.stringify(p.inclusions || []), JSON.stringify(p.exclusions || []),
    p.imageUrl || null,
    PAYMENT_MODES.includes(p.paymentMode) ? p.paymentMode : "online",
    clampPct(p.advancePercent),
    p.active === false ? 0 : 1,
    new Date().toISOString()
  );
  return id;
}

const toPublic = (r) => ({
  id: r.id,
  name: r.name,
  tagline: r.tagline || "",
  duration: r.duration || "",
  price: r.price || "",
  rating: r.rating || "",
  reviewsCount: r.reviews_count || 0,
  inclusions: JSON.parse(r.inclusions || "[]"),
  exclusions: JSON.parse(r.exclusions || "[]"),
  imageUrl: r.image_url || "",
  paymentMode: r.payment_mode,
  advancePercent: r.advance_percent,
  active: r.active === 1,
  createdAt: r.created_at,
});

/** All packages in creation order (admin view). */
export function listPackages() {
  return ensure().prepare("SELECT * FROM packages ORDER BY rowid ASC").all().map(toPublic);
}

/** Only active packages (public Tours & Travels page). */
export function listActivePackages() {
  return ensure().prepare("SELECT * FROM packages WHERE active = 1 ORDER BY rowid ASC").all().map(toPublic);
}

export function getPackage(id) {
  const row = ensure().prepare("SELECT * FROM packages WHERE id = ?").get(String(id));
  return row ? toPublic(row) : null;
}

export function insertPackage(p) {
  const db = ensure();
  return toPublic(db.prepare("SELECT * FROM packages WHERE id = ?").get(insertWith(db, p)));
}

export function updatePackage(id, patch) {
  const db = ensure();
  const cur = getPackage(id);
  if (!cur) return null;
  const n = { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
  db.prepare(
    `UPDATE packages SET name=?, tagline=?, duration=?, price=?, rating=?, reviews_count=?, inclusions=?, exclusions=?,
       image_url=?, payment_mode=?, advance_percent=?, active=? WHERE id=?`
  ).run(
    String(n.name), n.tagline || null, n.duration || null, n.price || null, n.rating || null,
    Number(n.reviewsCount) || 0, JSON.stringify(n.inclusions || []), JSON.stringify(n.exclusions || []),
    n.imageUrl || null,
    PAYMENT_MODES.includes(n.paymentMode) ? n.paymentMode : "online",
    clampPct(n.advancePercent),
    n.active ? 1 : 0,
    String(id)
  );
  return getPackage(id);
}

export function deletePackage(id) {
  const db = ensure();
  const cur = getPackage(id);
  if (!cur) return null;
  db.prepare("DELETE FROM packages WHERE id = ?").run(String(id));
  return cur;
}
