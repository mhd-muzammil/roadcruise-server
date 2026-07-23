// Vehicles data layer. Follows the reviews.db.js pattern: schema is created
// locally (CREATE TABLE IF NOT EXISTS on every access) so sqlite.js stays shared
// and untouched, and test suites that swap SQLITE_PATH to a fresh temp DB always
// get the table re-created + seeded on demand.
//
// A vehicle keeps a flexible document shape (varying pricing fields, image/video
// arrays) so we use the JSON `data` column pattern (like users/bookings) plus a
// couple of indexed columns for cheap filtering/ordering.
import { randomUUID } from "crypto";
import { getDb } from "./sqlite.js";

// The fleet previously hard-coded in client/src/components/Fleet.jsx. Seeded once
// (only when the table is empty) so the Vehicles page is never blank on a fresh
// install and the admin can immediately edit/replace them. innova-crysta shipped
// a bundled webp asset rather than a URL, so its images start empty and the
// client falls back to that bundled asset until the admin uploads a real photo.
const SEED_VEHICLES = [
  {
    id: "sedan", name: "Sedan (Dzire, Aura, Amaze)", category: "Sedans", seats: "4+1",
    outstationRate: 14, driverBata: 500,
    localPricing: { fourHours: 1250, eightHours: 2300, twelveHours: 3200, extraKm: 20, extraHr: 220 },
    images: ["https://i.pinimg.com/736x/8e/64/cc/8e64cc674cf764b5275adbb274d04698.jpg"],
  },
  {
    id: "suv-any", name: "Any SUV (Ertiga, Marazzo, Kia Carens)", category: "SUVs", seats: "6+1",
    outstationRate: 18, driverBata: 500,
    localPricing: { fourHours: 1500, eightHours: 3300, twelveHours: 4700, extraKm: 30, extraHr: 330 },
    images: ["https://i.pinimg.com/736x/ff/a4/7c/ffa47cd2acadeae55de83aaa4ac5e127.jpg"],
  },
  {
    id: "kia-carens", name: "Kia Carens", category: "SUVs", seats: "6+1",
    outstationRate: 20, driverBata: 600,
    localPricing: { fourHours: 1600, eightHours: 3500, twelveHours: 4900, extraKm: 33, extraHr: 350 },
    images: ["https://i.pinimg.com/736x/c7/1a/dd/c71add24f15c9afa2208057e15cb8872.jpg"],
  },
  {
    id: "innova-crysta", name: "Innova Crysta", category: "SUVs", seats: "7+1",
    outstationRate: 22, driverBata: 600,
    localPricing: { fourHours: 2000, eightHours: 4000, twelveHours: 5900, extraKm: 33, extraHr: 450 },
    images: [], // bundled client asset fallback (id === "innova-crysta")
  },
  {
    id: "innova-hycross", name: "Innova Hycross", category: "SUVs", seats: "6+1 OR 7+1",
    outstationRate: 24, driverBata: 700,
    localPricing: { fourHours: 2200, eightHours: 4400, twelveHours: 6500, extraKm: 35, extraHr: 500 },
    images: ["https://i.pinimg.com/736x/f7/ed/ca/f7edca42deefeeeea0db247dcf0f6669.jpg"],
  },
  {
    id: "urbania", name: "Urbania 12+1", category: "Tempo Travellers", seats: "12+1",
    outstationRate: 35, driverBata: 1000,
    localPricing: { fourHours: 5000, eightHours: 10000, twelveHours: 14000, extraKm: 45, extraHr: 1000 },
    images: ["https://i.pinimg.com/736x/bf/15/ec/bf15ec742c2440c20ad5100b11fa260c.jpg"],
  },
  {
    id: "tt-12", name: "Tempo Traveller 12 A/C", category: "Tempo Travellers", seats: "12+1",
    outstationRate: 24, driverBata: 800,
    localPricing: { fourHours: 3000, eightHours: 6000, twelveHours: 8500, extraKm: 35, extraHr: 600 },
    images: ["https://i.pinimg.com/736x/30/1d/4a/301d4abe73a0f1696cb52aca1f9d971d.jpg"],
  },
  {
    id: "tt-18", name: "Tempo Traveller 18 A/C", category: "Tempo Travellers", seats: "18+1",
    outstationRate: 26, driverBata: 900,
    localPricing: { fourHours: 3500, eightHours: 7000, twelveHours: 9900, extraKm: 35, extraHr: 700 },
    images: ["https://i.pinimg.com/736x/7b/51/ec/7b51eccb7d78865b277dcdcf0c4c2260.jpg"],
  },
  {
    id: "minibus-21", name: "Mini Bus 21 Seater", category: "Mini Buses", seats: "21+1",
    outstationRate: 30, driverBata: 1000,
    localPricing: { fourHours: 5000, eightHours: 9000, twelveHours: 12200, extraKm: 40, extraHr: 800 },
    images: ["https://i.pinimg.com/736x/22/49/f8/2249f882da27004c2d6bc07085ea6349.jpg"],
  },
  {
    id: "minibus-32", name: "Mini Bus 32 Seater", category: "Mini Buses", seats: "32+1",
    outstationRate: 50, driverBata: 1200,
    localPricing: { fourHours: 8000, eightHours: 12000, twelveHours: 18000, extraKm: 50, extraHr: 1500 },
    images: ["https://i.pinimg.com/736x/5a/2c/24/5a2c24f96ef56e633fec7fc21aff079f.jpg"],
  },
];

/** Open the DB, ensure the vehicles table exists, and seed it when empty. */
function ensure() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS vehicles (
      id       TEXT PRIMARY KEY,
      category TEXT,
      active   INTEGER NOT NULL DEFAULT 1,
      data     TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_vehicles_active ON vehicles(active);
  `);

  const { n } = db.prepare("SELECT COUNT(*) AS n FROM vehicles").get();
  if (n === 0) {
    const now = new Date().toISOString();
    for (const v of SEED_VEHICLES) {
      const data = {
        name: v.name,
        category: v.category,
        seats: v.seats,
        outstationRate: v.outstationRate,
        driverBata: v.driverBata,
        localPricing: v.localPricing,
        totalUnits: 1,
        images: v.images || [],
        videos: [],
        description: "",
        createdAt: now,
      };
      upsertRow(db, { id: v.id, category: v.category, active: 1, data });
    }
  }
  return db;
}

function upsertRow(db, { id, category, active, data }) {
  db.prepare(
    `INSERT INTO vehicles (id, category, active, data) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET category = excluded.category, active = excluded.active, data = excluded.data`
  ).run(String(id), category || null, active ? 1 : 0, JSON.stringify(data));
}

/** Row -> public vehicle object ({ id, active, ...data }). */
const toPublic = (row) => {
  if (!row) return null;
  const data = JSON.parse(row.data);
  return { id: row.id, active: !!row.active, ...data };
};

/** All vehicles in insertion order (seed order, then newest additions). */
export function listVehicles({ includeInactive = false } = {}) {
  const db = ensure();
  const rows = includeInactive
    ? db.prepare("SELECT * FROM vehicles ORDER BY rowid ASC").all()
    : db.prepare("SELECT * FROM vehicles WHERE active = 1 ORDER BY rowid ASC").all();
  return rows.map(toPublic);
}

/** One vehicle by id, or null. */
export function getVehicle(id) {
  const db = ensure();
  return toPublic(db.prepare("SELECT * FROM vehicles WHERE id = ?").get(String(id)));
}

/** Create a vehicle. Generates an id when not supplied. Returns the stored vehicle. */
export function insertVehicle(input = {}) {
  const db = ensure();
  const id = input.id ? String(input.id) : `veh-${randomUUID().slice(0, 8)}`;
  const data = {
    name: input.name || "Untitled vehicle",
    category: input.category || "Other",
    seats: input.seats || "",
    outstationRate: Number(input.outstationRate) || 0,
    driverBata: Number(input.driverBata) || 0,
    localPricing: input.localPricing || { fourHours: 0, eightHours: 0, twelveHours: 0, extraKm: 0, extraHr: 0 },
    totalUnits: Math.max(1, parseInt(input.totalUnits, 10) || 1),
    images: Array.isArray(input.images) ? input.images : [],
    videos: Array.isArray(input.videos) ? input.videos : [],
    description: input.description || "",
    createdAt: new Date().toISOString(),
  };
  upsertRow(db, { id, category: data.category, active: 1, data });
  return getVehicle(id);
}

/** Merge a patch into a vehicle's data. Returns the updated vehicle or null. */
export function updateVehicle(id, patch = {}) {
  const db = ensure();
  const existing = getVehicle(id);
  if (!existing) return null;
  const { id: _ignore, active, ...rest } = existing;
  const next = { ...rest, ...patch };
  if (patch.totalUnits !== undefined) next.totalUnits = Math.max(1, parseInt(patch.totalUnits, 10) || 1);
  const nextActive = patch.active === undefined ? (active ? 1 : 0) : patch.active ? 1 : 0;
  upsertRow(db, { id, category: next.category, active: nextActive, data: next });
  return getVehicle(id);
}

/** Delete a vehicle. Returns true if a row was removed. */
export function deleteVehicle(id) {
  const db = ensure();
  const info = db.prepare("DELETE FROM vehicles WHERE id = ?").run(String(id));
  return info.changes > 0;
}

export default { listVehicles, getVehicle, insertVehicle, updateVehicle, deleteVehicle };
