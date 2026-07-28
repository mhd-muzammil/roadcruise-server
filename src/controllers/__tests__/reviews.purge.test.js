// Tests for the legacy-seed purge in the reviews data layer: databases that
// were seeded with the four placeholder testimonials must lose exactly those
// rows, while genuine customer submissions survive. Fresh installs get no
// seeding at all.
//
// Run: npm run test:bookings   (SQLITE_PATH/DATA_DIR isolated by setup.env.mjs)
import { test } from "node:test";
import assert from "node:assert/strict";

import { listApprovedReviews, insertReview } from "../../db/reviews.db.js";
import { getDb } from "../../db/sqlite.js";

test("fresh table gets no placeholder seeding", () => {
  const list = listApprovedReviews();
  assert.ok(!list.some((r) => r.name === "Arvind Kumar" || r.name === "Divya Shankar"));
});

test("legacy seeded rows are purged; real reviews survive", () => {
  listApprovedReviews(); // ensure the table exists before raw inserts
  const db = getDb();
  const ins = db.prepare(
    `INSERT INTO reviews (name, role, rating, text, avatar, approved, created_at)
     VALUES (?, ?, 5, ?, ?, 1, ?)`
  );
  // Recreate the old seeded state (two of the four legacy rows).
  ins.run("Arvind Kumar", "Corporate Executive", "The Mercedes E-Class was impeccable.",
    "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d", "2026-03-14T10:20:00.000Z");
  ins.run("Divya Shankar", "Business Owner", "Amazing support desk.",
    "https://images.unsplash.com/photo-1534528741775-53994a69daeb", "2026-06-07T12:30:00.000Z");

  // A genuine customer review — including one from a customer who happens to
  // share a legacy name (its created_at is live, so it must NOT be purged).
  const real = insertReview({ name: "Meena Krish", role: "Family trip", rating: 5, text: "Wonderful Kodaikanal trip, spotless car." });
  const sameName = insertReview({ name: "Arvind Kumar", role: "Office trip", rating: 4, text: "Smooth airport pickups every single time." });

  const list = listApprovedReviews();
  assert.ok(!list.some((r) => r.createdAt === "2026-03-14T10:20:00.000Z"), "legacy Arvind row purged");
  assert.ok(!list.some((r) => r.createdAt === "2026-06-07T12:30:00.000Z"), "legacy Divya row purged");
  assert.ok(list.some((r) => r.id === real.id), "real review survives");
  assert.ok(list.some((r) => r.id === sameName.id), "same-name real review survives");
});
