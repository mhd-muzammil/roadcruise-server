// Real tests for the dual-source place search (GET /api/places/search): Photon
// and Nominatim are queried in parallel, merged, deduped and capped. The
// controller is exercised for real — only the NETWORK boundary (global fetch)
// is stubbed, since unit tests must not depend on third-party uptime.
//
// Run: npm run test:bookings   (same isolated suite; no DB needed here)
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { searchPlaces, detectCategory } from "../places.controller.js";

// ---- tiny test doubles -------------------------------------------------------

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

const reqFor = (q) => ({ query: { q } });

/** Photon FeatureCollection with the given place names (IN unless overridden). */
const photonPayload = (...names) => ({
  features: names.map((name, i) => ({
    properties: {
      name: typeof name === "string" ? name : name.name,
      countrycode: typeof name === "string" ? "IN" : name.countrycode || "IN",
      osm_value: typeof name === "string" ? undefined : name.osm_value,
      city: "Chennai",
      state: "Tamil Nadu",
      postcode: "600001",
      osm_type: "N",
      osm_id: 1000 + i,
    },
    geometry: { coordinates: [80.2 + i * 0.5, 13.0 + i * 0.5] },
  })),
});

/** Nominatim jsonv2 array with the given place names. */
const nominatimPayload = (...names) =>
  names.map((name, i) => ({
    place_id: 2000 + i,
    name,
    display_name: `${name}, Tamil Nadu, India`,
    lat: String(9.0 + i),
    lon: String(78.0 + i),
    address: { village: name, state: "Tamil Nadu", postcode: "600100" },
  }));

// Route the stubbed fetch by upstream host. `null` payload = simulated outage.
// `taggedResult` answers the extra osm_tag-filtered Photon call that a typed
// category ("… railway station") triggers.
let photonResult, nominatimResult, taggedResult;
let fetchCalls;
const realFetch = global.fetch;

beforeEach(() => {
  fetchCalls = [];
  taggedResult = { features: [] };
  global.fetch = async (url) => {
    const href = String(url);
    fetchCalls.push(href);
    // Route by HOSTNAME — the search term also appears in the query string, so
    // a substring check on the whole URL would misroute (e.g. q="photon-down").
    const host = new URL(href).hostname;
    const payload = host.includes("komoot")
      ? (href.includes("osm_tag=") ? taggedResult : photonResult)
      : nominatimResult;
    if (payload === null) throw new Error("simulated upstream outage");
    return { ok: true, json: async () => payload };
  };
});

afterEach(() => {
  global.fetch = realFetch;
});

// The controller keeps a 1h in-process cache keyed by the query — every test
// uses a DISTINCT query string so tests can never see each other's cache.

// ---- 1. Results from BOTH sources are merged ---------------------------------

test("suggestions merge Photon and Nominatim results", async () => {
  photonResult = photonPayload("Vandalur");
  nominatimResult = nominatimPayload("Vandalur Zoo Road");

  const res = mockRes();
  await searchPlaces(reqFor("merge-test"), res);

  assert.equal(res.statusCode, 200);
  const names = res.body.map((s) => s.name);
  assert.ok(names.includes("Vandalur"), "Photon result present");
  assert.ok(names.includes("Vandalur Zoo Road"), "Nominatim result present");
  assert.equal(fetchCalls.length, 2, "both upstreams queried in parallel");
  assert.ok(res.body.every((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon)), "every suggestion has coordinates");
});

// ---- 2. Duplicates across sources are removed --------------------------------

test("the same place returned by both sources appears once", async () => {
  // Same name at (nearly) the same coordinates from both sources.
  photonResult = {
    features: [{
      properties: { name: "Guduvancheri", countrycode: "IN", state: "Tamil Nadu", osm_type: "N", osm_id: 1 },
      geometry: { coordinates: [80.06, 12.84] },
    }],
  };
  nominatimResult = [{
    place_id: 9,
    name: "Guduvancheri",
    display_name: "Guduvancheri, Tamil Nadu, India",
    lat: "12.841",
    lon: "80.061",
    address: { town: "Guduvancheri", state: "Tamil Nadu" },
  }];

  const res = mockRes();
  await searchPlaces(reqFor("dedup-test"), res);

  const dupes = res.body.filter((s) => s.name === "Guduvancheri");
  assert.equal(dupes.length, 1, "near-identical cross-source entries are deduped");
});

// ---- 3. One source down → the other still answers ----------------------------

test("Photon outage → Nominatim results still served (never an empty error)", async () => {
  photonResult = null; // outage
  nominatimResult = nominatimPayload("Kelambakkam", "Kelambakkam Bypass");

  const res = mockRes();
  await searchPlaces(reqFor("photon-down-test"), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.length, 2);
  assert.equal(res.body[0].name, "Kelambakkam");
});

test("Nominatim outage → Photon results still served", async () => {
  photonResult = photonPayload("Pallikaranai");
  nominatimResult = null; // outage

  const res = mockRes();
  await searchPlaces(reqFor("nominatim-down-test"), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].name, "Pallikaranai");
});

// ---- 4. Both sources down → 502 ----------------------------------------------

test("both upstreams down → 502 with a friendly error", async () => {
  photonResult = null;
  nominatimResult = null;

  const res = mockRes();
  await searchPlaces(reqFor("all-down-test"), res);

  assert.equal(res.statusCode, 502);
  assert.match(res.body.error, /unavailable/i);
});

// ---- 5. Result cap + IN-only filter ------------------------------------------

test("results are capped at 8 and non-IN Photon features are dropped", async () => {
  photonResult = photonPayload(
    "P1", "P2", "P3", "P4", "P5", "P6",
    { name: "Colombo", countrycode: "LK" } // must be filtered out
  );
  nominatimResult = nominatimPayload("N1", "N2", "N3", "N4", "N5");

  const res = mockRes();
  await searchPlaces(reqFor("cap-test"), res);

  assert.equal(res.body.length, 8, "capped at 8 suggestions");
  assert.ok(!res.body.some((s) => s.name === "Colombo"), "non-IN results are dropped");
});

// ---- 6. Caching: full merges are cached; partial results are NOT -------------

test("a fully-merged answer is served from cache on repeat queries", async () => {
  photonResult = photonPayload("Tambaram");
  nominatimResult = nominatimPayload("Tambaram Sanatorium");

  await searchPlaces(reqFor("cache-test"), mockRes());
  assert.equal(fetchCalls.length, 2, "first call hits both upstreams");

  const res = mockRes();
  await searchPlaces(reqFor("cache-test"), res);
  assert.equal(fetchCalls.length, 2, "second call is answered from cache (no new fetches)");
  assert.equal(res.body.length, 2);
});

test("a partial (one-source-down) answer is NOT cached — the outage is retried", async () => {
  photonResult = null; // outage on the first call
  nominatimResult = nominatimPayload("Chengalpattu");

  await searchPlaces(reqFor("partial-cache-test"), mockRes());
  const callsAfterFirst = fetchCalls.length;

  photonResult = photonPayload("Chengalpattu Fort"); // upstream recovered
  const res = mockRes();
  await searchPlaces(reqFor("partial-cache-test"), res);

  assert.ok(fetchCalls.length > callsAfterFirst, "the repeat query re-fetches (partial result was not pinned)");
  assert.ok(res.body.some((s) => s.name === "Chengalpattu Fort"), "recovered source's results now appear");
});

// ---- 7. Short queries short-circuit ------------------------------------------

test("queries under 2 chars return [] without touching any upstream", async () => {
  const res = mockRes();
  await searchPlaces(reqFor("v"), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, []);
  assert.equal(fetchCalls.length, 0, "no upstream call for a 1-char query");
});

// ---- 8. Category detection ---------------------------------------------------

test("detectCategory maps typed categories to OSM tags and strips the phrase", () => {
  assert.deepEqual(detectCategory("vandalur railway station"), { tag: "railway:station", base: "vandalur" });
  assert.deepEqual(detectCategory("Tambaram Train Station"), { tag: "railway:station", base: "tambaram" });
  // "bus station" must win over the bare "station" phrase (longest match first).
  assert.deepEqual(detectCategory("kelambakkam bus station"), { tag: "amenity:bus_station", base: "kelambakkam" });
  assert.deepEqual(detectCategory("chennai airport"), { tag: "aeroway:aerodrome", base: "chennai" });
  assert.equal(detectCategory("vandalur"), null, "a plain place name is not a category");
  assert.equal(detectCategory("railway station"), null, "a category with no place left is not usable");
});

// ---- 9. A typed category finds places OSM names bare -------------------------

test("'X railway station' surfaces the station OSM calls plain 'X', ranked first", async () => {
  // What the upstreams really do: the literal phrase matches almost nothing,
  // while the tag-filtered lookup finds the station (named just "Vandalur").
  photonResult = photonPayload("Kilambakkam Railway Station");
  nominatimResult = [];
  taggedResult = photonPayload({ name: "Vandalur", osm_value: "station" });

  const res = mockRes();
  await searchPlaces(reqFor("vandalur railway station"), res);

  assert.equal(res.statusCode, 200);
  assert.equal(fetchCalls.length, 3, "a third, tag-filtered lookup is issued");
  assert.ok(
    fetchCalls.some((u) => u.includes("osm_tag=railway%3Astation") && u.includes("vandalur")),
    "the tagged lookup drops the category words and filters by railway:station"
  );
  assert.equal(res.body[0].name, "Vandalur", "the station ranks first — it is what was typed");
  assert.equal(res.body[0].kind, "Railway Station");
  assert.match(res.body[0].label, /Vandalur \(Railway Station\)/, "the kind is woven into the stored label");
});

test("no category in the query → no third lookup", async () => {
  photonResult = photonPayload("Chennai");
  nominatimResult = [];

  await searchPlaces(reqFor("chennai-plain-test"), mockRes());
  assert.equal(fetchCalls.length, 2, "only the two general sources are queried");
});

// ---- 10. Kind labelling + kind-aware dedup ----------------------------------

test("a town and the station inside it both survive (dedup is kind-aware)", async () => {
  // Same name, same rounded coordinates — only the kind differs. Before this
  // was kind-aware, the station was silently dropped as a duplicate.
  photonResult = {
    features: [
      {
        properties: { name: "Vandalur", countrycode: "IN", osm_value: "town", state: "Tamil Nadu", osm_type: "N", osm_id: 1 },
        geometry: { coordinates: [80.083, 12.8921] },
      },
      {
        properties: { name: "Vandalur", countrycode: "IN", osm_value: "station", state: "Tamil Nadu", osm_type: "N", osm_id: 2 },
        geometry: { coordinates: [80.085, 12.8916] },
      },
    ],
  };
  nominatimResult = [];

  const res = mockRes();
  await searchPlaces(reqFor("kind-dedup-test"), res);

  assert.equal(res.body.length, 2, "both the town and the station are offered");
  assert.deepEqual(res.body.map((s) => s.kind), ["Town", "Railway Station"]);
  assert.equal(res.body[0].label, "Vandalur, Tamil Nadu", "a plain town label carries no kind suffix");
  assert.match(res.body[1].label, /^Vandalur \(Railway Station\)/, "the station's label is distinguishable");
});

test("genuine duplicates (same name, kind and place) still collapse", async () => {
  photonResult = {
    features: [1, 2].map((n) => ({
      properties: { name: "Guduvancheri", countrycode: "IN", osm_value: "town", state: "Tamil Nadu", osm_type: "N", osm_id: n },
      geometry: { coordinates: [80.06, 12.84] },
    })),
  };
  nominatimResult = [];

  const res = mockRes();
  await searchPlaces(reqFor("true-dupe-test"), res);
  assert.equal(res.body.length, 1, "identical places are still deduped");
});

// ---- 11. Blending: Nominatim is actually represented ------------------------

test("Nominatim results are blended in, not buried behind a full Photon list", async () => {
  photonResult = photonPayload("P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8");
  nominatimResult = nominatimPayload("NomOnly1", "NomOnly2");

  const res = mockRes();
  await searchPlaces(reqFor("blend-test"), res);

  const names = res.body.map((s) => s.name);
  assert.equal(res.body.length, 8);
  assert.ok(names.includes("NomOnly1"), "the second source is represented even when Photon could fill every slot");
  assert.equal(names[0], "P1", "Photon still leads — it ranks autocomplete better");
});
