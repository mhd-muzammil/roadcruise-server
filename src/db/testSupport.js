// Test-only helpers. Point the data layer at a throwaway temp SQLite file so
// suites never read or write the real config/roadcruise.db (or db.json), and
// provide seed helpers that go through the real data layer.
import fs from "fs";
import path from "path";
import os from "os";
import { getDb, __resetForTests } from "./sqlite.js";
import { readDb, writeDb } from "../utils/db.js";

let counter = 0;

/** Reset the connection to a fresh, empty temp database. Call in before(). */
export function useTempDb() {
  __resetForTests();
  const p = path.join(os.tmpdir(), `rc-test-${process.pid}-${counter++}-${Math.random().toString(36).slice(2)}.db`);
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(p + ext); } catch { /* not there */ }
  }
  process.env.SQLITE_PATH = p; // read lazily by getDb(); also skips legacy migration
  getDb(); // create schema on the fresh file
  return p;
}

/** Seed a raw user row through the real data layer. */
export function seedUser(user) {
  const db = readDb();
  db.users.push(user);
  writeDb(db);
}

/** Seed a raw booking row through the real data layer. */
export function seedBooking(booking) {
  const db = readDb();
  db.bookings.push(booking);
  writeDb(db);
}

/** Count users matching an email (case-insensitive), read fresh from the DB. */
export function countUsers(email) {
  return readDb().users.filter((u) => String(u.email).toLowerCase() === email.toLowerCase()).length;
}
