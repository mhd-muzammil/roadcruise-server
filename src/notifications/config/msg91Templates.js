import { NotificationEvents } from "./events.js";
import { helpers } from "../templates/engine.js";

/**
 * MSG91 <-> Airtel DLT template mapping — the single source of truth for which
 * approved template each notification event sends through.
 *
 * WHY THIS EXISTS (and why it is separate from config/dlt.js):
 *
 * There are TWO different template identifiers in play and they are not
 * interchangeable:
 *
 *   Airtel DLT Template ID   19 digits, e.g. 1077512810022246340
 *                            Issued by the DLT portal. Travels on the wire ONLY
 *                            for gateways that submit the rendered body and let
 *                            the operator match it (Airtel IQ). Lives in
 *                            config/dlt.js as DLT_TID_<EVENT>.
 *
 *   MSG91 Template ID        24-char hex, e.g. 6a7359294976ac1599096612
 *                            Issued by MSG91 when the approved DLT content is
 *                            registered in their panel. This is what the v5
 *                            Flow API's `template_id` field expects. Lives here.
 *
 * Sending the DLT id to MSG91 (or vice-versa) is rejected outright, so the two
 * registries are kept deliberately distinct.
 *
 * HOW A MESSAGE IS SENT: for Indian DLT traffic we do NOT transmit message text.
 * MSG91 holds the approved content; we send the template id plus the VALUES for
 * its variables, and MSG91 renders the DLT-approved body. That is what keeps the
 * transmitted content byte-identical to what the operator approved — an
 * unapproved body is accepted with a 200 and then dropped silently.
 *
 * VARIABLE NAMES ARE CONFIGURATION, NOT CODE. MSG91 templates use ##name##
 * placeholders and the names are whatever the person who registered the template
 * typed into the MSG91 panel. The defaults below are derived from the approved
 * DLT content and this repo's own SMS templates, but they MUST be verified
 * against the MSG91 dashboard — `npm run msg91:templates` prints exactly what
 * this code will send. Any mismatch is fixed without a deploy by setting the
 * per-event override env var, e.g.
 *
 *   MSG91_OTP_VARS="otp=otp,company=companyName"
 *
 * read as `<msg91 variable name>=<notification context key>`, in template order.
 *
 * ADDING A TEMPLATE: add one entry here + its env vars. No provider, dispatcher
 * or workflow change is needed — that is the whole point of the mapping layer.
 */

/**
 * event -> approved template descriptor.
 *
 *   idEnv         env var carrying the MSG91 (not DLT) template id
 *   varsEnv       env var overriding the variable mapping
 *   msg91Name     template name as it appears in the MSG91 panel
 *   dltTemplateId Airtel DLT template id, for cross-checking the panel entry.
 *                 NEVER sent to MSG91 — recorded so an operator can confirm the
 *                 MSG91 template is backed by the right DLT registration.
 *   defaultVars   ordered [{ name, key }]: MSG91 ##name## <- context[key]
 */
const TEMPLATES = Object.freeze({
  [NotificationEvents.OTP_REQUESTED]: Object.freeze({
    constName: "OTP_REQUESTED",
    msg91Name: "OTP_VERIFICATION",
    idEnv: "MSG91_OTP_TEMPLATE_ID",
    varsEnv: "MSG91_OTP_VARS",
    dltTemplateId: "1077512810022246340",
    // VERIFIED BY DLT. The template content in the MSG91 panel is, verbatim:
    //
    //   ##alphanumeric## is your One-Time Password (OTP) ##numeric##to verify
    //   your account with RoadCruise. Valid for 5 minutes. Do not share this
    //   code with anyone. - ##alphanumeric##
    //
    // So the placeholder NAMES are `alphanumeric` and `numeric` — they are the
    // DLT variable TYPES that MSG91 carried over on import, not descriptions of
    // what the values mean. Two facts follow, and neither is ours to "fix"
    // here: the template must not be edited, and this code must not invent
    // meanings for its slots.
    //
    //   1. `##alphanumeric##` appears TWICE under the SAME name, so MSG91
    //      substitutes ONE value into both the leading code position and the
    //      trailing signature. Sending the OTP therefore also renders it after
    //      the closing "- ". That is a property of the approved template.
    //   2. `##numeric##` has no determinable meaning from the content (it sits
    //      flush against "to verify", suggesting a filler slot). It is left
    //      unmapped: `otpNumeric` is not part of defaultContext, so it resolves
    //      to "" unless a caller explicitly supplies it. Nothing is guessed.
    //
    // CONSEQUENCE: no assignment of these slots renders a correct OTP message.
    //   alphanumeric=OTP, numeric=""     -> reads right, but the signature
    //                                       becomes the OTP and numeric is empty
    //   alphanumeric=OTP, numeric=OTP    -> the code appears three times
    //   alphanumeric=brand, numeric=OTP  -> "RoadCruise is your One-Time
    //                                       Password (OTP) 739104to verify…"
    //
    // So this event is BLOCKED rather than shipped with a wrong mapping: an
    // empty defaultVars plus `unresolved` makes every OTP send fail safe with
    // the reason below, exactly like an unconfigured template id. Booking and
    // reminder are unaffected.
    //
    // TO UNBLOCK, no deploy required: fix the template in the MSG91 panel so it
    // matches the DLT-approved text with two DISTINCTLY named variables, then
    // set the real names, e.g.
    //     MSG91_OTP_VARS=otp=otp,company=companyName
    // Supplying MSG91_OTP_VARS is itself the signal that the mapping has been
    // resolved, so the block lifts automatically.
    unresolved:
      "the MSG91 OTP template declares ##alphanumeric## twice under one name and an " +
      "##numeric## slot mid-sentence, so no variable mapping renders a correct message — " +
      "fix the template in MSG91, then set MSG91_OTP_VARS to its real ##names##",
    defaultVars: Object.freeze([]),
  }),

  [NotificationEvents.TRIP_REMINDER]: Object.freeze({
    constName: "TRIP_REMINDER",
    msg91Name: "REMINDER_BEFORE_RIDE",
    idEnv: "MSG91_REMINDER_TEMPLATE_ID",
    varsEnv: "MSG91_REMINDER_VARS",
    dltTemplateId: "1077340200023002579",
    // Derived from this repo's TRIP_REMINDER SMS template, in placeholder order
    // (branding is fixed text inside the registered template — see dlt.js).
    // VERIFY against the MSG91 panel; override with MSG91_REMINDER_VARS.
    defaultVars: Object.freeze([
      Object.freeze({ name: "bookingId", key: "bookingId" }),
      Object.freeze({ name: "tripDate", key: "tripDate" }),
      Object.freeze({ name: "vehicle", key: "vehicle" }),
      Object.freeze({ name: "pickup", key: "pickup" }),
      Object.freeze({ name: "driver", key: "driver" }),
    ]),
  }),

  [NotificationEvents.BOOKING_CONFIRMED]: Object.freeze({
    constName: "BOOKING_CONFIRMED",
    msg91Name: "BOOKING_CONFIRMATION",
    idEnv: "MSG91_BOOKING_TEMPLATE_ID",
    varsEnv: "MSG91_BOOKING_VARS",
    dltTemplateId: "1077397880030911933",
    // APPROVED ON AIRTEL DLT, NOT YET CREATED IN MSG91. Until the MSG91 panel
    // issues an id and marks it "Verified by DLT", MSG91_BOOKING_TEMPLATE_ID
    // stays empty and booking SMS fails safe instead of sending unapproved text.
    defaultVars: Object.freeze([
      Object.freeze({ name: "bookingId", key: "bookingId" }),
      Object.freeze({ name: "vehicle", key: "vehicle" }),
      Object.freeze({ name: "tripDate", key: "tripDate" }),
      Object.freeze({ name: "driver", key: "driver" }),
      Object.freeze({ name: "paymentAmount", key: "paymentAmount" }),
    ]),
  }),
});

/**
 * Parse a `MSG91_*_VARS` override: "otp=otp,company=companyName".
 * A bare "otp" is shorthand for "otp=otp". Order is significant.
 */
export function parseVarMap(spec) {
  return String(spec || "")
    .split(",")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const [name, key] = pair.split("=").map((s) => s.trim());
      return { name, key: key || name };
    })
    .filter((slot) => slot.name && slot.key);
}

/**
 * Resolve the approved template for an event. Env is read LAZILY (never
 * snapshotted at import) so the module loads with zero MSG91 config and tests
 * can flip env between cases — matching config/dlt.js and every real provider.
 *
 * A template carrying `unresolved` is BLOCKED — its variable mapping is known
 * to be wrong and sending would put a malformed message on the wire. Setting
 * its MSG91_*_VARS override supplies a resolved mapping and lifts the block.
 *
 * @returns {null|{event, constName, msg91Name, idEnv, varsEnv, dltTemplateId,
 *                 templateId: string, configured: boolean, blocked: boolean,
 *                 blockedReason: string, vars: Array<{name,key}>}}
 *          null when the event has no approved template at all.
 */
export function msg91TemplateFor(event) {
  const def = TEMPLATES[event];
  if (!def) return null;
  const override = parseVarMap(process.env[def.varsEnv]);
  const templateId = String(process.env[def.idEnv] || "").trim();
  return {
    ...def,
    event,
    templateId,
    configured: !!templateId,
    blocked: !!def.unresolved && !override.length,
    blockedReason: def.unresolved || "",
    vars: override.length ? override : def.defaultVars,
  };
}

/**
 * Build the MSG91 recipient variables for one send: `{ [##name##]: value }`.
 * Values are sanitized exactly as the template engine sanitizes rendered text,
 * so what MSG91 renders matches what the DLT template was approved with.
 */
export function buildMsg91Variables(vars = [], ctx = {}) {
  const out = {};
  for (const { name, key } of vars) {
    const v = key.split(".").reduce((acc, k) => (acc == null ? undefined : acc[k]), ctx);
    out[name] = v === undefined || v === null ? "" : helpers.textSanitize(v);
  }
  return out;
}

/** Every event that has an approved MSG91 template mapped. */
export const MSG91_MAPPED_EVENTS = Object.freeze(Object.keys(TEMPLATES));

/** Resolved status of every mapped template — used by validation and the CLI. */
export function msg91TemplateStatus() {
  return MSG91_MAPPED_EVENTS.map((event) => msg91TemplateFor(event));
}

export default TEMPLATES;
