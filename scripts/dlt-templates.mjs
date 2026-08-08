#!/usr/bin/env node
/**
 * Prints the DLT CONTENT TEMPLATE registration sheet — the exact text to paste
 * into the Airtel DLT portal, one entry per SMS event, derived from the live
 * templates in src/notifications/templates/sms/index.js.
 *
 *   npm run dlt:templates          # human-readable sheet + registration status
 *   npm run dlt:templates -- --env # .env block to fill in with approved IDs
 *   npm run dlt:templates -- --json
 *
 * Run this again after ANY edit to an SMS template: the registered text must
 * match what we transmit character-for-character, so a changed template means
 * re-registering it before that change can ship.
 */
import "dotenv/config";
import config from "../src/notifications/config/notification.config.js";
import { registrationSheet, MAX_VAR_LENGTH } from "../src/notifications/config/dlt.js";

const args = process.argv.slice(2);
const sheet = registrationSheet(config.branding);

if (args.includes("--json")) {
  console.log(JSON.stringify(sheet, null, 2));
  process.exit(0);
}

if (args.includes("--env")) {
  console.log("# DLT template ids — paste into server/.env and fill in the 19-digit");
  console.log("# ids the Airtel DLT portal issues once each template is APPROVED.");
  console.log(`DLT_ENTITY_ID=${process.env.DLT_ENTITY_ID || ""}`);
  console.log(`DLT_HEADER_ID=${process.env.DLT_HEADER_ID || ""}`);
  for (const t of sheet) console.log(`${t.envKey}=${t.templateId}`);
  process.exit(0);
}

const BOLD = "\x1b[1m", DIM = "\x1b[2m", RESET = "\x1b[0m";
const GREEN = "\x1b[32m", YELLOW = "\x1b[33m", RED = "\x1b[31m";

console.log(`\n${BOLD}DLT CONTENT TEMPLATE REGISTRATION SHEET${RESET}`);
console.log(`${DIM}Header (sender id): ${process.env.DLT_HEADER_ID || "(unset — DLT_HEADER_ID)"}`);
console.log(`Entity ID: ${process.env.DLT_ENTITY_ID || "(unset — DLT_ENTITY_ID)"}`);
console.log(`Brand text baked in as FIXED: "${config.branding.companyName}" / "${config.branding.supportPhone}"${RESET}\n`);

for (const t of sheet) {
  const status = t.registered ? `${GREEN}REGISTERED${RESET}` : `${YELLOW}NOT REGISTERED${RESET}`;
  console.log(`${BOLD}${t.constName}${RESET}  ${DIM}(${t.event})${RESET}  ${status}`);
  // Service Implicit = service/transactional messages to your own customers, no
  // separate consent needed. The "Transactional" category is reserved for
  // OTP from banks/financial institutions and must NOT be used here — including
  // for our own OTP templates.
  console.log(`  ${DIM}template type:${RESET} Service Implicit`);
  console.log(`  ${DIM}paste this as the template content:${RESET}`);
  console.log(`  ${BOLD}${t.dltText}${RESET}`);
  console.log(`  ${DIM}variables (${t.vars.length}), in this exact order:${RESET} ${t.vars.join(", ") || "(none)"}`);
  console.log(`  ${DIM}then set:${RESET} ${t.envKey}=<19-digit id>`);
  for (const w of t.warnings) console.log(`  ${RED}! ${w}${RESET}`);
  console.log("");
}

const missing = sheet.filter((t) => !t.registered);
console.log(`${BOLD}${sheet.length - missing.length}/${sheet.length} templates have an approved id configured.${RESET}`);
if (missing.length) {
  console.log(`${YELLOW}Unregistered events will FAIL to the dead-letter queue rather than send.${RESET}`);
  console.log(`${DIM}Missing: ${missing.map((t) => t.constName).join(", ")}${RESET}`);
}
console.log(`${DIM}Reminder: operators cap each variable at ~${MAX_VAR_LENGTH} chars.${RESET}\n`);
