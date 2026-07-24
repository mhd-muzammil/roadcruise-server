// Preloaded via --import (see test:bookings) BEFORE any module loads, so the
// shared SQLite layer (sqlite.js) resolves to a fresh throwaway database file
// instead of the real config/roadcruise.db. Mirrors the notifications suite's
// isolation. DATA_DIR is redirected too so nothing touches live data/config.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rc-booking-tests-"));
if (!process.env.SQLITE_PATH) process.env.SQLITE_PATH = path.join(tmp, "test.db");
if (!process.env.DATA_DIR) process.env.DATA_DIR = tmp;
// Give the notification engine an admin inbox so the admin-alert fan-out is
// exercised (mirrors ADMIN_EMAIL in production). Without it, admin channels
// resolve to null and are skipped, hiding the admin-cancellation path.
if (!process.env.ADMIN_EMAIL) process.env.ADMIN_EMAIL = "admin@test.local";
// Keep payments off the online path — irrelevant to cancellation, avoids any
// gateway config being required at import time.
process.env.PAYMENT_PROVIDER = process.env.PAYMENT_PROVIDER || "mock";
