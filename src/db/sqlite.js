// Real database layer backed by Node's built-in SQLite (node:sqlite, Node >=22.5).
// Replaces the previous single-JSON-file store. Benefits over the old approach:
//   - Durable, transactional writes (no more whole-file rewrite / corruption).
//   - Concurrency-safe (SQLite file locking + WAL) even across multiple workers.
//   - Real backups (see backup.js) and room to grow.
//
// Data is stored one row per entity with a JSON `data` column plus a few
// indexed key columns. This keeps the flexible document shape the app already
// relies on (varying user/booking fields) while giving us atomic, targeted
// updates instead of rewriting everything on every change.
import { DatabaseSync } from "node:sqlite";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG_DIR = path.resolve(__dirname, "../config");
const LEGACY_JSON = path.join(CONFIG_DIR, "db.json");

// Resolved lazily (on first getDb) so SQLITE_PATH can be set by tests before the
// connection is opened. Defaults to config/roadcruise.db.
let db = null;
let dbPath = null;

/** Open (once) and initialize the database: schema + one-time migration. */
export function getDb() {
  if (db) return db;
  dbPath = process.env.SQLITE_PATH || path.join(CONFIG_DIR, "roadcruise.db");
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  db = new DatabaseSync(dbPath);
  // WAL = better concurrency (readers don't block the writer); NORMAL sync is
  // the standard durable-enough setting for WAL.
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      email      TEXT PRIMARY KEY,
      google_id  TEXT,
      data       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id);

    CREATE TABLE IF NOT EXISTS bookings (
      id             TEXT PRIMARY KEY,
      customer_email TEXT,
      status         TEXT,
      created_at     TEXT,
      data           TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bookings_email ON bookings(customer_email);
  `);

  migrateFromJsonIfNeeded();
  return db;
}

/** One-time seed from the legacy db.json (only if the DB is still empty). */
function migrateFromJsonIfNeeded() {
  // Only auto-migrate the legacy file when using the DEFAULT database location.
  // A custom SQLITE_PATH (tests, alternate instances) must not touch db.json.
  if (process.env.SQLITE_PATH) return;

  const count = db.prepare("SELECT COUNT(*) AS n FROM users").get().n
    + db.prepare("SELECT COUNT(*) AS n FROM bookings").get().n;
  if (count > 0) return; // already migrated / has data
  if (!fs.existsSync(LEGACY_JSON)) return;

  let legacy;
  try {
    legacy = JSON.parse(fs.readFileSync(LEGACY_JSON, "utf-8"));
  } catch (e) {
    console.error("[db] could not read legacy db.json for migration:", e.message);
    return;
  }

  transaction(() => {
    for (const u of legacy.users || []) upsertUserRow(u);
    for (const b of legacy.bookings || []) upsertBookingRow(b);
  });

  const migrated = { users: (legacy.users || []).length, bookings: (legacy.bookings || []).length };
  console.log(`[db] migrated legacy db.json -> SQLite (${migrated.users} users, ${migrated.bookings} bookings)`);
  // Keep the original as a .bak so nothing is lost, then step aside so it is
  // never read again.
  try {
    fs.renameSync(LEGACY_JSON, LEGACY_JSON + ".migrated.bak");
  } catch { /* non-fatal */ }
}

// ---- Low-level row upserts (assume an open db) --------------------------------

function upsertUserRow(u) {
  db.prepare(
    `INSERT INTO users (email, google_id, data) VALUES (?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET google_id = excluded.google_id, data = excluded.data`
  ).run(String(u.email), u.googleId || null, JSON.stringify(u));
}

function upsertBookingRow(b) {
  db.prepare(
    `INSERT INTO bookings (id, customer_email, status, created_at, data)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       customer_email = excluded.customer_email,
       status = excluded.status,
       created_at = excluded.created_at,
       data = excluded.data`
  ).run(
    String(b.id),
    b.customerEmail || null,
    b.status || null,
    b.createdAt || null,
    JSON.stringify(b)
  );
}

/**
 * Run `fn` inside a single SQLite transaction (node:sqlite has no transaction
 * helper, so we drive BEGIN/COMMIT/ROLLBACK by hand). Re-entrant: a nested call
 * just runs inline within the outer transaction. On any throw the whole
 * transaction is rolled back — so a write can never be left half-applied.
 */
let inTx = false;
export function transaction(fn) {
  const conn = getDb();
  if (inTx) return fn();
  inTx = true;
  conn.exec("BEGIN");
  try {
    const r = fn();
    conn.exec("COMMIT");
    return r;
  } catch (e) {
    try { conn.exec("ROLLBACK"); } catch { /* ignore */ }
    throw e;
  } finally {
    inTx = false;
  }
}

/** Absolute path of the currently-open database file (null before first open). */
export function dbFile() {
  return dbPath;
}

/**
 * TEST SUPPORT ONLY: close the connection and reset the singleton so the next
 * getDb() reopens (honoring a freshly-set SQLITE_PATH). Never call in production.
 */
export function __resetForTests() {
  try { db?.close(); } catch { /* ignore */ }
  db = null;
  dbPath = null;
  inTx = false;
}

export const CONFIG_DIRECTORY = CONFIG_DIR;
