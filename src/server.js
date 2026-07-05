// Load .env BEFORE importing app.js. ES module imports are hoisted and fully
// evaluated before any statement in this file runs, so app.js (and the config
// modules it imports, which snapshot process.env at load time) must not be
// imported until process.env is populated. loadEnv.js is a side-effect import
// that loads server/.env by ABSOLUTE path — so it works regardless of the
// working directory the server is launched from (not just from server/).
import "./loadEnv.js";
import app from "./app.js";
import { getDb } from "./db/sqlite.js";
import { backupOnStartup } from "./db/backup.js";

const PORT = process.env.PORT || 5000;

// Initialize the database (creates schema + migrates legacy db.json on first
// run) and take a startup backup before accepting traffic.
getDb();
await backupOnStartup();

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
