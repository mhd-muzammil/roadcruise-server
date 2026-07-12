// Preloaded via --import (see the test:notifications script) BEFORE each test
// process loads any module, so repository/store.js resolves DATA_DIR to a
// fresh throwaway directory instead of the real src/notifications/data files.
// Without this, suite runs accumulate records in the live store and stale
// QUEUED/FAILED rows from earlier runs race the count-based assertions
// (repository/dispatcher tests) — the suite was intermittently flaky and
// polluted local data. Mirrors the auth suite's useTempDb() isolation.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (!process.env.DATA_DIR) {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "rc-notif-tests-"));
}
