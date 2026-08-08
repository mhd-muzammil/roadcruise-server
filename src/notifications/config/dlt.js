import { NotificationEvents } from "./events.js";
import { smsTemplates } from "../templates/sms/index.js";
import { helpers } from "../templates/engine.js";

/**
 * DLT (TRAI Distributed Ledger Technology) compliance layer for Indian SMS.
 *
 * Every commercial SMS sent in India must match a CONTENT TEMPLATE that was
 * pre-registered on a DLT portal (RoadCruise registered on Airtel's) and
 * approved by the operators. Each approved template gets a 19-digit Template ID
 * that has to travel with the send request; an unregistered — or merely
 * mismatched — body is dropped by the operator, silently, after we get a 200.
 *
 * This module is the single source of truth tying the three worlds together:
 *
 *   templates/sms/index.js   the {{handlebars}} body the engine renders
 *   the DLT portal           the {#var#} text a human registered + its ID
 *   the provider             ordered variable values on the wire
 *
 * Deriving the portal text FROM the code templates (see `registrationSheet`,
 * surfaced by `npm run dlt:templates`) is what keeps them from drifting: an
 * edit to an SMS template visibly changes the sheet, which is the signal that
 * the template must be re-registered before that edit can ship.
 *
 * GATEWAY-AGNOSTIC by design — DLT identifiers are issued by the operator
 * chain, not by whoever sends the message, so the same Entity ID + Template IDs
 * work through Airtel IQ, MSG91, or any other aggregator.
 */

/**
 * Placeholders that are CONSTANT for the business (they come from branding
 * config, not from the event) and are therefore baked into the registered
 * template as FIXED TEXT rather than registered as variables.
 *
 * This is not a micro-optimization — it is what gets templates approved.
 * Operator scrubbing rejects templates that are mostly variable, and caps
 * variable content at ~30 characters. "RoadCruise Car Rentals & Tours" is 30
 * characters on its own, so registering it as a variable would burn the entire
 * budget on a value that never changes. The brand is already asserted by the
 * approved Header (sender ID) anyway.
 */
export const FIXED_KEYS = Object.freeze([
  "companyName",
  "supportPhone",
  "supportEmail",
  "websiteUrl",
]);

/** DLT's placeholder token in a registered content template. */
const DLT_VAR = "{#var#}";

/** Operators cap a single variable's content; longer values risk a drop. */
export const MAX_VAR_LENGTH = 30;

const PLACEHOLDER_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

/** Resolve a template def (object or ctx-function) down to its SMS text. */
function textOf(def, ctx = {}) {
  const resolved = typeof def === "function" ? def(ctx) : def;
  return resolved?.text || resolved?.html || "";
}

/** Ordered placeholder names in a template, including fixed ones. */
function allPlaceholders(text) {
  return [...String(text).matchAll(PLACEHOLDER_RE)].map((m) => m[1]);
}

/**
 * Ordered names of the placeholders that become DLT VARIABLES — i.e. every
 * placeholder except the branding constants. Order is significant: it is the
 * order the operator matches values against {#var#} slots.
 */
export function varNames(text) {
  return allPlaceholders(text).filter((name) => !FIXED_KEYS.includes(name));
}

/**
 * Convert an engine template into the EXACT text to register on the DLT portal:
 * branding placeholders collapse to their literal values, everything else
 * becomes {#var#}.
 *
 * @param {string} text     raw {{handlebars}} template body
 * @param {object} branding config.branding (supplies the fixed literals)
 */
export function toDltText(text, branding = {}) {
  return String(text).replace(PLACEHOLDER_RE, (_, name) =>
    FIXED_KEYS.includes(name) ? String(branding[name] ?? "") : DLT_VAR
  );
}

/**
 * Ordered variable VALUES for one send, sanitized exactly as the engine
 * sanitizes the rendered body — so the values the operator matches are
 * character-for-character the ones inside the body we transmit.
 */
export function buildVars(text, ctx = {}) {
  return varNames(text).map((name) => {
    const v = name.split(".").reduce((acc, k) => (acc == null ? undefined : acc[k]), ctx);
    return v === undefined || v === null ? "" : helpers.textSanitize(v);
  });
}

/** Env var carrying the approved Template ID for an event, e.g. DLT_TID_BOOKING_CONFIRMED. */
export const envKeyFor = (eventConstName) => `DLT_TID_${eventConstName}`;

/** event string -> EVENT_CONST_NAME, for env lookups and the sheet. */
const EVENT_NAME_BY_VALUE = Object.freeze(
  Object.fromEntries(Object.entries(NotificationEvents).map(([k, v]) => [v, k]))
);

/**
 * Approved Template IDs, read from per-event env vars. Read lazily (a getter,
 * not a snapshot) so tests and runtime env edits are picked up, matching how
 * every real provider in this module reads its credentials.
 */
export const dlt = {
  /** 19-digit Principal Entity ID issued at DLT registration. */
  get entityId() {
    return process.env.DLT_ENTITY_ID || "";
  },
  /** Approved 6-char Header. Falls back to the gateway's own sender-id setting. */
  get headerId() {
    return process.env.DLT_HEADER_ID || "";
  },
  /** @returns {string} approved Template ID for an event, or "" if unregistered. */
  templateIdFor(event) {
    const name = EVENT_NAME_BY_VALUE[event];
    return (name && process.env[envKeyFor(name)]) || "";
  },
  /** True once at least one Template ID is configured (i.e. DLT mode is live). */
  get configured() {
    return Object.keys(EVENT_NAME_BY_VALUE).some((e) => !!this.templateIdFor(e));
  },
};

/**
 * Everything a human needs to register the SMS catalog on the DLT portal, and
 * everything the ops team needs to verify what is still unregistered.
 *
 * @returns {Array<{event, constName, envKey, templateId, registered, dltText, vars, warnings}>}
 */
export function registrationSheet(branding = {}) {
  return Object.entries(NotificationEvents)
    .filter(([, event]) => !!smsTemplates[event])
    .map(([constName, event]) => {
      const text = textOf(smsTemplates[event]);
      const dltText = toDltText(text, branding);
      const vars = varNames(text);
      const templateId = dlt.templateIdFor(event);

      const warnings = [];
      // A template whose text is ~entirely variable is the classic scrubbing
      // rejection; flag it while it can still be reworded.
      const fixedChars = dltText.split(DLT_VAR).join("").trim().length;
      if (vars.length && fixedChars < 20) {
        warnings.push("mostly-variable text — high risk of DLT scrubbing rejection");
      }
      if (dltText.length > 160) {
        warnings.push(`${dltText.length} chars — bills as multiple SMS segments`);
      }
      return {
        event,
        constName,
        envKey: envKeyFor(constName),
        templateId,
        registered: !!templateId,
        dltText,
        vars,
        warnings,
      };
    });
}

export default dlt;
