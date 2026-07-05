// Data access layer. Backed by SQLite (see ../db/sqlite.js) instead of the old
// single JSON file. The legacy readDb()/writeDb() API is preserved verbatim so
// existing callers (auth userService, payment bookingBridge) keep working with
// zero changes — but underneath, every write is a durable, atomic SQLite
// transaction instead of a whole-file rewrite that could lose data or corrupt.
//
// New code (the booking controller) should prefer the targeted, atomic booking
// helpers below (insertBooking / patchBooking / removeBooking / listBookings)
// which touch a single row instead of rewriting the entire dataset.
import { getDb, transaction } from "../db/sqlite.js";

const parse = (row) => (row ? JSON.parse(row.data) : null);

// ---- Legacy whole-dataset API (backward compatible) ---------------------------

/** Read the entire dataset as { users, bookings } (legacy shape). */
export const readDb = () => {
  try {
    const db = getDb();
    const users = db.prepare("SELECT data FROM users").all().map(parse);
    const bookings = db
      .prepare("SELECT data FROM bookings ORDER BY rowid DESC")
      .all()
      .map(parse);
    return { users, bookings };
  } catch (error) {
    console.error("Error reading database:", error);
    return { users: [], bookings: [] };
  }
};

/**
 * Persist a whole { users, bookings } object (legacy semantics: the DB is made
 * to match exactly what is passed). Runs in a single transaction so it is
 * atomic — a crash mid-write can never leave a half-written dataset.
 */
export const writeDb = (data) => {
  try {
    const db = getDb();
    transaction(() => {
      // Users: upsert everything present, delete anything no longer present.
      const users = data.users || [];
      const keepEmails = new Set(users.map((u) => String(u.email)));
      for (const u of users) {
        db.prepare(
          `INSERT INTO users (email, google_id, data) VALUES (?, ?, ?)
           ON CONFLICT(email) DO UPDATE SET google_id = excluded.google_id, data = excluded.data`
        ).run(String(u.email), u.googleId || null, JSON.stringify(u));
      }
      for (const row of db.prepare("SELECT email FROM users").all()) {
        if (!keepEmails.has(String(row.email))) {
          db.prepare("DELETE FROM users WHERE email = ?").run(row.email);
        }
      }

      // Bookings: same upsert-and-reconcile.
      const bookings = data.bookings || [];
      const keepIds = new Set(bookings.map((b) => String(b.id)));
      for (const b of bookings) upsertBookingStmt(db, b);
      for (const row of db.prepare("SELECT id FROM bookings").all()) {
        if (!keepIds.has(String(row.id))) {
          db.prepare("DELETE FROM bookings WHERE id = ?").run(row.id);
        }
      }
    });
    return true;
  } catch (error) {
    console.error("Error writing database:", error);
    return false;
  }
};

// ---- Atomic booking helpers (preferred for new code) --------------------------

function upsertBookingStmt(db, b) {
  db.prepare(
    `INSERT INTO bookings (id, customer_email, status, created_at, data)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       customer_email = excluded.customer_email,
       status = excluded.status,
       created_at = excluded.created_at,
       data = excluded.data`
  ).run(String(b.id), b.customerEmail || null, b.status || null, b.createdAt || null, JSON.stringify(b));
}

/** Insert one booking. Returns the stored booking. */
export const insertBooking = (booking) => {
  const db = getDb();
  upsertBookingStmt(db, booking);
  return booking;
};

/** All bookings, newest first. */
export const listBookings = () => {
  const db = getDb();
  return db.prepare("SELECT data FROM bookings ORDER BY rowid DESC").all().map(parse);
};

/** Bookings belonging to one customer email, newest first. */
export const listBookingsByEmail = (email) => {
  const db = getDb();
  return db
    .prepare("SELECT data FROM bookings WHERE customer_email = ? ORDER BY rowid DESC")
    .all(String(email))
    .map(parse);
};

/** One booking by id, or null. */
export const getBookingById = (id) => {
  const db = getDb();
  return parse(db.prepare("SELECT data FROM bookings WHERE id = ?").get(String(id)));
};

/**
 * Atomically merge a patch into one booking. Read-modify-write happens inside a
 * single SQLite transaction, so concurrent updates can't clobber each other.
 * Returns { booking, changed, prev } — prev is the pre-patch snapshot.
 */
export const patchBooking = (id, patch = {}) => {
  const db = getDb();
  let result = { booking: null, changed: false, prev: null };
  transaction(() => {
    const prev = getBookingById(id);
    if (!prev) return;
    const updated = { ...prev, ...patch };
    upsertBookingStmt(db, updated);
    result = { booking: updated, changed: true, prev };
  });
  return result;
};

/** Delete one booking. Returns true if a row was removed. */
export const removeBooking = (id) => {
  const db = getDb();
  const info = db.prepare("DELETE FROM bookings WHERE id = ?").run(String(id));
  return info.changes > 0;
};
