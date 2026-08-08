import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Secret-hygiene guards for the MSG91 integration.
 *
 * The MSG91 AuthKey grants send rights on the whole account. Anything bundled
 * into the React app is public, so a credential must never be reachable from
 * the client — not via a VITE_/REACT_APP_ env name (Vite inlines those into the
 * bundle) and not by being committed anywhere. These are cheap, permanent
 * checks; the failure they prevent is unrecoverable (a leaked key must be
 * rotated and any spend refunded).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(HERE, "../../..");
const REPO_ROOT = path.resolve(SERVER_ROOT, "..");

/** Files that legitimately mention MSG91 env names. */
const ENV_EXAMPLES = [".env.example", ".env.production.example"]
  .map((f) => path.join(SERVER_ROOT, f))
  .filter((f) => fs.existsSync(f));

/** Recursively collect source files under a directory (bounded, no node_modules). */
function collect(dir, exts, out = [], depth = 0) {
  if (depth > 8 || !fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, exts, out, depth + 1);
    else if (exts.some((e) => entry.name.endsWith(e))) out.push(full);
  }
  return out;
}

test("no MSG91 credential is exposed under a client-bundled env prefix", () => {
  for (const file of ENV_EXAMPLES) {
    const text = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(
      text,
      /^\s*(VITE_|REACT_APP_|NEXT_PUBLIC_)\w*MSG91/im,
      `${path.basename(file)} must not expose MSG91 config to the frontend bundle`
    );
  }
});

test("env examples ship placeholders only — never a real MSG91 auth key", () => {
  // A real MSG91 auth key is a long unbroken alphanumeric run. Every legitimate
  // placeholder form in this repo (blank, «CHANGEME…», <FILL: …>) contains
  // punctuation or spaces, so this catches a pasted credential without
  // false-flagging documentation.
  const LOOKS_LIKE_A_SECRET = /^[A-Za-z0-9]{16,}$/;
  for (const file of ENV_EXAMPLES) {
    const text = fs.readFileSync(file, "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!/^\s*MSG91_API_KEY\s*=/.test(line)) continue;
      const value = line.split("=").slice(1).join("=").split("#")[0].trim();
      assert.ok(
        !LOOKS_LIKE_A_SECRET.test(value),
        `${path.basename(file)}: MSG91_API_KEY looks like a real key — env examples must ship placeholders only`
      );
    }
  }
});

test("the React client contains no MSG91 credential reference", (t) => {
  // The client lives in a sibling repo; skip cleanly when it isn't checked out
  // next to the server (CI builds the two independently).
  const clientSrc = path.join(REPO_ROOT, "client", "src");
  if (!fs.existsSync(clientSrc)) return t.skip("client/src not present in this checkout");

  const offenders = [];
  for (const file of collect(clientSrc, [".js", ".jsx", ".ts", ".tsx", ".env", ".json"])) {
    const text = fs.readFileSync(file, "utf8");
    if (/msg91|MSG91_API_KEY|authkey\s*[:=]/i.test(text)) offenders.push(path.relative(REPO_ROOT, file));
  }
  assert.deepEqual(offenders, [], "MSG91 must be server-side only");
});

test("the provider never puts the auth key anywhere but the request header", async () => {
  const src = fs.readFileSync(
    path.join(SERVER_ROOT, "src/notifications/providers/sms/Msg91SmsProvider.js"),
    "utf8"
  );
  // authKey may be read from config, checked for presence, and set as a header.
  // It must never be interpolated into a log line, an error, or the URL.
  for (const line of src.split(/\r?\n/)) {
    if (!/authKey/.test(line)) continue;
    assert.ok(
      !/console\.|throw |Error\(|`.*\$\{.*authKey/.test(line),
      `auth key must not appear in a log, error, or template string: ${line.trim()}`
    );
  }
});
