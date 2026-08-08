import { Provider } from "../Provider.js";
import config from "../../config/notification.config.js";
import { msg91TemplateFor, buildMsg91Variables } from "../../config/msg91Templates.js";

/**
 * Real SMS via MSG91 (India, DLT-compliant) using the v5 Flow API over the
 * built-in global fetch — no SDK, nothing to install. DORMANT unless
 * NOTIF_SMS_PROVIDER=msg91. Config is read lazily at send time (never at
 * import), so the module boots with zero MSG91 credentials.
 *
 * DLT MODEL: this provider does NOT transmit message text. Indian commercial
 * SMS must match content pre-registered on a DLT portal (RoadCruise registered
 * on Airtel's) and approved by every operator; a body that does not match is
 * accepted with a 200 and then dropped silently. So the approved content lives
 * in MSG91, and each send carries only:
 *
 *     the MSG91 template id for THIS event   (config/msg91Templates.js)
 *   + the values for that template's variables
 *
 * MSG91 renders the approved template. The rendered `body` the Dispatcher
 * passes in is deliberately IGNORED — sending it would be the exact
 * non-compliance this design exists to prevent.
 *
 * TEMPLATE IDS: the v5 Flow API takes MSG91's own 24-char hex id in the
 * `flow_id` field — NOT `template_id` (which MSG91 rejects as API-failed 400),
 * and NOT the 19-digit Airtel DLT id (config/dlt.js, used by the Airtel IQ
 * provider). All three are distinct; only `flow_id` belongs on this wire.
 *
 * FAIL-SAFE: an event with no approved template, an unconfigured template id,
 * or an empty variable map is a PERMANENT error — never a fallback send. This
 * is what keeps booking SMS off the wire until its MSG91 template exists, and
 * it never affects the booking itself: the Dispatcher isolates provider
 * failures into the dead-letter queue.
 *
 * OTP: the application generates the OTP and passes it through the event
 * payload. This provider never generates one, and deliberately does not use
 * MSG91's /api/v5/otp endpoint (which would mint a second, different code and
 * own its own expiry). OTP goes through the same Flow API as everything else.
 *
 * SEND STATUS: a 200 from MSG91 means ACCEPTED, not delivered. The Flow API
 * answers HTTP 200 {"type":"success"} even for a request it later rejects
 * asynchronously (its "API Failed Logs" / alert emails) — and it answers the
 * same way for a bogus auth key. So this provider reports status "submitted"
 * and the engine records DeliveryStatus.SUBMITTED; nothing here ever claims
 * SENT or DELIVERED. Confirming real delivery requires MSG91's delivery-report
 * webhook, which is not wired up yet.
 *
 * RETRY POLICY: this provider does ONE attempt and classifies the outcome; the
 * Dispatcher's retry engine owns backoff/dead-letter and honors the `retryable`
 * flag attached to thrown errors. Transient failures (network, timeout, and
 * HTTP 408/429/500/502/503/504) are retryable; permanent ones (bad config,
 * invalid number, 400/401/403/404 and MSG91 logical errors) are NOT — retrying
 * them can never succeed, so they fail fast to the dead-letter queue.
 *
 * SECURITY: the auth key, the phone number and the variable VALUES (an OTP is
 * one of them) are never logged nor embedded in any thrown error.
 */

// HTTP statuses worth retrying (transient). Everything else is terminal.
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/** Build a classified provider error the Dispatcher can act on. */
function providerError(message, { statusCode = null, retryable } = {}) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.retryable = retryable;
  return err;
}

/** Last 4 digits only — enough to correlate a delivery, useless as PII. */
function maskPhone(digits) {
  const s = String(digits || "");
  return s.length <= 4 ? "****" : `${"*".repeat(s.length - 4)}${s.slice(-4)}`;
}

export class Msg91SmsProvider extends Provider {
  get name() {
    return "msg91-sms";
  }

  /** Digits-only phone; prepend defaultCountryCode to bare 10-digit numbers. */
  _normalize(to) {
    const digits = String(to ?? "").replace(/\D/g, "");
    if (!digits) return "";
    // Bare Indian mobile => prepend country code; already-prefixed/longer left as-is.
    if (digits.length === 10) return `${config.msg91.defaultCountryCode}${digits}`;
    return digits;
  }

  /**
   * The ONE place that talks HTTP to MSG91. Every event goes through it, so
   * timeout, abort handling, response classification and secret hygiene are
   * defined once.
   */
  async _post(path, payload) {
    const { authKey, baseUrl, timeoutMs } = config.msg91;

    // ONE attempt with a hard timeout. Retry/backoff/dead-letter is owned by the
    // Dispatcher, which reads the `retryable` flag we set below.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res, data;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          authkey: authKey,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      // Keep the timeout armed through body consumption — a stalled body must
      // not hang the worker beyond timeoutMs. Re-throw an abort as a timeout;
      // tolerate only a malformed/empty body as {}.
      data = await res.json().catch((e) => {
        if (e?.name === "AbortError" || controller.signal.aborted) throw e;
        return {};
      });
    } catch (err) {
      // Network error / timeout -> transient, retryable.
      if (err?.name === "AbortError" || controller.signal.aborted) {
        throw providerError(`MSG91 send timed out after ${timeoutMs}ms`, { retryable: true });
      }
      throw providerError(`MSG91 send failed (network error): ${err?.message || err}`, {
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
    }

    // MSG91 returns HTTP 200 even on some logical errors. Success looks like
    // { type: "success", message: "<request id>" }. Anything else is a failure;
    // whether it's worth retrying depends purely on the HTTP status.
    const ok = res.ok && data.type !== "error" && (data.request_id || data.type === "success");
    if (!ok) {
      throw providerError(
        `MSG91 send failed (${res.status}) [${data.code ?? ""}]: ${
          data.message || JSON.stringify(data)
        }`,
        { statusCode: res.status, retryable: RETRYABLE_STATUS.has(res.status) }
      );
    }
    return { res, data };
  }

  /**
   * The request id MSG91 issues for an accepted submission.
   *
   * On the v5 Flow API this arrives in `message`, NOT `request_id` — `message`
   * doubles as the error text on failures, so it is only read once the response
   * has been classified as a success. Getting this right matters: the id is the
   * only handle for looking the message up in MSG91's delivery reports later.
   */
  _messageId(data) {
    return data.request_id || (data.type === "success" ? data.message : null) || null;
  }

  /**
   * Deliver one notification.
   *
   * @param {object}  msg
   * @param {string}  msg.to             recipient phone
   * @param {string}  msg.event          NotificationEvents value — selects the template
   * @param {object}  msg.context        rendered template context (variable values)
   * @param {string} [msg.correlationId] for log correlation
   * @param {string} [msg.body]          rendered text — IGNORED for DLT compliance
   */
  async send({ to, event, context, correlationId }) {
    const { authKey, senderId } = config.msg91;

    // ---- configuration: permanent failures, fail fast to the DLQ ----
    if (!authKey) {
      throw providerError("MSG91_API_KEY is required when NOTIF_SMS_PROVIDER=msg91", {
        retryable: false,
      });
    }

    const template = msg91TemplateFor(event);
    if (!template) {
      throw providerError(
        `msg91 sms: no DLT-approved MSG91 template is mapped for event "${event}" — ` +
          "register the content on the Airtel DLT portal, create it in MSG91, then add it to " +
          "config/msg91Templates.js. Refusing to send unapproved content.",
        { retryable: false }
      );
    }
    if (!template.configured) {
      throw providerError(
        `msg91 sms: ${template.idEnv} is not configured, so the "${template.msg91Name}" ` +
          `template (DLT ${template.dltTemplateId}) cannot be used for "${event}". ` +
          "Set it to the MSG91 template id once MSG91 shows the template as Verified by DLT. " +
          "Refusing to substitute another template or send unapproved content.",
        { retryable: false }
      );
    }
    // A template whose variable mapping is known to be WRONG must not send.
    // Delivering a malformed OTP is worse than delivering none: the customer
    // cannot complete verification either way, but a malformed one also burns
    // an SMS, looks legitimate, and trains people to accept broken messages.
    if (template.blocked) {
      throw providerError(
        `msg91 sms: the "${template.msg91Name}" template mapping is UNRESOLVED, so "${event}" ` +
          `is blocked from sending — ${template.blockedReason}`,
        { retryable: false }
      );
    }
    if (!template.vars.length) {
      throw providerError(
        `msg91 sms: no variable mapping for "${event}" — set ${template.varsEnv} to the ` +
          "##variable## names configured in the MSG91 template.",
        { retryable: false }
      );
    }

    const mobiles = this._normalize(to);
    if (!mobiles) {
      // Do NOT echo the raw recipient (PII) — match the SMTP/Meta providers.
      throw providerError("msg91 sms: could not derive a valid phone number from the recipient", {
        retryable: false,
      });
    }

    // ---- payload: flow id + variable VALUES only, never message text ----
    // The v5 Flow API identifies the approved template with `flow_id`. An
    // earlier revision sent `template_id`, which MSG91 rejected asynchronously
    // as API-failed code 400 ("Template ID ... missing, incorrect, or
    // archived") while still answering HTTP 200 — see the send-status note
    // below for why that failure was invisible.
    const payload = {
      flow_id: template.templateId,
      recipients: [{ mobiles, ...buildMsg91Variables(template.vars, context) }],
    };
    if (senderId) payload.sender = senderId; // approved DLT header (e.g. KVROCR)

    // Safe by construction: event, masked recipient, template id and variable
    // NAMES only — never the auth key, the full number, or a value (the OTP is
    // a value).
    const logCtx =
      `event=${event} template=${template.msg91Name}:${template.templateId} ` +
      `to=${maskPhone(mobiles)} vars=${template.vars.map((v) => v.name).join("|")}` +
      (correlationId ? ` correlationId=${correlationId}` : "");

    try {
      const { res, data } = await this._post("/api/v5/flow/", payload);
      const messageId = this._messageId(data);
      console.log(
        `[notifications][msg91-sms] submitted ${logCtx} status=${res.status} requestId=${messageId || "-"}`
      );
      // "submitted", NOT "sent". A 200 from MSG91 means the request was ACCEPTED
      // by the API — it can still be rejected asynchronously (API-failed logs /
      // alert email) and never reach the operator. Claiming SENT here would
      // record a delivery we have no evidence of. Real delivery confirmation
      // needs MSG91's delivery-report webhook, which is not wired up yet.
      return {
        providerMessageId: messageId,
        status: "submitted",
        deliveryConfirmed: false,
        raw: data,
      };
    } catch (err) {
      console.error(
        `[notifications][msg91-sms] failed ${logCtx} retryable=${err.retryable !== false} ` +
          `httpStatus=${err.statusCode ?? "-"} reason=${err.message}`
      );
      throw err;
    }
  }
}

export default Msg91SmsProvider;
