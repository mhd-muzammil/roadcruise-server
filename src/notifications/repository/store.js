import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/**
 * Tiny atomic JSON store, mirroring the existing utils/db.js pattern so the
 * module is consistent with the current codebase — but with two upgrades that
 * matter for a write-heavy audit log:
 *   1. Atomic writes (temp file + rename) so a crash mid-write never corrupts.
 *   2. A per-file serialized write chain to avoid lost updates under the
 *      concurrent in-process worker.
 *
 * This is the default zero-infra persistence. The Repository interface lets a
 * Postgres adapter replace it later with no engine changes.
 */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, "../data");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const writeChains = new Map(); // file -> Promise (serializes writes per file)
let writeSeq = 0; // makes temp filenames unique across concurrent writers

export class JsonStore {
  // baseDir defaults to the notifications data dir; other modules (e.g. payments)
  // may pass their own directory to keep their data files separate. Additive —
  // existing callers that omit baseDir are unaffected.
  constructor(filename, seed = {}, baseDir = DATA_DIR) {
    if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
    this.file = path.join(baseDir, filename);
    if (!fs.existsSync(this.file)) {
      fs.writeFileSync(this.file, JSON.stringify(seed, null, 2), "utf-8");
    }
  }

  read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf-8"));
    } catch (err) {
      console.error(`[notifications] store read failed (${this.file}):`, err.message);
      throw err; // surface, do NOT silently mask data
    }
  }

  /**
   * Serialized read-modify-write. `mutator(data)` mutates and returns a result;
   * the (possibly mutated) data object is persisted atomically.
   * @returns {Promise<*>} whatever the mutator returns
   */
  async update(mutator) {
    const prev = writeChains.get(this.file) || Promise.resolve();
    let release;
    const next = new Promise((res) => (release = res));
    writeChains.set(this.file, prev.then(() => next));
    await prev;
    try {
      const data = this.read();
      const result = mutator(data);
      const json = JSON.stringify(data, null, 2);
      const tmp = `${this.file}.${process.pid}.${++writeSeq}.tmp`;
      fs.writeFileSync(tmp, json, "utf-8");
      try {
        fs.renameSync(tmp, this.file); // atomic on same volume
      } catch (e) {
        // Windows can transiently EPERM/EBUSY on rename-over-existing when
        // another process holds a handle. Fall back to a direct write so the
        // update is never lost (trades atomicity for durability in that rare race).
        if (["EPERM", "EBUSY", "EEXIST"].includes(e.code)) {
          fs.writeFileSync(this.file, json, "utf-8");
          try { fs.unlinkSync(tmp); } catch { /* best effort */ }
        } else {
          try { fs.unlinkSync(tmp); } catch { /* best effort */ }
          throw e;
        }
      }
      return result;
    } finally {
      release();
      if (writeChains.get(this.file) === next) writeChains.delete(this.file);
    }
  }
}

export default JsonStore;
