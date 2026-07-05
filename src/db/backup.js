// Automatic database backups. Runs once on server startup: takes a consistent
// snapshot of the SQLite file into config/backups/ and prunes to the most
// recent N. SQLite's online backup API copies a live DB safely (no need to stop
// the server or worry about a half-written file).
import fs from "fs";
import path from "path";
import { getDb, dbFile, CONFIG_DIRECTORY } from "./sqlite.js";

const BACKUP_DIR = path.join(CONFIG_DIRECTORY, "backups");
const KEEP = Number(process.env.DB_BACKUP_KEEP || 10);

/** Take a timestamped snapshot and prune old ones. Never throws (best-effort). */
export async function backupOnStartup() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = path.join(BACKUP_DIR, `roadcruise-${stamp}.db`);

    const db = getDb();
    if (typeof db.backup === "function") {
      // Preferred: SQLite online backup (safe on a live DB).
      await db.backup(dest);
    } else {
      // Fallback: plain file copy (WAL checkpointed first for consistency).
      try { db.exec("PRAGMA wal_checkpoint(TRUNCATE);"); } catch { /* ignore */ }
      fs.copyFileSync(dbFile(), dest);
    }

    prune();
    console.log(`[db] backup written -> ${path.relative(process.cwd(), dest)}`);
  } catch (e) {
    console.warn("[db] startup backup failed (non-fatal):", e.message);
  }
}

function prune() {
  const files = fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith("roadcruise-") && f.endsWith(".db"))
    .sort(); // ISO timestamps sort chronologically
  const excess = files.length - KEEP;
  for (let i = 0; i < excess; i++) {
    try { fs.unlinkSync(path.join(BACKUP_DIR, files[i])); } catch { /* ignore */ }
  }
}

export default { backupOnStartup };
