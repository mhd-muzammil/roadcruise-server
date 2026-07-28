// Real tests for the promotions feature (the admin-published travel-package
// popup). Exercises the actual controller against a real (throwaway) SQLite DB
// — same pattern as booking.cancel.test.js, no mocks of our own code.
//
// Run: npm run test:bookings   (SQLITE_PATH/DATA_DIR isolated by setup.env.mjs)
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  getActivePromo, getPromos, createPromo, patchPromo, removePromo,
} from "../promo.controller.js";

/** Minimal stand-in for an Express response; records status + JSON body. */
function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

const create = (body) => {
  const res = mockRes();
  createPromo({ body }, res);
  return res;
};

test("create requires a title", () => {
  const res = create({ tagline: "no title here" });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /title/i);
});

test("create + active: the popup gets the published promo", () => {
  const res = create({
    title: "Kodaikanal Adventure Special",
    tagline: "Misty hills & lakeside views",
    duration: "3 Days · 4 Nights",
    price: "6,999",
    highlights: "Sightseeing & local guides\nPrivate SUV transport\n\nComplimentary breakfasts",
  });
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.active, true);
  // Newline-separated highlights are split, trimmed, and blanks dropped.
  assert.deepEqual(res.body.highlights, [
    "Sightseeing & local guides",
    "Private SUV transport",
    "Complimentary breakfasts",
  ]);

  const active = mockRes();
  getActivePromo({}, active);
  assert.equal(active.body.id, res.body.id);
  assert.equal(active.body.title, "Kodaikanal Adventure Special");
});

test("newest active promo wins; hiding it falls back to the previous one", () => {
  const older = create({ title: "Ooty Retreat" }).body;
  const newer = create({ title: "Kerala Backwaters Cruise" }).body;

  const active1 = mockRes();
  getActivePromo({}, active1);
  assert.equal(active1.body.id, newer.id);

  // Hide the newer promo — the older live one takes over.
  const patched = mockRes();
  patchPromo({ params: { id: newer.id }, body: { active: false } }, patched);
  assert.equal(patched.body.active, false);

  const active2 = mockRes();
  getActivePromo({}, active2);
  assert.equal(active2.body.id, older.id);
});

test("highlights are capped at 6 entries", () => {
  const lines = Array.from({ length: 9 }, (_, i) => `Highlight ${i + 1}`).join("\n");
  const res = create({ title: "Capped", highlights: lines });
  assert.equal(res.body.highlights.length, 6);
});

test("patch edits fields and 404s on unknown ids", () => {
  const promo = create({ title: "Coorg Trek", price: "7,999" }).body;

  const patched = mockRes();
  patchPromo({ params: { id: promo.id }, body: { price: "8,499", tagline: "Now with tastings" } }, patched);
  assert.equal(patched.body.price, "8,499");
  assert.equal(patched.body.tagline, "Now with tastings");
  assert.equal(patched.body.title, "Coorg Trek"); // untouched field survives

  const missing = mockRes();
  patchPromo({ params: { id: "promo-nope" }, body: { active: false } }, missing);
  assert.equal(missing.statusCode, 404);
});

test("delete removes the promo from the admin list and the popup", () => {
  const promo = create({ title: "Delete Me" }).body;

  const del = mockRes();
  removePromo({ params: { id: promo.id } }, del);
  assert.equal(del.statusCode, 200);

  const list = mockRes();
  getPromos({}, list);
  assert.ok(!list.body.some((p) => p.id === promo.id));

  const again = mockRes();
  removePromo({ params: { id: promo.id } }, again);
  assert.equal(again.statusCode, 404);
});
