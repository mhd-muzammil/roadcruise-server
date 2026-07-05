import { Provider } from "../Provider.js";
import config from "../../config/notification.config.js";

/**
 * Real SMS via MSG91 (India, DLT-compliant) using the v5 Flow API over the
 * built-in global fetch — no SDK, nothing to install. DORMANT unless
 * NOTIF_SMS_PROVIDER=msg91. Config is read lazily from config.msg91 at send
 * time (never at import), so the module boots with zero MSG91 creds.
 *
 * DLT-template mapping: MSG91 DLT templates require pre-approved variable
 * content, so this engine passes the fully-rendered message as a single body
 * variable. The variable key is config.msg91.bodyVar (default "body"). OTP,
 * transactional, booking and payment SMS all flow through this one path — the
 * engine renders the right body per event and this provider stays
 * content-agnostic.
 *
 * RETRY POLICY: this provider does ONE attempt and classifies the outcome; the
 * Dispatcher's retry engine owns backoff/dead-letter and honors the `retryable`
 * flag attached to thrown errors. Transient failures (network, timeout, and
 * HTTP 408/429/500/502/503/504) are retryable; permanent ones (bad config,
 * invalid number, 400/401/403/404 and MSG91 logical errors) are NOT — retrying
 * them can never succeed, so they fail fast to the dead-letter queue.
 *
 * SECURITY: the auth key, phone number, and message body are never logged or
 * embedded in any thrown error message.
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

  // OTP / transactional / booking / payment SMS are all handled here uniformly:
  // the engine renders the body, this provider just delivers it via the template.
  async send({ to, body }) {
    const { authKey, senderId, templateId, baseUrl, bodyVar, timeoutMs } = config.msg91;

    // Configuration errors are permanent -> non-retryable (fail fast to DLQ).
    if (!authKey || !templateId) {
      throw providerError(
        "MSG91_API_KEY and MSG91_TEMPLATE_ID are required for the msg91 sms provider",
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

    const url = `${baseUrl}/api/v5/flow/`;
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
      authkey: authKey,
    };
    const payload = {
      template_id: templateId,
      recipients: [{ mobiles, [bodyVar]: body }],
    };
    if (senderId) payload.sender = senderId; // optional if the template defines a sender

    // ONE attempt with a hard timeout. Retry/backoff/dead-letter is owned by the
    // Dispatcher, which reads the `retryable` flag we set below.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res, data;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
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
    // { type: "success", request_id, ... }. Anything else is a failure; whether
    // it's worth retrying depends purely on the HTTP status.
    const ok = res.ok && data.type !== "error" && (data.request_id || data.type === "success");
    if (!ok) {
      throw providerError(
        `MSG91 send failed (${res.status}) [${data.code ?? ""}]: ${
          data.message || JSON.stringify(data)
        }`,
        { statusCode: res.status, retryable: RETRYABLE_STATUS.has(res.status) }
      );
    }

    return { providerMessageId: data.request_id || data.type || null, status: "sent", raw: data };
  }
}

export default Msg91SmsProvider;
