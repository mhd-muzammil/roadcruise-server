import { Provider } from "../Provider.js";
import config from "../../config/notification.config.js";
import { dlt } from "../../config/dlt.js";

/**
 * Real SMS via AIRTEL IQ (Airtel's CPaaS) over the built-in global fetch — no
 * SDK, nothing to install. DORMANT unless NOTIF_SMS_PROVIDER=airtel. Config is
 * read lazily from config.airtelIq at send time (never at import), so the
 * module boots with zero Airtel credentials.
 *
 * DLT: Airtel IQ takes the FULLY-RENDERED body plus the approved 19-digit
 * Template ID and Entity ID, and matches the body against the registered
 * template operator-side. So unlike MSG91's flow API this provider sends text,
 * not ordered variables — but the text must still match the registered
 * template character-for-character once variables are substituted. Keep the
 * engine's SMS templates and the registered DLT text in lockstep via
 * `npm run dlt:templates`.
 *
 * A missing Template ID for an event is treated as a PERMANENT error rather
 * than sent anyway: an unregistered body is accepted with a 200 and then
 * dropped by the operator, so failing loudly to the dead-letter queue is the
 * only way the problem is ever noticed.
 *
 * RETRY POLICY: one attempt, classified — identical contract to the MSG91
 * provider. Transient (network, timeout, 408/429/5xx) => retryable; permanent
 * (bad config, unregistered template, invalid number, other 4xx) => not.
 *
 * SECURITY: credentials, phone numbers and message bodies are never logged nor
 * embedded in a thrown error.
 */

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function providerError(message, { statusCode = null, retryable } = {}) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.retryable = retryable;
  return err;
}

export class AirtelIqSmsProvider extends Provider {
  get name() {
    return "airtel-iq-sms";
  }

  /** Digits-only phone; prepend defaultCountryCode to bare 10-digit numbers. */
  _normalize(to) {
    const digits = String(to ?? "").replace(/\D/g, "");
    if (!digits) return "";
    if (digits.length === 10) return `${config.airtelIq.defaultCountryCode}${digits}`;
    return digits;
  }

  async send({ to, body, event }) {
    const { customerId, username, password, senderId, baseUrl, messageType, timeoutMs } =
      config.airtelIq;

    // Configuration errors are permanent -> fail fast to the DLQ.
    if (!customerId || !username || !password) {
      throw providerError(
        "AIRTEL_IQ_CUSTOMER_ID, AIRTEL_IQ_USERNAME and AIRTEL_IQ_PASSWORD are required for the airtel sms provider",
        { retryable: false }
      );
    }
    const sourceAddress = senderId || dlt.headerId;
    if (!sourceAddress) {
      throw providerError(
        "AIRTEL_IQ_SENDER_ID (or DLT_HEADER_ID) is required for the airtel sms provider",
        { retryable: false }
      );
    }

    // An unregistered event can never be delivered — never silently "succeed".
    const dltTemplateId = dlt.templateIdFor(event);
    if (!dltTemplateId) {
      throw providerError(
        `airtel sms: no DLT template id registered for event "${event}" — set ${
          event ? `DLT_TID_<EVENT> ` : ""
        }(see npm run dlt:templates)`,
        { retryable: false }
      );
    }

    const destination = this._normalize(to);
    if (!destination) {
      // Do NOT echo the raw recipient (PII) — matches the MSG91/SMTP providers.
      throw providerError("airtel sms: could not derive a valid phone number from the recipient", {
        retryable: false,
      });
    }

    const url = `${baseUrl}/gateway/airtel-xchange/v2/sms/send`;
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
    };
    const payload = {
      customerId,
      destinationAddress: [destination],
      message: body,
      sourceAddress,
      messageType,
      dltTemplateId,
    };
    if (dlt.entityId) payload.entityId = dlt.entityId;

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
      // Keep the timeout armed through body consumption; re-throw an abort as a
      // timeout and tolerate only a malformed/empty body as {}.
      data = await res.json().catch((e) => {
        if (e?.name === "AbortError" || controller.signal.aborted) throw e;
        return {};
      });
    } catch (err) {
      if (err?.name === "AbortError" || controller.signal.aborted) {
        throw providerError(`Airtel IQ send timed out after ${timeoutMs}ms`, { retryable: true });
      }
      throw providerError(`Airtel IQ send failed (network error): ${err?.message || err}`, {
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
    }

    // Airtel IQ acks with a messageRequestId per accepted message. Some error
    // shapes still arrive on a 2xx, so require positive evidence of acceptance.
    const ack = Array.isArray(data?.messageResponse) ? data.messageResponse[0] : null;
    const messageId = data?.messageRequestId || ack?.messageId || null;
    const ok = res.ok && !data?.errorCode && !!messageId;
    if (!ok) {
      throw providerError(
        `Airtel IQ send failed (${res.status}) [${data?.errorCode ?? ""}]: ${
          data?.errorMessage || data?.message || JSON.stringify(data)
        }`,
        { statusCode: res.status, retryable: RETRYABLE_STATUS.has(res.status) }
      );
    }

    return { providerMessageId: messageId, status: "sent", raw: data };
  }
}

export default AirtelIqSmsProvider;
