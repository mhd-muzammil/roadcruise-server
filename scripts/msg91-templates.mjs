#!/usr/bin/env node
/**
 * MSG91 template mapping — status report, credential check, and single-message
 * smoke test.
 *
 *   npm run msg91:templates                      # what each event will send
 *   npm run msg91:templates -- --json
 *   npm run msg91:templates -- --verify-key      # does the AuthKey authenticate?
 *   npm run msg91:templates -- --send-otp 9876543210 --code 482913
 *
 * The report is the fastest way to answer "why did that SMS not go out?" — it
 * shows, per event, the MSG91 template id in use, the ##variable## names this
 * code will send, and which notification context key feeds each one.
 *
 * --send-otp delivers ONE real SMS through the real provider (it costs money and
 * needs a live MSG91_API_KEY). Use it to confirm end-to-end delivery and, just
 * as importantly, that the variable NAMES match the MSG91 template: a name
 * mismatch still returns success but arrives with a blank where the code should
 * be. Read the SMS, don't just read the API response.
 */
import "dotenv/config";
import config from "../src/notifications/config/notification.config.js";
import { msg91TemplateStatus } from "../src/notifications/config/msg91Templates.js";
import { Msg91SmsProvider } from "../src/notifications/providers/sms/Msg91SmsProvider.js";
import { NotificationEvents } from "../src/notifications/config/events.js";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1] ?? "";
};

const BOLD = "\x1b[1m", DIM = "\x1b[2m", RESET = "\x1b[0m";
const GREEN = "\x1b[32m", YELLOW = "\x1b[33m", RED = "\x1b[31m";

const status = msg91TemplateStatus();

/**
 * Prove the AuthKey actually authenticates.
 *
 * This is NOT redundant with the send call. MSG91's `/api/v5/flow/` endpoint
 * answers `{"type":"success"}` even for a completely bogus auth key — verified
 * against this account on 2026-08-08 — so a send can report success and deliver
 * nothing at all. The delivery-report endpoint DOES authenticate, so it is used
 * here as the credential check before anyone concludes "MSG91 accepted it".
 */
async function verifyAuthKey() {
  if (!config.msg91.authKey) return { ok: false, status: 0, detail: "MSG91_API_KEY is not set" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.msg91.timeoutMs);
  try {
    const res = await fetch(`${config.msg91.baseUrl}/api/v5/report/logs/p/sms?limit=1`, {
      headers: { authkey: config.msg91.authKey, Accept: "application/json" },
      signal: controller.signal,
    });
    const body = await res.json().catch(() => ({}));
    return {
      ok: res.status === 200 && !body.hasError,
      status: res.status,
      detail: body.errors || body.message || "",
      sentCount: body?.metadata?.total,
    };
  } catch (err) {
    return { ok: false, status: 0, detail: `${err.name}: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}

function printReport() {
  console.log(`\n${BOLD}MSG91 TEMPLATE MAPPING${RESET}`);
  console.log(`${DIM}SMS provider:  ${config.providers.sms}`);
  console.log(`Auth key:      ${config.msg91.authKey ? "set" : "(unset — MSG91_API_KEY)"}`);
  console.log(`Sender/header: ${config.msg91.senderId || "(unset — MSG91_SENDER_ID)"}`);
  console.log(`DLT entity:    ${process.env.DLT_ENTITY_ID || "(unset — DLT_ENTITY_ID)"}${RESET}\n`);

  for (const t of status) {
    const state = t.blocked
      ? `${RED}BLOCKED${RESET}`
      : t.configured
        ? `${GREEN}CONFIGURED${RESET}`
        : `${YELLOW}NOT CONFIGURED${RESET}`;
    console.log(`${BOLD}${t.constName}${RESET}  ${DIM}(${t.event})${RESET}  ${state}`);
    console.log(`  ${DIM}msg91 template:${RESET} ${t.msg91Name}`);
    console.log(`  ${DIM}msg91 id:${RESET}       ${t.templateId || `(set ${t.idEnv})`}`);
    console.log(`  ${DIM}airtel dlt id:${RESET}  ${t.dltTemplateId} ${DIM}(cross-check only — never sent to MSG91)${RESET}`);
    console.log(`  ${DIM}variables sent (##name## <- context key):${RESET}`);
    if (!t.vars.length) console.log(`    ${DIM}(none resolved)${RESET}`);
    for (const v of t.vars) console.log(`    ##${v.name}## <- ${v.key}`);
    console.log(`  ${DIM}override with:${RESET} ${t.varsEnv}=${t.vars.map((v) => `${v.name}=${v.key}`).join(",")}`);
    if (!t.configured) console.log(`  ${RED}! "${t.event}" SMS will fail safe (dead-letter) until ${t.idEnv} is set${RESET}`);
    if (t.blocked) {
      console.log(`  ${RED}! BLOCKED — ${t.blockedReason}${RESET}`);
      console.log(`  ${DIM}  unblock by setting ${t.varsEnv} once the MSG91 template is fixed${RESET}`);
    }
    console.log("");
  }

  const pending = status.filter((t) => !t.configured);
  console.log(`${BOLD}${status.length - pending.length}/${status.length} approved templates configured.${RESET}`);
  if (pending.length) console.log(`${DIM}Pending: ${pending.map((t) => t.constName).join(", ")}${RESET}`);
  console.log(
    `${DIM}Variable names must match the MSG91 panel exactly — verify them there, or send one test message.${RESET}\n`
  );
}

async function sendOtp(to, code) {
  // Refuse to send on an unauthenticated key: the flow API's hollow success
  // would otherwise be reported back as a delivered message.
  const auth = await verifyAuthKey();
  if (!auth.ok) {
    console.error(`${RED}MSG91_API_KEY did not authenticate (HTTP ${auth.status}) ${auth.detail}${RESET}`);
    console.error(
      `${DIM}Not sending. /api/v5/flow/ answers "success" even for an invalid key, so the send\n` +
        `would look accepted and deliver nothing. Fix the credential first.${RESET}`
    );
    return 1;
  }
  const tpl = status.find((t) => t.event === NotificationEvents.OTP_REQUESTED);
  if (tpl?.blocked) {
    console.error(`${RED}OTP template mapping is UNRESOLVED — refusing to send.${RESET}`);
    console.error(`${DIM}${tpl.blockedReason}${RESET}`);
    console.error(`${DIM}Fix the template in MSG91, then set ${tpl.varsEnv} to its real ##names##.${RESET}`);
    return 1;
  }
  console.log(`${DIM}auth key verified — account has ${auth.sentCount ?? "?"} logged sends${RESET}`);
  console.log(`${YELLOW}Sending ONE real OTP SMS via MSG91 (this bills your account)...${RESET}`);
  try {
    // Exactly the path a real OTP_REQUESTED notification takes: the OTP is
    // supplied by the caller, never generated here.
    const res = await new Msg91SmsProvider().send({
      to,
      event: NotificationEvents.OTP_REQUESTED,
      context: { otp: code, companyName: config.branding.companyName },
      correlationId: "msg91-smoke-test",
    });
    console.log(`${GREEN}accepted by MSG91${RESET} requestId=${res.providerMessageId || "(none returned)"}`);
    if (!res.providerMessageId) {
      console.log(`${YELLOW}! MSG91 returned no request id — treat this send as unconfirmed.${RESET}`);
    }
    console.log(`${DIM}Now check the handset: the code in the SMS must read "${code}".`);
    console.log(`A blank where the code should be means the MSG91 template's variable`);
    console.log(`names differ from ours — fix with MSG91_OTP_VARS, no deploy needed.${RESET}`);
    return 0;
  } catch (err) {
    console.error(`${RED}send failed:${RESET} ${err.message}`);
    console.error(`${DIM}retryable=${err.retryable !== false} httpStatus=${err.statusCode ?? "-"}${RESET}`);
    return 1;
  }
}

// ------------------------------------------------------------------- dispatch
if (args.includes("--json")) {
  console.log(JSON.stringify(status, null, 2));
} else if (args.includes("--verify-key")) {
  const auth = await verifyAuthKey();
  console.log(
    auth.ok
      ? `${GREEN}MSG91_API_KEY authenticates${RESET} ${DIM}(account has ${auth.sentCount ?? "?"} logged sends)${RESET}`
      : `${RED}MSG91_API_KEY does NOT authenticate${RESET} (HTTP ${auth.status}) ${auth.detail}`
  );
  process.exitCode = auth.ok ? 0 : 1;
} else if (flag("--send-otp") !== null) {
  const to = flag("--send-otp");
  const code = flag("--code");
  if (!to || !code) {
    console.error(`${RED}usage: npm run msg91:templates -- --send-otp <phone> --code <otp>${RESET}`);
    process.exitCode = 1;
  } else {
    process.exitCode = await sendOtp(to, code);
  }
} else {
  printReport();
}
