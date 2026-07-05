// Loads server/.env by an ABSOLUTE path (relative to THIS file), so it works no
// matter which working directory the process is launched from (repo root, an IDE
// run-config, a process manager, nodemon, etc.). `import "dotenv/config"` alone
// resolves .env from process.cwd(), which silently fails when the server is not
// started from the server/ directory — the cause of GOOGLE_CLIENT_ID being null.
//
// This is a side-effect import: server.js imports it FIRST, so its body runs
// (populating process.env) before app.js and the config modules are evaluated.
import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, "../.env") }); // -> server/.env, cwd-independent
