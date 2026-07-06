import path from "path";

/**
 * Single root for ALL persistent data — the SQLite DB, its backups, and every
 * JSON store (notifications / payments / auth). Set the DATA_DIR env var to an
 * absolute path on DURABLE storage (e.g. a mounted Docker/Dokploy volume) so
 * data survives container rebuilds & redeploys. When DATA_DIR is unset, each
 * store falls back to its original in-repo path, so local development and the
 * test suite behave exactly as before.
 */
const ROOT = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : null;

/**
 * Resolve a module's persistent data directory.
 * @param {string} name         subfolder under DATA_DIR (e.g. "payments")
 * @param {string} fallbackDir  in-repo path used when DATA_DIR is not set
 * @returns {string} absolute directory path
 */
export function dataDir(name, fallbackDir) {
  return ROOT ? path.join(ROOT, name) : fallbackDir;
}

export const DATA_ROOT = ROOT;
export default dataDir;
